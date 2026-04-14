import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import WebSocket from "ws";
import { spawn } from "child_process";

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

const TRADE_MODE = String(process.env.TRADE_MODE || "mainnet").toLowerCase();

const FORCE_REST_CLOSE_ON_DEMO =
  String(process.env.FORCE_REST_CLOSE_ON_DEMO ?? "true").toLowerCase() === "true";

// ================= TELEGRAM =================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_LOGS_ENABLED =
  String(process.env.TELEGRAM_LOGS_ENABLED ?? "true").toLowerCase() === "true";
const TELEGRAM_HEARTBEAT_MINUTES = Number(process.env.TELEGRAM_HEARTBEAT_MINUTES ?? 10);
const TELEGRAM_SILENT =
  String(process.env.TELEGRAM_SILENT ?? "false").toLowerCase() === "true";

let telegramQueue = [];
let telegramSending = false;
let lastTelegramMessageAt = 0;
let telegramHeartbeat = null;

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

// ================= URLS =================
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
if (!API_KEY || !API_SECRET) throw new Error("Missing API keys");
if (!["mainnet", "demo", "testnet"].includes(TRADE_MODE)) {
  throw new Error("Invalid TRADE_MODE");
}

// ================= RAW CONSOLE =================
const rawConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
};

// ================= UTIL =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeJsonParse(raw) {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString() : raw;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hmacSha256(text) {
  return crypto.createHmac("sha256", API_SECRET).update(text).digest("hex");
}

// ================= TELEGRAM =================
async function sendTelegram(message) {
  if (!TELEGRAM_LOGS_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  telegramQueue.push(message);
  if (telegramSending) return;

  telegramSending = true;

  try {
    while (telegramQueue.length) {
      const msg = telegramQueue.shift();

      const gap = Date.now() - lastTelegramMessageAt;
      if (gap < 5000) await sleep(5000 - gap);

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: TELEGRAM_CHAT_ID,
          text: msg,
          disable_notification: TELEGRAM_SILENT,
        }
      );

      lastTelegramMessageAt = Date.now();
    }
  } catch (e) {
    rawConsole.error("Telegram error:", e.message);
  } finally {
    telegramSending = false;
  }
}

// ================= WS HEARTBEAT =================
function startHeartbeat(ws, label) {
  return setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: "ping" }));
    }
  }, 20000);
}

// ================= SIGN =================
function generateWsAuth() {
  const expires = Date.now() + 10000;
  return {
    expires,
    signature: hmacSha256(`GET/realtime${expires}`),
  };
}

// ================= POSITION =================
function setLatestPosition(pos) {
  latestPosition = pos;
  latestPositionUpdatedAt = Date.now();
}

function clearLatestPosition() {
  latestPosition = null;
  latestPositionUpdatedAt = 0;
}

// ================= REST =================
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

    const query = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");

    const sign = hmacSha256(query);

    const res = await axios.get(`${HTTP_BASE_URL}/v5/position/list`, {
      params: { ...params, sign },
    });

    return res?.data?.result?.list?.[0] || null;
  } catch (e) {
    return null;
  }
}

// ================= CLOSE =================
async function closePosition(side, size) {
  if (isClosing) return;
  isClosing = true;

  try {
    clearLatestPosition();

    const body = {
      category: "linear",
      symbol: SYMBOL,
      side: side === "Buy" ? "Sell" : "Buy",
      orderType: "Market",
      qty: String(size),
      reduceOnly: true,
    };

    const ts = Date.now().toString();
    const sign = hmacSha256(`${ts}${API_KEY}${RECV_WINDOW}${JSON.stringify(body)}`);

    await axios.post(`${HTTP_BASE_URL}/v5/order/create`, body, {
      headers: {
        "X-BAPI-API-KEY": API_KEY,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": sign,
      },
    });

    console.log("✅ CLOSE SENT");
  } catch (e) {
    console.error("Close error:", e.message);
  } finally {
    setTimeout(() => (isClosing = false), 3000);
  }
}

// ================= MONITOR =================
async function monitor() {
  const pos = await getPositionViaRest();

  if (!pos || Number(pos.size) <= 0) return;

  const pnl = Number(pos.unrealisedPnl || 0);

  console.log("PnL:", pnl);

  if (pnl <= MAX_LOSS) {
    console.log("MAX LOSS HIT");
    return closePosition(pos.side, pos.size);
  }

  if (pnl >= TAKE_PROFIT) {
    console.log("TAKE PROFIT HIT");
    return closePosition(pos.side, pos.size);
  }
}

// ================= WS =================
function connectPrivateWS() {
  privateWs = new WebSocket(PRIVATE_WS_URL);

  privateWs.on("open", () => {
    const { expires, signature } = generateWsAuth();
    privateWs.send(JSON.stringify({ op: "auth", args: [API_KEY, expires, signature] }));
  });

  privateWs.on("message", async (raw) => {
    const msg = safeJsonParse(raw);
    if (!msg) return;

    if (msg.topic === "position") {
      const pos = msg.data?.[0];
      if (pos?.size > 0) setLatestPosition(pos);
      await monitor();
    }
  });

  privateWs.on("close", () => setTimeout(connectPrivateWS, 3000));
}

// ================= START =================
async function start() {
  console.log("BOT STARTED");
  connectPrivateWS();
}

start();

// ================= WORKER =================
function startTermuxWorker() {
  const worker = spawn("python", ["./termux/worker.py"], {
    stdio: "inherit",
    env: process.env,
  });

  worker.on("close", () => setTimeout(startTermuxWorker, 5000));
}

startTermuxWorker();
