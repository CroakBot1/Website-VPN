import { initTelegramAutoDeleteLite } from "./telegramAutoDelete.js";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

// ================= CONFIG =================
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const MAX_LOSS = Number(process.env.MAX_LOSS ?? -40);
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT ?? 45);

const FAST_INTERVAL = 2000;
const SLOW_INTERVAL = 10000;
let currentInterval = SLOW_INTERVAL;

const RECV_WINDOW = "5000";
const POSITION_CACHE_TTL = 3000;
const CLOSE_VERIFY_RETRIES = 10;
const CLOSE_VERIFY_DELAY = 1000;

/**
 * TRADE_MODE:
 * - mainnet = actual live account
 * - demo    = bybit demo trading
 * - testnet = bybit testnet
 */
const TRADE_MODE = String(process.env.TRADE_MODE || "mainnet").toLowerCase();

const FORCE_REST_CLOSE_ON_DEMO =
  String(process.env.FORCE_REST_CLOSE_ON_DEMO ?? "true").toLowerCase() === "true";

// ================= TELEGRAM CONFIG =================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_LOGS_ENABLED =
  String(process.env.TELEGRAM_LOGS_ENABLED ?? "true").toLowerCase() === "true";
const TELEGRAM_HEARTBEAT_MINUTES = Number(process.env.TELEGRAM_HEARTBEAT_MINUTES ?? 10);
const TELEGRAM_SILENT =
  String(process.env.TELEGRAM_SILENT ?? "false").toLowerCase() === "true";

let telegramHeartbeat = null;
let lastTelegramMessageAt = 0;
const TELEGRAM_MIN_GAP_MS = 1200;
const telegramQueue = [];
let telegramSending = false;

// ================= ENV URLS =================
const HTTP_BASE_URL =
  TRADE_MODE === "testnet"
    ? "https://api-testnet.bybit.com"
    : TRADE_MODE === "demo"
    ? "https://api-demo.bybit.com"
    : "https://api.bybit.com";

const PRIVATE_WS_URL =
  TRADE_MODE === "testnet"
    ? "wss://stream-testnet.bybit.com/v5/private"
    : TRADE_MODE === "demo"
    ? "wss://stream-demo.bybit.com/v5/private"
    : "wss://stream.bybit.com/v5/private";

const TRADE_WS_URL =
  TRADE_MODE === "testnet"
    ? "wss://stream-testnet.bybit.com/v5/trade"
    : "wss://stream.bybit.com/v5/trade";
// NOTE:
// Demo trade websocket is intentionally NOT used because it returns 404 in practice.
// So for demo, we disable trade WS and use REST fallback for closePosition().

// ================= VALIDATION =================
if (!API_KEY || !API_SECRET) {
  throw new Error("Missing API_KEY or API_SECRET in .env");
}

if (!["mainnet", "demo", "testnet"].includes(TRADE_MODE)) {
  throw new Error("TRADE_MODE must be one of: mainnet, demo, testnet");
}

// ================= STATE =================
let running = true;
let isExecuting = false;
let isClosing = false;

let privateWs = null;
let tradeWs = null;

let privateReady = false;
let tradeReady = false;

let privateHeartbeat = null;
let tradeHeartbeat = null;

let latestPosition = null;
let latestPositionUpdatedAt = 0;

const pendingTradeRequests = [];

// ================= LOGGING HELPERS =================
const rawConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
};

function formatLogArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function chunkText(text, max = 3900) {
  const chunks = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTelegram(message, options = {}) {
  if (!TELEGRAM_LOGS_ENABLED) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  telegramQueue.push({
    message,
    disableNotification: options.disableNotification ?? TELEGRAM_SILENT,
  });

  if (telegramSending) return;

  telegramSending = true;

  try {
    while (telegramQueue.length > 0) {
      const item = telegramQueue.shift();
      const chunks = chunkText(item.message);

      for (const part of chunks) {
        const gap = Date.now() - lastTelegramMessageAt;
        if (gap < TELEGRAM_MIN_GAP_MS) {
          await sleep(TELEGRAM_MIN_GAP_MS - gap);
        }

        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            chat_id: TELEGRAM_CHAT_ID,
            text: part,
            disable_notification: item.disableNotification,
          },
          {
            timeout: 15000,
          }
        );

        lastTelegramMessageAt = Date.now();
      }
    }
  } catch (err) {
    rawConsole.error("TELEGRAM ERROR:", err.response?.data || err.message);
  } finally {
    telegramSending = false;
  }
}

