import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

// ================= CONFIG =================
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const MAX_LOSS = Number(process.env.MAX_LOSS ?? -70);
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT ?? 90);

const FAST_INTERVAL = 2000;
const SLOW_INTERVAL = 10000;
let currentInterval = SLOW_INTERVAL;

const RECV_WINDOW = "5000";
const POSITION_CACHE_TTL = 3000;
const CLOSE_VERIFY_RETRIES = 10;
const CLOSE_VERIFY_DELAY = 1000;

// ================= TRANSFER CONFIG =================
const TRANSFER_AMOUNT = Number(process.env.TRANSFER_AMOUNT ?? 100); // Default 100 USDT
const TRANSFER_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes in milliseconds

// ================= NEW RESERVE CONFIG =================
const UTA_RESERVE_BALANCE = Number(process.env.UTA_RESERVE_BALANCE ?? 501);
const RESERVE_CHECK_INTERVAL_MS = Number(
  process.env.RESERVE_CHECK_INTERVAL_MS ?? 60 * 1000
);
const RESERVE_TRANSFER_MIN_AMOUNT = Number(
  process.env.RESERVE_TRANSFER_MIN_AMOUNT ?? 0.01
);

// ================= NEW FAST RESERVE WS CONFIG =================
const RESERVE_FAST_TRANSFER_DELAY_MS = Number(
  process.env.RESERVE_FAST_TRANSFER_DELAY_MS ?? 1000
);

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
const TELEGRAM_MIN_GAP_MS = 10000;
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
let isReserveMaintaining = false;

let privateWs = null;
let tradeWs = null;

let privateReady = false;
let tradeReady = false;

let privateHeartbeat = null;
let tradeHeartbeat = null;

let latestPosition = null;
let latestPositionUpdatedAt = 0;

// ================= NEW FAST RESERVE STATE =================
let latestUtaUsdtWalletBalance = null;
let latestUtaUsdtWalletBalanceUpdatedAt = 0;
let reserveFastTransferTimer = null;

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

