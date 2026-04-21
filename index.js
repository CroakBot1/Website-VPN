import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

// ================= CONFIG =================
const API_KEY = String(process.env.API_KEY || "").trim();
const API_SECRET = String(process.env.API_SECRET || "").trim();

const SYMBOL = String(process.env.SYMBOL || "BTCUSDT").trim();
const MAX_LOSS = Number(process.env.MAX_LOSS ?? -70);
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT ?? 90);

const FAST_INTERVAL = 2000;
const SLOW_INTERVAL = 10000;
let currentInterval = SLOW_INTERVAL;

const RECV_WINDOW = String(process.env.RECV_WINDOW || "5000");
const POSITION_CACHE_TTL = Number(process.env.POSITION_CACHE_TTL ?? 3000);
const CLOSE_VERIFY_RETRIES = Number(process.env.CLOSE_VERIFY_RETRIES ?? 10);
const CLOSE_VERIFY_DELAY = Number(process.env.CLOSE_VERIFY_DELAY ?? 1000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS ?? 15000);
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS ?? 15000);

// ================= TRANSFER CONFIG =================
const TRANSFER_AMOUNT = Number(process.env.TRANSFER_AMOUNT ?? 50);
const TRANSFER_INTERVAL_MS = 5 * 60 * 1000;

// ================= RESERVE CONFIG =================
const UTA_RESERVE_BALANCE = Number(process.env.UTA_RESERVE_BALANCE ?? 401);
const RESERVE_CHECK_INTERVAL_MS = Number(
  process.env.RESERVE_CHECK_INTERVAL_MS ?? 60 * 1000
);
const RESERVE_TRANSFER_MIN_AMOUNT = Number(
  process.env.RESERVE_TRANSFER_MIN_AMOUNT ?? 0.01
);
const RESERVE_FAST_TRANSFER_DELAY_MS = Number(
  process.env.RESERVE_FAST_TRANSFER_DELAY_MS ?? 1000
);
const RESERVE_BALANCE_CACHE_TTL_MS = Math.max(
  RESERVE_CHECK_INTERVAL_MS,
  RESERVE_FAST_TRANSFER_DELAY_MS + 1000,
  5000
);
const RESERVE_TRANSFER_SETTLE_MS = Math.max(
  RESERVE_FAST_TRANSFER_DELAY_MS + 2500,
  RESERVE_CHECK_INTERVAL_MS + 1000,
  4000
);

/**
 * TRADE_MODE:
 * - mainnet = actual live account
 * - demo    = bybit demo trading
 * - testnet = bybit testnet
 */
const TRADE_MODE = String(process.env.TRADE_MODE || "mainnet")
  .trim()
  .toLowerCase();

const FORCE_REST_CLOSE_ON_DEMO =
  String(process.env.FORCE_REST_CLOSE_ON_DEMO ?? "true").toLowerCase() ===
  "true";

// ================= TELEGRAM CONFIG =================
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const TELEGRAM_LOGS_ENABLED =
  String(process.env.TELEGRAM_LOGS_ENABLED ?? "true").toLowerCase() === "true";
const TELEGRAM_HEARTBEAT_MINUTES = Number(
  process.env.TELEGRAM_HEARTBEAT_MINUTES ?? 10
);
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
    : TRADE_MODE === "demo"
    ? null
    : "wss://stream.bybit.com/v5/trade";