function installTelegramConsoleMirror() {
  console.log = (...args) => {
    rawConsole.log(...args);
    const text = formatLogArgs(args);
    sendTelegram(`ℹ️ ${text}`).catch(() => {});
  };

  console.info = (...args) => {
    rawConsole.info(...args);
    const text = formatLogArgs(args);
    sendTelegram(`ℹ️ ${text}`).catch(() => {});
  };

  console.warn = (...args) => {
    rawConsole.warn(...args);
    const text = formatLogArgs(args);
    sendTelegram(`⚠️ ${text}`).catch(() => {});
  };

  console.error = (...args) => {
    rawConsole.error(...args);
    const text = formatLogArgs(args);
    sendTelegram(`❌ ${text}`).catch(() => {});
  };
}

function startTelegramHeartbeat() {
  if (!TELEGRAM_LOGS_ENABLED) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (telegramHeartbeat) clearInterval(telegramHeartbeat);

  const intervalMs = Math.max(1, TELEGRAM_HEARTBEAT_MINUTES) * 60 * 1000;

  telegramHeartbeat = setInterval(() => {
    sendTelegram(
      [
        "💓 BOT HEARTBEAT",
        `SYMBOL: ${SYMBOL}`,
        `MODE: ${TRADE_MODE}`,
        `privateReady: ${privateReady}`,
        `tradeReady: ${tradeReady}`,
        `uptimeSec: ${Math.floor(process.uptime())}`,
        `latestPositionUpdatedAt: ${latestPositionUpdatedAt || 0}`,
      ].join("\n"),
      { disableNotification: true }
    ).catch(() => {});
  }, intervalMs);
}

// ================= HELPERS =================
function hmacSha256(text) {
  return crypto.createHmac("sha256", API_SECRET).update(text).digest("hex");
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function startHeartbeat(ws, label) {
  return setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: "ping" }));
      // console.log(`💓 ${label} ping`);
    }
  }, 20_000);
}

function generateWsAuth() {
  const expires = Date.now() + 10_000;
  const signature = hmacSha256(`GET/realtime${expires}`);
  return { expires, signature };
}

function signRestGet(params) {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return hmacSha256(query);
}

/**
 * Bybit V5 POST signing
 * sign = HMAC_SHA256(timestamp + api_key + recv_window + jsonBodyString)
 */
function signRestPost(timestamp, bodyString) {
  return hmacSha256(`${timestamp}${API_KEY}${RECV_WINDOW}${bodyString}`);
}

function getActiveSymbolPosition(list) {
  if (!Array.isArray(list)) return null;
  return list.find((p) => p.symbol === SYMBOL) || null;
}

function flushPendingTradeRequests() {
  while (pendingTradeRequests.length && tradeReady && tradeWs?.readyState === WebSocket.OPEN) {
    tradeWs.send(JSON.stringify(pendingTradeRequests.shift()));
  }
}

// ================= REST FALLBACKS =================
async function getPositionViaRest() {
  try {
    const timestamp = Date.now().toString();

    const params = {
      api_key: API_KEY,
      timestamp,
      recv_window: RECV_WINDOW,
      category: "linear",
      symbol: SYMBOL,
    };

    const sign = signRestGet(params);

    const res = await axios.get(`${HTTP_BASE_URL}/v5/position/list`, {
      params: { ...params, sign },
    });

    const list = res?.data?.result?.list;
    if (!list || list.length === 0) return null;

    return list[0];
  } catch (err) {
    console.error("GET POSITION REST ERROR:", err.response?.data || err.message);
    return null;
  }
}