function roundDown(value, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.floor(Number(value) * factor) / factor;
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
    sendTelegram(`â„¹ï¸ ${text}`).catch(() => {});
  };

  console.info = (...args) => {
    rawConsole.info(...args);
    const text = formatLogArgs(args);
    sendTelegram(`â„¹ï¸ ${text}`).catch(() => {});
  };

  console.warn = (...args) => {
    rawConsole.warn(...args);
    const text = formatLogArgs(args);
    sendTelegram(`âš ï¸ ${text}`).catch(() => {});
  };

  console.error = (...args) => {
    rawConsole.error(...args);
    const text = formatLogArgs(args);
    sendTelegram(`â Œ ${text}`).catch(() => {});
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
        "ðŸ’“ BOT HEARTBEAT",
        `SYMBOL: ${SYMBOL}`,
        `MODE: ${TRADE_MODE}`,
        `privateReady: ${privateReady}`,
        `tradeReady: ${tradeReady}`,
        `uptimeSec: ${Math.floor(process.uptime())}`,
        `latestPositionUpdatedAt: ${latestPositionUpdatedAt || 0}`,
        `UTA_RESERVE_BALANCE: ${UTA_RESERVE_BALANCE}`,
        `latestUtaUsdtWalletBalance: ${
          latestUtaUsdtWalletBalance === null ? "null" : latestUtaUsdtWalletBalance
        }`,
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

function signRestPost(timestamp, bodyString) {
  return hmacSha256(`${timestamp}${API_KEY}${RECV_WINDOW}${bodyString}`);
}

// ===== NEW: V5 header-based GET signing (for wallet-balance) =====
function buildSortedQueryString(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join("&");
}

function signV5Get(timestamp, queryString) {
  return hmacSha256(`${timestamp}${API_KEY}${RECV_WINDOW}${queryString}`);
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

// ================= POSITION CACHE HELPERS =================
// Additive fix only: these helpers are used by existing logic but were missing.
function setLatestPosition(pos) {
  latestPosition = pos;
  latestPositionUpdatedAt = Date.now();
}

function clearLatestPosition() {
  latestPosition = null;
  latestPositionUpdatedAt = 0;
}

async function getPosition() {
  const now = Date.now();

  if (
    latestPosition &&
    now - latestPositionUpdatedAt <= POSITION_CACHE_TTL &&
    Number(latestPosition.size || 0) > 0 &&
    latestPosition.side
  ) {
    return latestPosition;
  }

  const pos = await getPositionViaRest();

  if (!pos || Number(pos.size) <= 0 || !pos.side) {
    clearLatestPosition();
    return null;
  }

  setLatestPosition(pos);
  return pos;
}

// ================= NEW FAST RESERVE HELPERS =================
function setLatestUTAUsdtWalletBalance(balance) {
  const normalized = Number(balance);
  if (!Number.isFinite(normalized)) return;

  latestUtaUsdtWalletBalance = normalized;
  latestUtaUsdtWalletBalanceUpdatedAt = Date.now();
}

function extractUnifiedUsdtWalletBalanceFromWalletStream(data) {
  if (!Array.isArray(data)) return null;

  for (const account of data) {
    if (account?.accountType !== "UNIFIED") continue;
    if (!Array.isArray(account.coin)) continue;

    const usdtCoin = account.coin.find((c) => c?.coin === "USDT");
    if (!usdtCoin) continue;

    const walletBalance = Number(usdtCoin.walletBalance || 0);
    if (Number.isFinite(walletBalance)) {
      return walletBalance;
    }
  }

  return null;
}

function clearReserveFastTransferTimer() {
  if (reserveFastTransferTimer) {
    clearTimeout(reserveFastTransferTimer);
    reserveFastTransferTimer = null;
  }
}

function scheduleFastReserveTransferCheck(reason = "wallet-stream") {
  if (TRADE_MODE !== "mainnet") return;

  clearReserveFastTransferTimer();

  reserveFastTransferTimer = setTimeout(async () => {
    reserveFastTransferTimer = null;

    try {
      console.log(
        `âš¡ Fast reserve transfer check triggered (${reason}) after ${RESERVE_FAST_TRANSFER_DELAY_MS}ms`
      );
      await maintainUTAReserveBalance("wallet-fast-trigger");
    } catch (err) {
      console.error("FAST RESERVE TRANSFER CHECK ERROR:", err.message);
    }
  }, RESERVE_FAST_TRANSFER_DELAY_MS);
}

function maybeTriggerFastReserveTransferFromWallet(balance, reason = "wallet-stream") {
  if (!Number.isFinite(balance)) return;

  const excess = roundDown(balance - UTA_RESERVE_BALANCE, 6);

  if (excess >= RESERVE_TRANSFER_MIN_AMOUNT) {
    console.log(
      `âš¡ Wallet WS detected UTA USDT excess=${excess}. Scheduling fast transfer check...`
    );
    scheduleFastReserveTransferCheck(reason);
  }
}

// ================= NEW: OPEN POSITION GUARD FOR UTA -> FUND =================
async function hasOpenPositionForReserveProtection() {
  try {
    const pos = await getPosition();

    if (!pos || Number(pos.size) <= 0 || !pos.side) {
      return false;
    }

    console.log(
      `ðŸ›‘ Reserve protection active: open position detected | symbol=${pos.symbol} | side=${pos.side} | size=${pos.size}`
    );
    return true;
  } catch (err) {
    console.error(
      "CHECK OPEN POSITION FOR RESERVE PROTECTION ERROR:",
      err.response?.data || err.message
    );
    return false;
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

    console.log("âœ… POSITION CLOSE SENT VIA REST:", res.data);
  } catch (err) {
    console.error("CLOSE POSITION REST ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ================= NEW: UTA BALANCE CHECK =================
async function getUTAUsdtWalletBalance() {
  if (TRADE_MODE !== "mainnet") {
    console.log("ðŸ§ª Skipping UTA reserve check balance fetch (Demo/Testnet mode active)");
    return null;
  }

  try {
    const timestamp = Date.now().toString();

    const params = {
      accountType: "UNIFIED",
      coin: "USDT",
    };

    const queryString = buildSortedQueryString(params);
    const sign = signV5Get(timestamp, queryString);

    const res = await axios.get(`${HTTP_BASE_URL}/v5/account/wallet-balance`, {
      params,
      headers: {
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": sign,
      },
      timeout: 15000,
    });

    if (res?.data?.retCode !== 0) {
      throw new Error(res?.data?.retMsg || "Unknown wallet balance error");
    }

    const account = res?.data?.result?.list?.[0];
    const usdtCoin = account?.coin?.find((c) => c.coin === "USDT");

    if (!usdtCoin) {
      console.log("â„¹ï¸ No USDT coin entry found in UTA wallet-balance response");
      return 0;
    }

    const walletBalance = Number(usdtCoin.walletBalance || 0);
    const normalized = Number.isFinite(walletBalance) ? walletBalance : 0;

    setLatestUTAUsdtWalletBalance(normalized);
    return normalized;
  } catch (err) {
    console.error("GET UTA USDT BALANCE ERROR:", err.response?.data || err.message);
    return null;
  }
}

// ================= CLOSE VERIFICATION =================
async function verifyPositionClosed(retries = CLOSE_VERIFY_RETRIES) {
  for (let i = 0; i < retries; i++) {
    await sleep(CLOSE_VERIFY_DELAY);

    const pos = await getPositionViaRest();

    if (!pos || Number(pos.size) <= 0 || !pos.side) {
      clearLatestPosition();
      currentInterval = SLOW_INTERVAL;
      console.log("âœ… Position confirmed closed");
      return true;
    }

    setLatestPosition(pos);
    console.log(
      `â ³ Close verification attempt ${i + 1}/${retries}: position still open | size=${pos.size} | pnl=${Number(
        pos.unrealisedPnl || 0
      )}`
    );
  }

  console.error("â Œ Close sent but position still open after verification");
  return false;
}

// ================= CLOSE POSITION =================
async function closePosition(side, size) {
  if (isClosing) {
    console.log("â ³ Close already in progress, skipping duplicate request...");
    return;
  }

  isClosing = true;

  try {
    clearLatestPosition();

    if (TRADE_MODE === "demo" && FORCE_REST_CLOSE_ON_DEMO) {
      console.log("ðŸ§ª DEMO MODE: using REST fallback close...");
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
      console.log("âœ… CLOSE REQUEST SENT VIA WS");
      await verifyPositionClosed();
    } else {
      console.log("âš ï¸ TRADE WS not ready, fallback to REST close...");
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

// ================= AUTO TRANSFER (FUNDING TO UTA) =================
async function transferFundingToUTA() {
  if (TRADE_MODE !== "mainnet") {
    console.log("ðŸ§ª Skipping Auto-Transfer (Demo/Testnet mode active)");
    return;
  }

  try {
    const timestamp = Date.now().toString();
    const transferId = crypto.randomUUID();

    const body = {
      transferId,
      coin: "USDT",
      amount: String(TRANSFER_AMOUNT),
      fromAccountType: "FUND",
      toAccountType: "UNIFIED", // Unified Trading Account
    };

    const bodyString = JSON.stringify(body);
    const sign = signRestPost(timestamp, bodyString);

    const res = await axios.post(`${HTTP_BASE_URL}/v5/asset/transfer/inter-transfer`, body, {
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": sign,
      },
    });

    if (res?.data?.retCode !== 0) {
      console.warn(`âš ï¸ Transfer Failed: ${res?.data?.retMsg || "Insufficient balance or error"}`);
    } else {
      console.log(`ðŸ’¸ Success! Transferred ${TRANSFER_AMOUNT} USDT from FUNDING to UTA.`);
    }
  } catch (err) {
    console.error("TRANSFER ERROR:", err.response?.data || err.message);
  }
}

function startAutoTransfer() {
  console.log(`â ±ï¸ Auto-Transfer Active: Moving ${TRANSFER_AMOUNT} USDT every 5 minutes.`);

  setInterval(() => {
    transferFundingToUTA();
  }, TRANSFER_INTERVAL_MS);
}

// ================= NEW: UTA EXCESS -> FUNDING =================
async function transferExcessUTAToFunding(amount) {
  if (TRADE_MODE !== "mainnet") {
    console.log("ðŸ§ª Skipping UTA excess transfer (Demo/Testnet mode active)");
    return;
  }

  const normalizedAmount = roundDown(amount, 6);

  if (!Number.isFinite(normalizedAmount) || normalizedAmount < RESERVE_TRANSFER_MIN_AMOUNT) {
    console.log(
      `â„¹ï¸ UTA excess transfer skipped. Amount too small: ${normalizedAmount} USDT`
    );
    return;
  }

  const hasOpenPosition = await hasOpenPositionForReserveProtection();
  if (hasOpenPosition) {
    console.log(
      "â ¸ï¸ UTA -> FUND transfer skipped because there is still an open position."
    );
    return;
  }

  try {
    const timestamp = Date.now().toString();
    const transferId = crypto.randomUUID();

    const body = {
      transferId,
      coin: "USDT",
      amount: String(normalizedAmount),
      fromAccountType: "UNIFIED",
      toAccountType: "FUND",
    };

    const bodyString = JSON.stringify(body);
    const sign = signRestPost(timestamp, bodyString);

    const res = await axios.post(`${HTTP_BASE_URL}/v5/asset/transfer/inter-transfer`, body, {
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": sign,
      },
      timeout: 15000,
    });

    if (res?.data?.retCode !== 0) {
      console.warn(
        `âš ï¸ UTA -> FUND transfer failed: ${res?.data?.retMsg || "unknown transfer error"}`
      );
      return;
    }

    console.log(
      `ðŸ’¼ Reserve maintained: transferred ${normalizedAmount} USDT excess from UTA to Funding.`
    );
  } catch (err) {
    console.error("UTA -> FUND TRANSFER ERROR:", err.response?.data || err.message);
  }
}

async function maintainUTAReserveBalance(source = "interval") {
  if (isReserveMaintaining) {
    console.log(`â ³ Reserve maintenance already running, skipping duplicate cycle... [${source}]`);
    return;
  }

  isReserveMaintaining = true;

  try {
    if (TRADE_MODE !== "mainnet") {
      console.log("ðŸ§ª Skipping reserve maintenance (Demo/Testnet mode active)");
      return;
    }

    const utaUsdtBalance = await getUTAUsdtWalletBalance();

    if (utaUsdtBalance === null) {
      console.warn(`âš ï¸ Unable to read UTA USDT balance. Reserve maintenance skipped. [${source}]`);
      return;
    }

    console.log(
      `ðŸ ¦ UTA USDT walletBalance: ${utaUsdtBalance} | reserve target: ${UTA_RESERVE_BALANCE} | source: ${source}`
    );

    const excess = roundDown(utaUsdtBalance - UTA_RESERVE_BALANCE, 6);

    if (excess >= RESERVE_TRANSFER_MIN_AMOUNT) {
      const hasOpenPosition = await hasOpenPositionForReserveProtection();

      if (hasOpenPosition) {
        console.log(
          "â ¸ï¸ UTA reserve excess detected, but transfer to Funding is skipped because an open position is still present."
        );
        return;
      }

      console.log(
        `ðŸ’¡ UTA balance exceeds reserve by ${excess} USDT. Transferring excess to Funding...`
      );
      await transferExcessUTAToFunding(excess);
    } else {
      console.log("âœ… UTA reserve OK. No excess transfer needed.");
    }
  } catch (err) {
    console.error("MAINTAIN UTA RESERVE ERROR:", err.message);
  } finally {
    isReserveMaintaining = false;
  }
}

function startUTAReserveMaintainer() {
  console.log(
    `ðŸ›¡ï¸ UTA reserve maintainer active: keeping ${UTA_RESERVE_BALANCE} USDT in UTA, checking every ${Math.floor(
      RESERVE_CHECK_INTERVAL_MS / 1000
    )} seconds.`
  );

  // initial run
  maintainUTAReserveBalance("startup").catch(() => {});

  setInterval(() => {
    maintainUTAReserveBalance("interval").catch(() => {});
  }, RESERVE_CHECK_INTERVAL_MS);
}

// ================= MONITOR =================
async function monitor() {
  const pos = await getPosition();

  if (!pos || Number(pos.size) <= 0 || !pos.side) {
    console.log("ðŸ“­ No open position");
    currentInterval = SLOW_INTERVAL;
    return;
  }

  currentInterval = FAST_INTERVAL;

  const pnl = Number(pos.unrealisedPnl || 0);
  const size = pos.size;
  const side = pos.side;

  console.log(`ðŸ“Š ${SYMBOL} PnL (USDT): ${pnl}`);

  if (pnl <= MAX_LOSS) {
    console.log(`ðŸš¨ MAX LOSS HIT (${MAX_LOSS}). Closing position...`);
    await closePosition(side, size);
    return;
  }

  if (pnl >= TAKE_PROFIT) {
    console.log(`ðŸŽ¯ TAKE PROFIT HIT (${TAKE_PROFIT}). Closing position...`);
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
    console.error(`âš ï¸ MONITOR ERROR [${source}]:`, err.message);
  } finally {
    isExecuting = false;
  }
}

// ================= PRIVATE WS =================
function connectPrivateWS() {
  let retry = 0;

  const openConnection = () => {
    console.log(`ðŸ”Œ Connecting PRIVATE WS (${TRADE_MODE})...`);
    privateWs = new WebSocket(PRIVATE_WS_URL);

    privateWs.on("open", () => {
      console.log("âœ… PRIVATE WS CONNECTED");
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
        console.log("ðŸ” PRIVATE WS AUTH OK");

        privateWs.send(
          JSON.stringify({
            op: "subscribe",
            args: ["position", "order", "wallet"],
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
        console.log("ðŸ“¡ PRIVATE WS SUBSCRIBED");
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

      if (msg.topic === "wallet" && Array.isArray(msg.data)) {
        const wsBalance = extractUnifiedUsdtWalletBalanceFromWalletStream(msg.data);

        if (wsBalance !== null) {
          setLatestUTAUsdtWalletBalance(wsBalance);

          console.log(
            `ðŸ’° WALLET WS UPDATE: UTA USDT walletBalance=${wsBalance} | reserve=${UTA_RESERVE_BALANCE}`
          );

          maybeTriggerFastReserveTransferFromWallet(wsBalance, "wallet-stream");
        } else {
          console.log("â„¹ï¸ WALLET WS UPDATE received, but no UNIFIED USDT balance was found.");
        }

        return;
      }

      if (msg.topic === "order" && Array.isArray(msg.data)) {
        for (const order of msg.data) {
          if (order.symbol !== SYMBOL) continue;

          console.log(
            `ðŸ§¾ ORDER UPDATE: ${order.orderStatus || "UNKNOWN"} | ${order.side} | qty=${order.qty}`
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

      clearReserveFastTransferTimer();

      const wait = Math.min(30000, 2000 * Math.pow(2, retry));
      console.log(`âš ï¸ PRIVATE WS CLOSED â†’ reconnect in ${wait}ms`);

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
    console.log(`ðŸ”Œ Connecting TRADE WS (${TRADE_MODE})...`);
    tradeWs = new WebSocket(TRADE_WS_URL);

    tradeWs.on("open", () => {
      console.log("âœ… TRADE WS CONNECTED");
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
        console.log("ðŸ” TRADE WS AUTH OK");
        tradeReady = true;

        if (tradeHeartbeat) clearInterval(tradeHeartbeat);
        tradeHeartbeat = startHeartbeat(tradeWs, "TRADE");

        flushPendingTradeRequests();
        return;
      }

      if (msg.op === "pong") return;

      if (msg.op === "order.create") {
        if (msg.retCode === 0) {
          console.log("âœ… POSITION CLOSE ACK:", msg.data);
        } else {
          console.error("â Œ POSITION CLOSE REJECTED:", msg);
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
      console.log(`âš ï¸ TRADE WS CLOSED â†’ reconnect in ${wait}ms`);

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
  console.error("ðŸ”¥ UNHANDLED REJECTION:", err?.message || err);
  await sendTelegram(`ðŸ”¥ UNHANDLED REJECTION\n${err?.message || String(err)}`);
});

process.on("uncaughtException", async (err) => {
  console.error("ðŸ”¥ UNCAUGHT EXCEPTION:", err?.message || err);
  await sendTelegram(`ðŸ”¥ UNCAUGHT EXCEPTION\n${err?.message || String(err)}`);
});

process.on("SIGTERM", async () => {
  console.log("ðŸ›‘ SIGTERM received");
  running = false;
  clearReserveFastTransferTimer();
  await sendTelegram("ðŸ›‘ Render sent SIGTERM. Bot stopping.");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("ðŸ›‘ SIGINT received");
  running = false;
  clearReserveFastTransferTimer();
  await sendTelegram("ðŸ›‘ Process interrupted. Bot stopping.");
  process.exit(0);
});

// ================= START =================
async function startBot() {
  installTelegramConsoleMirror();

  console.log("ðŸ¤– BOT STARTED...");
  console.log(`ðŸ“Œ SYMBOL: ${SYMBOL}`);
  console.log(`ðŸŒ TRADE_MODE: ${TRADE_MODE}`);
  console.log(`ðŸŒ HTTP: ${HTTP_BASE_URL}`);
  console.log(`ðŸ”Œ PRIVATE WS: ${PRIVATE_WS_URL}`);
  console.log(`âš¡ RESERVE_FAST_TRANSFER_DELAY_MS: ${RESERVE_FAST_TRANSFER_DELAY_MS}`);

  await sendTelegram(
    [
      "âœ… BOT STARTED ON RENDER",
      `SYMBOL: ${SYMBOL}`,
      `MODE: ${TRADE_MODE}`,
      `HTTP: ${HTTP_BASE_URL}`,
      `PRIVATE_WS: ${PRIVATE_WS_URL}`,
      `TELEGRAM_LOGS_ENABLED: ${TELEGRAM_LOGS_ENABLED}`,
      `UTA_RESERVE_BALANCE: ${UTA_RESERVE_BALANCE}`,
      `RESERVE_FAST_TRANSFER_DELAY_MS: ${RESERVE_FAST_TRANSFER_DELAY_MS}`,
    ].join("\n")
  );

  startTelegramHeartbeat();
  connectPrivateWS();

  if (TRADE_MODE !== "demo") {
    console.log(`ðŸ”Œ TRADE WS: ${TRADE_WS_URL}`);
    connectTradeWS();
  } else {
    console.log("ðŸ§ª DEMO MODE: TRADE WS disabled, REST fallback enabled.");
  }

  // Original logic preserved
  startAutoTransfer();

  // Original reserve logic preserved as fallback, wallet WS adds faster trigger
  startUTAReserveMaintainer();

  startWatchdog();
}

startBot();