// ================= VALIDATION =================
function assertNumber(name, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric env: ${name}`);
  }
}

if (!API_KEY || !API_SECRET) {
  throw new Error("Missing API_KEY or API_SECRET in .env");
}

if (!["mainnet", "demo", "testnet"].includes(TRADE_MODE)) {
  throw new Error("TRADE_MODE must be one of: mainnet, demo, testnet");
}

assertNumber("MAX_LOSS", MAX_LOSS);
assertNumber("TAKE_PROFIT", TAKE_PROFIT);
assertNumber("TRANSFER_AMOUNT", TRANSFER_AMOUNT);
assertNumber("UTA_RESERVE_BALANCE", UTA_RESERVE_BALANCE);
assertNumber("RESERVE_CHECK_INTERVAL_MS", RESERVE_CHECK_INTERVAL_MS);
assertNumber("RESERVE_TRANSFER_MIN_AMOUNT", RESERVE_TRANSFER_MIN_AMOUNT);
assertNumber(
  "RESERVE_FAST_TRANSFER_DELAY_MS",
  RESERVE_FAST_TRANSFER_DELAY_MS
);
assertNumber("POSITION_CACHE_TTL", POSITION_CACHE_TTL);
assertNumber("CLOSE_VERIFY_RETRIES", CLOSE_VERIFY_RETRIES);
assertNumber("CLOSE_VERIFY_DELAY", CLOSE_VERIFY_DELAY);
assertNumber("HTTP_TIMEOUT_MS", HTTP_TIMEOUT_MS);
assertNumber("TELEGRAM_TIMEOUT_MS", TELEGRAM_TIMEOUT_MS);

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

let latestUtaUsdtWalletBalance = null;
let latestUtaUsdtWalletBalanceUpdatedAt = 0;
let reserveFastTransferTimer = null;
let reserveTransferState = {
  inFlight: false,
  direction: null,
  amount: 0,
  source: null,
  startedAt: 0,
  expectedBalance: null,
  settleTimer: null,
};

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegram(message, options = {}) {
  if (!TELEGRAM_LOGS_ENABLED) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  telegramQueue.push({
    message: String(message),
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
            timeout: TELEGRAM_TIMEOUT_MS,
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
    void sendTelegram(`ℹ️ ${text}`);
  };

  console.info = (...args) => {
    rawConsole.info(...args);
    const text = formatLogArgs(args);
    void sendTelegram(`ℹ️ ${text}`);
  };

  console.warn = (...args) => {
    rawConsole.warn(...args);
    const text = formatLogArgs(args);
    void sendTelegram(`⚠️ ${text}`);
  };

  console.error = (...args) => {
    rawConsole.error(...args);
    const text = formatLogArgs(args);
    void sendTelegram(`❌ ${text}`);
  };
}

function startTelegramHeartbeat() {
  if (!TELEGRAM_LOGS_ENABLED) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  if (telegramHeartbeat) clearInterval(telegramHeartbeat);

  const intervalMs = Math.max(1, TELEGRAM_HEARTBEAT_MINUTES) * 60 * 1000;

  telegramHeartbeat = setInterval(() => {
    void sendTelegram(
      [
        "💓 BOT HEARTBEAT",
        `SYMBOL: ${SYMBOL}`,
        `MODE: ${TRADE_MODE}`,
        `privateReady: ${privateReady}`,
        `tradeReady: ${tradeReady}`,
        `uptimeSec: ${Math.floor(process.uptime())}`,
        `latestPositionUpdatedAt: ${latestPositionUpdatedAt || 0}`,
        `UTA_RESERVE_BALANCE: ${UTA_RESERVE_BALANCE}`,
        `latestUtaUsdtWalletBalance: ${
          latestUtaUsdtWalletBalance === null
            ? "null"
            : latestUtaUsdtWalletBalance
        }`,
      ].join("\n"),
      { disableNotification: true }
    );
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

function buildSortedQueryString(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join("&");
}

function signV5Get(timestamp, queryString) {
  return hmacSha256(`${timestamp}${API_KEY}${RECV_WINDOW}${queryString}`);
}

function signV5Post(timestamp, bodyString) {
  return hmacSha256(`${timestamp}${API_KEY}${RECV_WINDOW}${bodyString}`);
}

function buildV5GetHeaders(timestamp, sign) {
  return {
    "X-BAPI-API-KEY": API_KEY,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    "X-BAPI-SIGN": sign,
  };
}

function buildV5PostHeaders(timestamp, sign) {
  return {
    "Content-Type": "application/json",
    "X-BAPI-API-KEY": API_KEY,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    "X-BAPI-SIGN": sign,
  };
}

async function bybitGet(path, params = {}) {
  const timestamp = Date.now().toString();
  const queryString = buildSortedQueryString(params);
  const sign = signV5Get(timestamp, queryString);

  const res = await axios.get(`${HTTP_BASE_URL}${path}`, {
    params,
    headers: buildV5GetHeaders(timestamp, sign),
    timeout: HTTP_TIMEOUT_MS,
  });

  return res.data;
}

async function bybitPost(path, body = {}) {
  const timestamp = Date.now().toString();
  const bodyString = JSON.stringify(body);
  const sign = signV5Post(timestamp, bodyString);

  const res = await axios.post(`${HTTP_BASE_URL}${path}`, body, {
    headers: buildV5PostHeaders(timestamp, sign),
    timeout: HTTP_TIMEOUT_MS,
  });

  return res.data;
}

function getActiveSymbolPosition(list) {
  if (!Array.isArray(list)) return null;

  const active = list.find(
    (p) =>
      p &&
      p.symbol === SYMBOL &&
      Number(p.size || 0) > 0 &&
      typeof p.side === "string" &&
      p.side.length > 0 &&
      p.side !== "None"
  );

  return active || null;
}

function flushPendingTradeRequests() {
  while (
    pendingTradeRequests.length &&
    tradeReady &&
    tradeWs &&
    tradeWs.readyState === WebSocket.OPEN
  ) {
    tradeWs.send(JSON.stringify(pendingTradeRequests.shift()));
  }
}

// ================= POSITION CACHE HELPERS =================
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
    latestPosition.side &&
    latestPosition.side !== "None"
  ) {
    return latestPosition;
  }

  const pos = await getPositionViaRest();

  if (!pos || Number(pos.size || 0) <= 0 || !pos.side || pos.side === "None") {
    clearLatestPosition();
    return null;
  }

  setLatestPosition(pos);
  return pos;
}

// ================= RESERVE HELPERS =================
function setLatestUTAUsdtWalletBalance(balance) {
  const normalized = Number(balance);
  if (!Number.isFinite(normalized)) return latestUtaUsdtWalletBalance;

  const previousBalance = latestUtaUsdtWalletBalance;

  latestUtaUsdtWalletBalance = normalized;
  latestUtaUsdtWalletBalanceUpdatedAt = Date.now();

  return previousBalance;
}

function invalidateLatestUTAUsdtWalletBalanceCache() {
  latestUtaUsdtWalletBalanceUpdatedAt = 0;
}

function hasFreshUTAUsdtWalletBalance(maxAgeMs = RESERVE_BALANCE_CACHE_TTL_MS) {
  return (
    latestUtaUsdtWalletBalance !== null &&
    Date.now() - latestUtaUsdtWalletBalanceUpdatedAt <= maxAgeMs
  );
}

function clearReserveTransferState(reason = "clear") {
  if (reserveTransferState.settleTimer) {
    clearTimeout(reserveTransferState.settleTimer);
  }

  reserveTransferState = {
    inFlight: false,
    direction: null,
    amount: 0,
    source: null,
    startedAt: 0,
    expectedBalance: null,
    settleTimer: null,
  };

  console.log(`ℹ️ Reserve transfer state cleared [${reason}]`);
}

function isReserveTransferInFlight() {
  return reserveTransferState.inFlight;
}

function markReserveTransferInFlight({
  direction,
  amount,
  source,
  expectedBalance = UTA_RESERVE_BALANCE,
}) {
  if (reserveTransferState.settleTimer) {
    clearTimeout(reserveTransferState.settleTimer);
  }

  reserveTransferState = {
    inFlight: true,
    direction,
    amount,
    source,
    startedAt: Date.now(),
    expectedBalance,
    settleTimer: null,
  };

  invalidateLatestUTAUsdtWalletBalanceCache();

  reserveTransferState.settleTimer = setTimeout(async () => {
    const snapshot = { ...reserveTransferState };
    clearReserveTransferState(`settle-timeout:${snapshot.direction || "unknown"}`);

    try {
      console.log(
        `⏲️ Reserve transfer settle window expired. Rechecking reserve... [${
          snapshot.source || "unknown"
        }]`
      );
      await maintainUTAReserveBalance(
        `post-transfer-settle:${snapshot.direction || "unknown"}`
      );
    } catch (err) {
      console.error("POST TRANSFER SETTLE CHECK ERROR:", err.message);
    }
  }, RESERVE_TRANSFER_SETTLE_MS);

  console.log(
    `🚚 Reserve transfer in-flight | direction=${direction} | amount=${amount} | expectedBalance=${expectedBalance} | settleMs=${RESERVE_TRANSFER_SETTLE_MS} | source=${source}`
  );
}

function maybeFinalizeReserveTransferFromBalance(balance, reason = "wallet-update") {
  if (!reserveTransferState.inFlight) return false;
  if (!Number.isFinite(balance)) return false;

  const expectedBalance = Number(reserveTransferState.expectedBalance);
  if (!Number.isFinite(expectedBalance)) return false;

  const delta = Math.abs(roundDown(balance - expectedBalance, 6));
  if (delta >= RESERVE_TRANSFER_MIN_AMOUNT) return false;

  console.log(
    `✅ Reserve transfer settled from ${reason}. balance=${balance} | expected=${expectedBalance}`
  );
  clearReserveTransferState(`balanced:${reason}`);
  return true;
}

function extractUnifiedUsdtWalletBalanceFromWalletStream(data) {
  if (!Array.isArray(data)) return null;

  for (const account of data) {
    const accountType = String(account?.accountType || "").toUpperCase();
    if (accountType !== "UNIFIED") continue;
    if (!Array.isArray(account.coin)) continue;

    const usdtCoin = account.coin.find((c) => c?.coin === "USDT");
    if (!usdtCoin) continue;

    const walletBalance = Number(usdtCoin.walletBalance || 0);
    if (Number.isFinite(walletBalance)) return walletBalance;
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

  if (isReserveTransferInFlight()) {
    console.log(
      `⏳ Fast reserve check skipped because a reserve transfer is still settling. [${reason}]`
    );
    return;
  }

  clearReserveFastTransferTimer();

  reserveFastTransferTimer = setTimeout(async () => {
    reserveFastTransferTimer = null;

    try {
      if (isReserveTransferInFlight()) {
        console.log(
          `⏳ Fast reserve check skipped on execution because a reserve transfer is still settling. [${reason}]`
        );
        return;
      }

      console.log(
        `⚡ Fast reserve transfer check triggered (${reason}) after ${RESERVE_FAST_TRANSFER_DELAY_MS}ms`
      );
      await maintainUTAReserveBalance("wallet-fast-trigger");
    } catch (err) {
      console.error("FAST RESERVE TRANSFER CHECK ERROR:", err.message);
    }
  }, RESERVE_FAST_TRANSFER_DELAY_MS);
}

function maybeTriggerFastReserveTransferFromWallet(
  balance,
  reason = "wallet-stream",
  previousBalance = null
) {
  if (!Number.isFinite(balance)) return;

  maybeFinalizeReserveTransferFromBalance(balance, `${reason}-balance-update`);

  const delta = roundDown(balance - UTA_RESERVE_BALANCE, 6);
  const absDelta = Math.abs(delta);
  const balanceChange =
    Number.isFinite(previousBalance) && previousBalance !== null
      ? roundDown(balance - previousBalance, 6)
      : null;

  if (absDelta < RESERVE_TRANSFER_MIN_AMOUNT) return;

  if (
    balanceChange !== null &&
    Math.abs(balanceChange) < RESERVE_TRANSFER_MIN_AMOUNT
  ) {
    return;
  }

  if (isReserveTransferInFlight()) {
    console.log(
      `⏳ Wallet WS detected reserve delta=${delta}, but reserve transfer is already settling. No duplicate fast check.`
    );
    return;
  }

  console.log(
    `⚡ Wallet WS detected UTA reserve delta=${delta}${
      balanceChange === null ? "" : ` | balanceChange=${balanceChange}`
    }. Scheduling fast reserve check...`
  );
  scheduleFastReserveTransferCheck(reason);
}

// ================= OPEN POSITION GUARD =================
async function hasOpenPositionForReserveProtection() {
  try {
    const pos = await getPosition();

    if (!pos || Number(pos.size || 0) <= 0 || !pos.side || pos.side === "None") {
      return false;
    }

    console.log(
      `🛑 Reserve protection active: open position detected | symbol=${pos.symbol} | side=${pos.side} | size=${pos.size}`
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
    const data = await bybitGet("/v5/position/list", {
      category: "linear",
      symbol: SYMBOL,
    });

    if (data?.retCode !== 0) {
      throw new Error(data?.retMsg || "Unknown position list error");
    }

    const list = data?.result?.list;
    const pos = getActiveSymbolPosition(list);

    return pos || null;
  } catch (err) {
    console.error("GET POSITION REST ERROR:", err.response?.data || err.message);
    return null;
  }
}

async function closePositionViaRest(side, size) {
  try {
    const body = {
      category: "linear",
      symbol: SYMBOL,
      side: side === "Buy" ? "Sell" : "Buy",
      orderType: "Market",
      qty: String(size),
      timeInForce: "IOC",
      reduceOnly: true,
    };

    const data = await bybitPost("/v5/order/create", body);

    if (data?.retCode !== 0) {
      throw new Error(`REST close failed: ${data?.retMsg || "unknown error"}`);
    }

    console.log("✅ POSITION CLOSE SENT VIA REST:", data);
  } catch (err) {
    console.error("CLOSE POSITION REST ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ================= UTA BALANCE CHECK =================
async function getUTAUsdtWalletBalance(options = {}) {
  const {
    preferCache = true,
    maxAgeMs = RESERVE_BALANCE_CACHE_TTL_MS,
  } = options;

  if (TRADE_MODE !== "mainnet") {
    console.log("🧪 Skipping UTA reserve check balance fetch (Demo/Testnet mode active)");
    return null;
  }

  if (preferCache && hasFreshUTAUsdtWalletBalance(maxAgeMs)) {
    return latestUtaUsdtWalletBalance;
  }

  try {
    const data = await bybitGet("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: "USDT",
    });

    if (data?.retCode !== 0) {
      throw new Error(data?.retMsg || "Unknown wallet balance error");
    }

    const account = data?.result?.list?.[0];
    const usdtCoin = account?.coin?.find((c) => c.coin === "USDT");

    if (!usdtCoin) {
      console.log("ℹ️ No USDT coin entry found in UTA wallet-balance response");
      setLatestUTAUsdtWalletBalance(0);
      return 0;
    }

    const walletBalance = Number(usdtCoin.walletBalance || 0);
    const normalized = Number.isFinite(walletBalance) ? walletBalance : 0;

    setLatestUTAUsdtWalletBalance(normalized);
    return normalized;
  } catch (err) {
    console.error(
      "GET UTA USDT BALANCE ERROR:",
      err.response?.data || err.message
    );
    return null;
  }
}

async function getInternalTransferAvailableAmount(fromAccountType, toAccountType) {
  if (TRADE_MODE !== "mainnet") {
    console.log(
      `🧪 Skipping internal transfer capacity fetch (${fromAccountType} -> ${toAccountType}) in Demo/Testnet mode`
    );
    return null;
  }

  try {
    const data = await bybitGet(
      "/v5/asset/transfer/query-account-coin-balance",
      {
        accountType: fromAccountType,
        toAccountType,
        coin: "USDT",
        withTransferSafeAmount: 1,
      }
    );

    if (data?.retCode !== 0) {
      throw new Error(data?.retMsg || "Unknown internal transfer balance error");
    }

    const balance = data?.result?.balance || {};
    const transferSafeAmount = Number(balance.transferSafeAmount || NaN);
    const transferBalance = Number(balance.transferBalance || NaN);
    const walletBalance = Number(balance.walletBalance || NaN);

    const available = Number.isFinite(transferSafeAmount)
      ? transferSafeAmount
      : Number.isFinite(transferBalance)
      ? transferBalance
      : Number.isFinite(walletBalance)
      ? walletBalance
      : 0;

    return {
      available: Math.max(0, roundDown(available, 6)),
      transferSafeAmount: Number.isFinite(transferSafeAmount)
        ? roundDown(transferSafeAmount, 6)
        : null,
      transferBalance: Number.isFinite(transferBalance)
        ? roundDown(transferBalance, 6)
        : null,
      walletBalance: Number.isFinite(walletBalance)
        ? roundDown(walletBalance, 6)
        : null,
    };
  } catch (err) {
    console.error(
      `GET INTERNAL TRANSFER CAPACITY ERROR (${fromAccountType} -> ${toAccountType}):`,
      err.response?.data || err.message
    );
    return null;
  }
}

// ================= CLOSE VERIFICATION =================
async function verifyPositionClosed(retries = CLOSE_VERIFY_RETRIES) {
  for (let i = 0; i < retries; i++) {
    await sleep(CLOSE_VERIFY_DELAY);

    const pos = await getPositionViaRest();

    if (!pos || Number(pos.size || 0) <= 0 || !pos.side || pos.side === "None") {
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
    clearLatestPosition();

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

    if (TRADE_MODE !== "demo" && tradeReady && tradeWs?.readyState === WebSocket.OPEN) {
      tradeWs.send(JSON.stringify(payload));
      console.log("✅ CLOSE REQUEST SENT VIA WS");
      await verifyPositionClosed();
    } else {
      console.log("⚠️ TRADE WS not ready or disabled, fallback to REST close...");
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
    console.log("🧪 Skipping Auto-Transfer (Demo/Testnet mode active)");
    return;
  }

  try {
    const body = {
      transferId: crypto.randomUUID(),
      coin: "USDT",
      amount: String(TRANSFER_AMOUNT),
      fromAccountType: "FUND",
      toAccountType: "UNIFIED",
    };

    const data = await bybitPost("/v5/asset/transfer/inter-transfer", body);

    if (data?.retCode !== 0) {
      console.warn(
        `⚠️ Transfer Failed: ${data?.retMsg || "Insufficient balance or error"}`
      );
    } else {
      console.log(
        `💸 Success! Transferred ${TRANSFER_AMOUNT} USDT from FUNDING to UTA.`
      );
    }
  } catch (err) {
    console.error("TRANSFER ERROR:", err.response?.data || err.message);
  }
}

function startAutoTransfer() {
  console.log(
    `⏱️ Auto-Transfer Active: Moving ${TRANSFER_AMOUNT} USDT every 5 minutes.`
  );

  setInterval(() => {
    void transferFundingToUTA();
  }, TRANSFER_INTERVAL_MS);
}

// ================= UTA EXCESS -> FUNDING =================
async function transferExcessUTAToFunding(amount, source = "reserve-excess") {
  if (TRADE_MODE !== "mainnet") {
    console.log("🧪 Skipping UTA excess transfer (Demo/Testnet mode active)");
    return;
  }

  const requestedAmount = roundDown(amount, 6);

  if (
    !Number.isFinite(requestedAmount) ||
    requestedAmount < RESERVE_TRANSFER_MIN_AMOUNT
  ) {
    console.log(
      `ℹ️ UTA excess transfer skipped. Amount too small: ${requestedAmount} USDT`
    );
    return;
  }

  const hasOpenPosition = await hasOpenPositionForReserveProtection();
  if (hasOpenPosition) {
    console.log(
      "⏸️ UTA -> FUND transfer skipped because there is still an open position."
    );
    return;
  }

  const capacity = await getInternalTransferAvailableAmount("UNIFIED", "FUND");
  if (!capacity) {
    console.warn("⚠️ UTA -> FUND transfer skipped: unable to read transfer capacity.");
    return;
  }

  const normalizedAmount = roundDown(
    Math.min(requestedAmount, Number(capacity.available || 0)),
    6
  );

  if (normalizedAmount < RESERVE_TRANSFER_MIN_AMOUNT) {
    console.log(
      `ℹ️ UTA -> FUND transfer skipped. Transferable amount too small: ${normalizedAmount} USDT | requested=${requestedAmount}`
    );
    return;
  }

  if (normalizedAmount < requestedAmount) {
    console.log(
      `ℹ️ UTA -> FUND transfer capped by Bybit transferable amount. requested=${requestedAmount} | available=${capacity.available} | sending=${normalizedAmount}`
    );
  }

  try {
    const body = {
      transferId: crypto.randomUUID(),
      coin: "USDT",
      amount: String(normalizedAmount),
      fromAccountType: "UNIFIED",
      toAccountType: "FUND",
    };

    const data = await bybitPost("/v5/asset/transfer/inter-transfer", body);

    if (data?.retCode !== 0) {
      console.warn(
        `⚠️ UTA -> FUND transfer failed: ${data?.retMsg || "unknown transfer error"}`
      );
      return;
    }

    markReserveTransferInFlight({
      direction: "UNIFIED->FUND",
      amount: normalizedAmount,
      source,
      expectedBalance: UTA_RESERVE_BALANCE,
    });

    console.log(
      `💼 Reserve maintained: transferred ${normalizedAmount} USDT excess from UTA to Funding.`
    );
  } catch (err) {
    console.error(
      "UTA -> FUND TRANSFER ERROR:",
      err.response?.data || err.message
    );
  }
}

// ================= FUNDING -> UTA RESERVE TOP UP =================
async function transferReserveDeficitFundingToUTA(
  amount,
  source = "reserve-deficit"
) {
  if (TRADE_MODE !== "mainnet") {
    console.log("🧪 Skipping UTA reserve top-up (Demo/Testnet mode active)");
    return;
  }

  const requestedAmount = roundDown(amount, 6);

  if (
    !Number.isFinite(requestedAmount) ||
    requestedAmount < RESERVE_TRANSFER_MIN_AMOUNT
  ) {
    console.log(
      `ℹ️ UTA reserve top-up skipped. Amount too small: ${requestedAmount} USDT`
    );
    return;
  }

  const capacity = await getInternalTransferAvailableAmount("FUND", "UNIFIED");
  if (!capacity) {
    console.warn(
      "⚠️ FUND -> UTA reserve top-up skipped: unable to read transfer capacity."
    );
    return;
  }

  const normalizedAmount = roundDown(
    Math.min(requestedAmount, Number(capacity.available || 0)),
    6
  );

  if (normalizedAmount < RESERVE_TRANSFER_MIN_AMOUNT) {
    console.log(
      `ℹ️ FUND -> UTA reserve top-up skipped. Transferable amount too small: ${normalizedAmount} USDT | requested=${requestedAmount}`
    );
    return;
  }

  if (normalizedAmount < requestedAmount) {
    console.log(
      `ℹ️ FUND -> UTA reserve top-up capped by Bybit transferable amount. requested=${requestedAmount} | available=${capacity.available} | sending=${normalizedAmount}`
    );
  }

  try {
    const body = {
      transferId: crypto.randomUUID(),
      coin: "USDT",
      amount: String(normalizedAmount),
      fromAccountType: "FUND",
      toAccountType: "UNIFIED",
    };

    const data = await bybitPost("/v5/asset/transfer/inter-transfer", body);

    if (data?.retCode !== 0) {
      console.warn(
        `⚠️ FUND -> UTA reserve top-up failed: ${data?.retMsg || "unknown transfer error"}`
      );
      return;
    }

    markReserveTransferInFlight({
      direction: "FUND->UNIFIED",
      amount: normalizedAmount,
      source,
      expectedBalance: UTA_RESERVE_BALANCE,
    });

    console.log(
      `🏦 Reserve maintained: transferred ${normalizedAmount} USDT from Funding to UTA to restore reserve.`
    );
  } catch (err) {
    console.error(
      "FUND -> UTA RESERVE TOP-UP ERROR:",
      err.response?.data || err.message
    );
  }
}

async function maintainUTAReserveBalance(source = "interval") {
  if (isReserveMaintaining) {
    console.log(
      `⏳ Reserve maintenance already running, skipping duplicate cycle... [${source}]`
    );
    return;
  }

  if (isReserveTransferInFlight()) {
    console.log(
      `⏳ Reserve transfer still settling, skipping maintenance cycle... [${source}]`
    );
    return;
  }

  isReserveMaintaining = true;

  try {
    if (TRADE_MODE !== "mainnet") {
      console.log("🧪 Skipping reserve maintenance (Demo/Testnet mode active)");
      return;
    }

    const preferCache = source !== "startup";
    const utaUsdtBalance = await getUTAUsdtWalletBalance({ preferCache });

    if (utaUsdtBalance === null) {
      console.warn(
        `⚠️ Unable to read UTA USDT balance. Reserve maintenance skipped. [${source}]`
      );
      return;
    }

    maybeFinalizeReserveTransferFromBalance(utaUsdtBalance, `maintain:${source}`);

    console.log(
      `🏦 UTA USDT walletBalance: ${utaUsdtBalance} | reserve target: ${UTA_RESERVE_BALANCE} | source: ${source}`
    );

    const delta = roundDown(utaUsdtBalance - UTA_RESERVE_BALANCE, 6);

    if (Math.abs(delta) < RESERVE_TRANSFER_MIN_AMOUNT) {
      console.log("✅ UTA reserve OK. No transfer needed.");
      return;
    }

    if (delta > 0) {
      const hasOpenPosition = await hasOpenPositionForReserveProtection();

      if (hasOpenPosition) {
        console.log(
          "⏸️ UTA reserve excess detected, but transfer to Funding is skipped because an open position is still present."
        );
        return;
      }

      console.log(
        `💡 UTA balance exceeds reserve by ${delta} USDT. Transferring excess to Funding...`
      );
      await transferExcessUTAToFunding(delta, source);
      return;
    }

    const deficit = roundDown(Math.abs(delta), 6);

    console.log(
      `💡 UTA balance is below reserve by ${deficit} USDT. Topping up from Funding...`
    );
    await transferReserveDeficitFundingToUTA(deficit, source);
  } catch (err) {
    console.error("MAINTAIN UTA RESERVE ERROR:", err.message);
  } finally {
    isReserveMaintaining = false;
  }
}

function startUTAReserveMaintainer() {
  console.log(
    `🛡️ UTA reserve maintainer active: keeping ${UTA_RESERVE_BALANCE} USDT in UTA, checking every ${Math.floor(
      RESERVE_CHECK_INTERVAL_MS / 1000
    )} seconds.`
  );

  void maintainUTAReserveBalance("startup");

  setInterval(() => {
    void maintainUTAReserveBalance("interval");
  }, RESERVE_CHECK_INTERVAL_MS);
}

// ================= MONITOR =================
async function monitor() {
  const pos = await getPosition();

  if (!pos || Number(pos.size || 0) <= 0 || !pos.side || pos.side === "None") {
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
            args: ["position", "order", "wallet"],
          })
        );

        privateReady = true;

        if (privateHeartbeat) clearInterval(privateHeartbeat);
        privateHeartbeat = startHeartbeat(privateWs);
        return;
      }

      if (msg.op === "pong" || msg.ret_msg === "pong") return;

      if (
        msg.op === "subscribe" &&
        (msg.success === true || msg.retCode === 0 || msg.ret_msg === "subscribe")
      ) {
        console.log("📡 PRIVATE WS SUBSCRIBED");
        return;
      }

      if (msg.topic === "position" && Array.isArray(msg.data)) {
        const pos = getActiveSymbolPosition(msg.data);

        if (!pos) {
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
          const previousBalance = setLatestUTAUsdtWalletBalance(wsBalance);

          console.log(
            `💰 WALLET WS UPDATE: UTA USDT walletBalance=${wsBalance} | reserve=${UTA_RESERVE_BALANCE}`
          );

          maybeTriggerFastReserveTransferFromWallet(
            wsBalance,
            "wallet-stream",
            previousBalance
          );
        } else {
          console.log(
            "ℹ️ WALLET WS UPDATE received, but no UNIFIED USDT balance was found."
          );
        }

        return;
      }

      if (msg.topic === "order" && Array.isArray(msg.data)) {
        for (const order of msg.data) {
          if (order.symbol !== SYMBOL) continue;

          console.log(
            `🧾 ORDER UPDATE: ${order.orderStatus || "UNKNOWN"} | ${
              order.side
            } | qty=${order.qty}`
          );
        }
      }
    });

    privateWs.on("close", async () => {
      privateReady = false;

      if (privateHeartbeat) {
        clearInterval(privateHeartbeat);
        privateHeartbeat = null;
      }

      clearReserveFastTransferTimer();
      clearReserveTransferState("private-ws-close");

      const wait = Math.min(30000, 2000 * Math.pow(2, retry));
      console.log(`⚠️ PRIVATE WS CLOSED -> reconnect in ${wait}ms`);

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
  if (!TRADE_WS_URL) {
    console.log("🧪 TRADE WS disabled for demo mode.");
    return;
  }

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
        tradeHeartbeat = startHeartbeat(tradeWs);

        flushPendingTradeRequests();
        return;
      }

      if (msg.op === "pong" || msg.ret_msg === "pong") return;

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
      console.log(`⚠️ TRADE WS CLOSED -> reconnect in ${wait}ms`);

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

      if (latestPositionUpdatedAt === 0 || staleMs > currentInterval) {
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
  clearReserveFastTransferTimer();
  clearReserveTransferState("sigterm");
  await sendTelegram("🛑 Render sent SIGTERM. Bot stopping.");
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("🛑 SIGINT received");
  running = false;
  clearReserveFastTransferTimer();
  clearReserveTransferState("sigint");
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
  console.log(
    `⚡ RESERVE_FAST_TRANSFER_DELAY_MS: ${RESERVE_FAST_TRANSFER_DELAY_MS}`
  );

  await sendTelegram(
    [
      "✅ BOT STARTED",
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
    console.log(`🔌 TRADE WS: ${TRADE_WS_URL}`);
    connectTradeWS();
  } else {
    console.log("🧪 DEMO MODE: TRADE WS disabled, REST fallback enabled.");
  }

  startAutoTransfer();
  startUTAReserveMaintainer();
  await startWatchdog();
}

startBot().catch(async (err) => {
  console.error("FATAL START ERROR:", err?.message || err);
  await sendTelegram(`FATAL START ERROR\n${err?.message || String(err)}`);
  process.exit(1);
});