async function closePositionViaRest(side, size) {
  try {
    const timestamp = Date.now().toString();

    const body = {
      category: "linear",
      symbol: SYMBOL,
      side: side === "Buy" ? "Sell" : "Buy",
      orderType: "Market",
      qty: String(size),
      timeInForce: "IOC",
      reduceOnly: true,
    };

    const bodyString = JSON.stringify(body);
    const sign = signRestPost(timestamp, bodyString);

    const res = await axios.post(`${HTTP_BASE_URL}/v5/order/create`, body, {
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": sign,
      },
    });

    if (res?.data?.retCode !== 0) {
      throw new Error(`REST close failed: ${res?.data?.retMsg || "unknown error"}`);
    }

    console.log("✅ POSITION CLOSE SENT VIA REST:", res.data);
  } catch (err) {
    console.error("CLOSE POSITION REST ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ================= POSITION CACHE =================
function setLatestPosition(pos) {
  latestPosition = pos || null;
  latestPositionUpdatedAt = Date.now();
}

function clearLatestPosition() {
  latestPosition = null;
  latestPositionUpdatedAt = 0;
}

// ================= GET POSITION =================
async function getPosition() {
  const isFresh =
    latestPosition && Date.now() - latestPositionUpdatedAt < POSITION_CACHE_TTL;

  // primary = websocket cache, but only if fresh
  if (isFresh) return latestPosition;

  // fallback = REST refresh
  const restPos = await getPositionViaRest();

  if (!restPos || Number(restPos.size) <= 0 || !restPos.side) {
    clearLatestPosition();
    return null;
  }

  setLatestPosition(restPos);
  return restPos;
}

// ================= CLOSE VERIFICATION =================
async function verifyPositionClosed(retries = CLOSE_VERIFY_RETRIES) {
  for (let i = 0; i < retries; i++) {
    await sleep(CLOSE_VERIFY_DELAY);

    const pos = await getPositionViaRest();

    if (!pos || Number(pos.size) <= 0 || !pos.side) {
      clearLatestPosition();
      currentInterval = SLOW_INTERVAL;
      console.log("✅ Position confirmed closed");
      return true;
    }

    setLatestPosition(pos);
    console.log(
      `⏳ Close verification attempt ${i + 1}/${retries}: position still open | size=${pos.size} | pnl=${Number(
        pos.unrealisedPnl || 0
      )}`
    );
  }

  console.error("❌ Close sent but position still open after verification");
  return false;
}

// ================= CLOSE POSITION =================
async function closePosition(side, size) {
  if (isClosing) {
    console.log("⏳ Close already in progress, skipping duplicate request...");
    return;
  }

  isClosing = true;

  try {
    // prevent stale cache from being trusted during close flow
    clearLatestPosition();

    // DEMO MODE: always use REST close by default
    if (TRADE_MODE === "demo" && FORCE_REST_CLOSE_ON_DEMO) {
      console.log("🧪 DEMO MODE: using REST fallback close...");
      await closePositionViaRest(side, size);
      await verifyPositionClosed();
      return;
    }

    const payload = {
      reqId: `close-${SYMBOL}-${Date.now()}`,
      header: {
        "X-BAPI-TIMESTAMP": String(Date.now()),
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      },
      op: "order.create",
      args: [
        {
          category: "linear",
          symbol: SYMBOL,
          side: side === "Buy" ? "Sell" : "Buy",
          orderType: "Market",
          qty: String(size),
          timeInForce: "IOC",
          reduceOnly: true,
        },
      ],
    };

    if (tradeReady && tradeWs?.readyState === WebSocket.OPEN) {
      tradeWs.send(JSON.stringify(payload));
      console.log("✅ CLOSE REQUEST SENT VIA WS");
      await verifyPositionClosed();
    } else {
      console.log("⚠️ TRADE WS not ready, fallback to REST close...");
      await closePositionViaRest(side, size);
      await verifyPositionClosed();
    }
  } catch (err) {
    console.error("CLOSE POSITION ERROR:", err.message);
    throw err;
  } finally {
    setTimeout(() => {
      isClosing = false;
    }, 3000);
  }
}

// ================= MONITOR (LOGIC PRESERVED) =================
async function monitor() {
  const pos = await getPosition();

  if (!pos || Number(pos.size) <= 0 || !pos.side) {
    console.log("📭 No open position");
    currentInterval = SLOW_INTERVAL;
    return;
  }

  currentInterval = FAST_INTERVAL;

  const pnl = Number(pos.unrealisedPnl || 0);
  const size = pos.size;
  const side = pos.side;

  console.log(`📊 ${SYMBOL} PnL (USDT): ${pnl}`);

  if (pnl <= MAX_LOSS) {
    console.log(`🚨 MAX LOSS HIT (${MAX_LOSS}). Closing position...`);
    await closePosition(side, size);
    return;
  }

  if (pnl >= TAKE_PROFIT) {
    console.log(`🎯 TAKE PROFIT HIT (${TAKE_PROFIT}). Closing position...`);
    await closePosition(side, size);
    return;
  }
}

// ================= EXECUTION GUARD =================
async function runMonitorSafely(source = "unknown") {
  if (isExecuting) return;

  try {
    isExecuting = true;
    await monitor();
  } catch (err) {
    console.error(`⚠️ MONITOR ERROR [${source}]:`, err.message);
  } finally {
    isExecuting = false;
  }
}

// ================= PRIVATE WS =================
function connectPrivateWS() {
  let retry = 0;

  const openConnection = () => {
    console.log(`🔌 Connecting PRIVATE WS (${TRADE_MODE})...`);
    privateWs = new WebSocket(PRIVATE_WS_URL);

    privateWs.on("open", () => {
      console.log("✅ PRIVATE WS CONNECTED");
      retry = 0;

      const { expires, signature } = generateWsAuth();

      privateWs.send(
        JSON.stringify({
          op: "auth",
          args: [API_KEY, expires, signature],
        })
      );
    });

    privateWs.on("message", async (raw) => {
      const msg = safeJsonParse(raw);
      if (!msg) return;

      if (msg.op === "auth" && (msg.success === true || msg.retCode === 0)) {
        console.log("🔐 PRIVATE WS AUTH OK");

        privateWs.send(
          JSON.stringify({
            op: "subscribe",
            args: ["position", "order"],
          })
        );

        privateReady = true;

        if (privateHeartbeat) clearInterval(privateHeartbeat);
        privateHeartbeat = startHeartbeat(privateWs, "PRIVATE");
        return;
      }

      if (msg.op === "pong") return;

      if (
        msg.op === "subscribe" &&
        (msg.success === true || msg.retCode === 0 || msg.ret_msg === "subscribe")
      ) {
        console.log("📡 PRIVATE WS SUBSCRIBED");
        return;
      }

      if (msg.topic === "position" && Array.isArray(msg.data)) {
        const pos = getActiveSymbolPosition(msg.data);

        if (!pos || Number(pos.size) <= 0 || !pos.side) {
          clearLatestPosition();
        } else {
          setLatestPosition(pos);
        }

        await runMonitorSafely("position-stream");
        return;
      }

      if (msg.topic === "order" && Array.isArray(msg.data)) {
        for (const order of msg.data) {
          if (order.symbol !== SYMBOL) continue;

          console.log(
            `🧾 ORDER UPDATE: ${order.orderStatus || "UNKNOWN"} | ${order.side} | qty=${order.qty}`
          );
        }

        return;
      }
    });

    privateWs.on("close", async () => {
      privateReady = false;

      if (privateHeartbeat) {
        clearInterval(privateHeartbeat);
        privateHeartbeat = null;
      }

      const wait = Math.min(30000, 2000 * Math.pow(2, retry));
      console.log(`⚠️ PRIVATE WS CLOSED → reconnect in ${wait}ms`);

      await sleep(wait);
      retry++;
      openConnection();
    });

    privateWs.on("error", (err) => {
      console.error("PRIVATE WS ERROR:", err.message);
    });
  };

  openConnection();
}

// ================= TRADE WS =================
function connectTradeWS() {
  let retry = 0;

  const openConnection = () => {
    console.log(`🔌 Connecting TRADE WS (${TRADE_MODE})...`);
    tradeWs = new WebSocket(TRADE_WS_URL);

    tradeWs.on("open", () => {
      console.log("✅ TRADE WS CONNECTED");
      retry = 0;

      const { expires, signature } = generateWsAuth();

      tradeWs.send(
        JSON.stringify({
          op: "auth",
          args: [API_KEY, expires, signature],
        })
      );
    });

    tradeWs.on("message", (raw) => {
      const msg = safeJsonParse(raw);
      if (!msg) return;

      if (msg.op === "auth" && (msg.success === true || msg.retCode === 0)) {
        console.log("🔐 TRADE WS AUTH OK");
        tradeReady = true;

        if (tradeHeartbeat) clearInterval(tradeHeartbeat);
        tradeHeartbeat = startHeartbeat(tradeWs, "TRADE");

        flushPendingTradeRequests();
        return;
      }

      if (msg.op === "pong") return;

      if (msg.op === "order.create") {
        if (msg.retCode === 0) {
          console.log("✅ POSITION CLOSE ACK:", msg.data);
        } else {
          console.error("❌ POSITION CLOSE REJECTED:", msg);
        }
      }
    });

    tradeWs.on("close", async () => {
      tradeReady = false;

      if (tradeHeartbeat) {
        clearInterval(tradeHeartbeat);
        tradeHeartbeat = null;
      }

      const wait = Math.min(30000, 2000 * Math.pow(2, retry));
      console.log(`⚠️ TRADE WS CLOSED → reconnect in ${wait}ms`);

      await sleep(wait);
      retry++;
      openConnection();
    });

    tradeWs.on("error", (err) => {
      console.error("TRADE WS ERROR:", err.message);
    });
  };

  openConnection();
}

// ================= WATCHDOG =================
async function startWatchdog() {
  while (running) {
    try {
      const now = Date.now();
      const staleMs = now - latestPositionUpdatedAt;

      if (staleMs > currentInterval) {
        await runMonitorSafely("watchdog");
      }

      await sleep(currentInterval);
    } catch (err) {
      console.error("WATCHDOG ERROR:", err.message);
      await sleep(2000);
    }
  }
}

// ================= GLOBAL CRASH PROTECTION =================
process.on("unhandledRejection", async (err) => {
  console.error("🔥 UNHANDLED REJECTION:", err?.message || err);
  await sendTelegram(`🔥 UNHANDLED REJECTION\n${err?.message || String(err)}`);
});

process.on("uncaughtException", async (err) => {
  console.error("🔥 UNCAUGHT EXCEPTION:", err?.message || err);
  await sendTelegram(`🔥 UNCAUGHT EXCEPTION\n${err?.message || String(err)}`);
});

process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received");
  running = false;
  await sendTelegram("🛑 Render sent SIGTERM. Bot stopping.");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("🛑 SIGINT received");
  running = false;
  await sendTelegram("🛑 Process interrupted. Bot stopping.");
  process.exit(0);
});

