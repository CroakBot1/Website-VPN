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

/**
 * ENVIRONMENT MODES:
 * - mainnet  = actual live account
 * - demo     = Bybit demo trading
 * - testnet  = Bybit testnet
 */
const TRADE_MODE = String(process.env.TRADE_MODE || "mainnet").toLowerCase();

/**
 * IMPORTANT:
 * - Mainnet actual account -> official mainnet ws/http
 * - Testnet -> official testnet ws/http
 * - Demo trading -> uses api-demo.bybit.com for REST demo service
 *
 * For demo websocket trade/order-entry:
 * current public info is not as clear/reliable as mainnet/testnet,
 * so this bot auto-fallbacks to REST close for demo mode.
 */
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
    : TRADE_MODE === "demo"
    ? "wss://stream-demo.bybit.com/v5/trade"
    : "wss://stream.bybit.com/v5/trade";

// demo mode safety: use REST fallback for order close if trade ws is unavailable
const FORCE_REST_CLOSE_ON_DEMO =
  String(process.env.FORCE_REST_CLOSE_ON_DEMO ?? "true").toLowerCase() === "true";

if (!API_KEY || !API_SECRET) {
  throw new Error("Missing API_KEY or API_SECRET in .env");
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

// ================= HELPERS =================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function startHeartbeat(ws) {
  return setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: "ping" }));
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
 * Bybit V5 POST signature:
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

    console.log("✅ POSITION CLOSE SENT VIA REST:", res.data);
  } catch (err) {
    console.error("CLOSE POSITION REST ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ================= GET POSITION =================
async function getPosition() {
  // primary source = websocket cache
  if (latestPosition) return latestPosition;

  // fallback = REST
  return await getPositionViaRest();
}

// ================= CLOSE POSITION =================
async function closePosition(side, size) {
  if (isClosing) {
    console.log("⏳ Close already in progress, skipping duplicate request...");
    return;
  }

  isClosing = true;

  try {
    // DEMO: safest behavior is REST fallback by default
    if (TRADE_MODE === "demo" && FORCE_REST_CLOSE_ON_DEMO) {
      console.log("🧪 DEMO MODE: using REST fallback close...");
      await closePositionViaRest(side, size);
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
    } else {
      if (TRADE_MODE === "demo") {
        console.log("⚠️ Demo trade WS not ready, using REST fallback...");
        await closePositionViaRest(side, size);
      } else {
        console.log("📥 Trade WS not ready yet, queueing close request...");
        pendingTradeRequests.push(payload);
      }
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
        privateHeartbeat = startHeartbeat(privateWs);
        return;
      }

      if (msg.op === "pong") return;

      if (msg.op === "subscribe" && (msg.success === true || msg.ret_msg === "subscribe")) {
        console.log("📡 PRIVATE WS SUBSCRIBED");
        return;
      }

      if (msg.topic === "position" && Array.isArray(msg.data)) {
        const pos = getActiveSymbolPosition(msg.data);

        if (pos) {
          latestPosition = pos;
          latestPositionUpdatedAt = Date.now();
          await runMonitorSafely("position-stream");
        }
        return;
      }

      if (msg.topic === "order" && Array.isArray(msg.data)) {
        for (const order of msg.data) {
          if (order.symbol !== SYMBOL) continue;
          console.log(
            `🧾 ORDER UPDATE: ${order.orderStatus || "UNKNOWN"} | ${order.side} | qty=${order.qty}`
          );
        }
      }
    });

    privateWs.on("close", async () => {
      privateReady = false;
      if (privateHeartbeat) clearInterval(privateHeartbeat);

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
  // in demo mode, allowed but optional. if it fails, REST fallback handles close.
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

      if (msg.op === "auth" && msg.retCode === 0) {
        console.log("🔐 TRADE WS AUTH OK");
        tradeReady = true;

        if (tradeHeartbeat) clearInterval(tradeHeartbeat);
        tradeHeartbeat = startHeartbeat(tradeWs);

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
      if (tradeHeartbeat) clearInterval(tradeHeartbeat);

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

// ================= CRASH PROTECTION =================
process.on("unhandledRejection", (err) => {
  console.error("🔥 UNHANDLED REJECTION:", err?.message || err);
});

process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT EXCEPTION:", err?.message || err);
});

// ================= START =================
async function startBot() {
  console.log("🤖 FULLY WEBSOCKET BOT STARTED...");
  console.log(`📌 SYMBOL: ${SYMBOL}`);
  console.log(`🌐 TRADE_MODE: ${TRADE_MODE}`);
  console.log(`🌍 HTTP: ${HTTP_BASE_URL}`);
  console.log(`🔌 PRIVATE WS: ${PRIVATE_WS_URL}`);
  console.log(`🔌 TRADE WS: ${TRADE_WS_URL}`);

  connectPrivateWS();
  connectTradeWS();
  startWatchdog();
}

startBot();