// ================= START =================
async function startBot() {
  installTelegramConsoleMirror();

  console.log("🤖 BOT STARTED...");
  console.log(`📌 SYMBOL: ${SYMBOL}`);
  console.log(`🌐 TRADE_MODE: ${TRADE_MODE}`);
  console.log(`🌍 HTTP: ${HTTP_BASE_URL}`);
  console.log(`🔌 PRIVATE WS: ${PRIVATE_WS_URL}`);

  await sendTelegram(
    [
      "✅ BOT STARTED ON RENDER",
      `SYMBOL: ${SYMBOL}`,
      `MODE: ${TRADE_MODE}`,
      `HTTP: ${HTTP_BASE_URL}`,
      `PRIVATE_WS: ${PRIVATE_WS_URL}`,
      `TELEGRAM_LOGS_ENABLED: ${TELEGRAM_LOGS_ENABLED}`,
    ].join("\n")
  );

  startTelegramHeartbeat();
  connectPrivateWS();

  if (TRADE_MODE !== "demo") {
    console.log(`🔌 TRADE WS: ${TRADE_WS_URL}`);
    connectTradeWS();
  } else {
    console.log("🧪 DEMO MODE: TRADE WS disabled, REST fallback enabled.");
  }

  startWatchdog();
}

startBot();


import { initTelegramAutoDeleteLite } from "./telegramAutoDelete.js";

initTelegramAutoDeleteLite({
  botToken: TELEGRAM_BOT_TOKEN,
  chatId: TELEGRAM_CHAT_ID,
  intervalMs: 10000,
});
