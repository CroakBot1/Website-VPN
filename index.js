import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

// ================= CONFIG =================
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const MAX_LOSS = Number(process.env.MAX_LOSS ?? -0.005);
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT ?? 45);
const INTERVAL = Number(process.env.INTERVAL ?? 2000);

const BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";

// ================= SIGN FUNCTION =================
function sign(params) {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
}

// ================= GET POSITION =================
async function getPosition() {
  try {
    const timestamp = Date.now().toString();

    const params = {
      api_key: API_KEY,
      timestamp,
      recv_window: RECV_WINDOW,
      category: "linear",
      symbol: SYMBOL,
    };

    const signature = sign(params);

    const res = await axios.get(`${BASE_URL}/v5/position/list`, {
      params: { ...params, sign: signature },
    });

    const list = res?.data?.result?.list;
    if (!list || list.length === 0) return null;

    return list[0];
  } catch (err) {
    console.error("GET POSITION ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ================= CLOSE POSITION =================
async function closePosition(side, size) {
  try {
    const timestamp = Date.now().toString();

    const params = {
      api_key: API_KEY,
      timestamp,
      recv_window: RECV_WINDOW,
      category: "linear",
      symbol: SYMBOL,
      side: side === "Buy" ? "Sell" : "Buy",
      orderType: "Market",
      qty: String(size),
      timeInForce: "IOC",
    };

    const signature = sign(params);

    const res = await axios.post(`${BASE_URL}/v5/order/create`, {
      ...params,
      sign: signature,
    });

    console.log("✅ POSITION CLOSED:", res.data);
  } catch (err) {
    console.error("CLOSE POSITION ERROR:", err.response?.data || err.message);
    throw err;
  }
}

// ================= MONITOR (UNCHANGED LOGIC) =================
async function monitor() {
  const pos = await getPosition();

  if (!pos || Number(pos.size) <= 0) {
    console.log("📭 No open position");
    return;
  }

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

// ================= TRUE AUTO RECONNECT ENGINE =================

let running = true;
let isExecuting = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// global crash protection (IMPORTANT)
process.on("unhandledRejection", (err) => {
  console.error("🔥 UNHANDLED REJECTION:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT EXCEPTION:", err.message);
});

// ================= MAIN DAEMON LOOP =================
async function startBot() {
  console.log("🤖 TRUE AUTO RECONNECT BOT STARTED...");

  let retry = 0;

  while (running) {
    try {
      if (isExecuting) {
        await sleep(200); // prevent overlap
        continue;
      }

      isExecuting = true;

      await monitor(); // 🔥 YOUR ORIGINAL LOGIC

      isExecuting = false;

      retry = 0;

      await sleep(INTERVAL);
    } catch (err) {
      isExecuting = false;

      const status = err.response?.status;

      // ================= RATE LIMIT =================
      if (status === 429) {
        console.log("⛔ RATE LIMIT → cooling down 5s");
        await sleep(5000);
        continue;
      }

      // ================= NETWORK / API ERROR =================
      const wait = Math.min(30000, 2000 * Math.pow(2, retry));

      console.log(`⚠️ ERROR → auto-reconnect in ${wait}ms`, err.message);

      await sleep(wait);

      retry++;

      // HARD RESET MODE (true reconnect behavior)
      if (retry > 10) {
        console.log("🔄 HARD RECONNECT RESET...");
        retry = 0;
        await sleep(5000);
      }
    }
  }
}

// ================= START =================
startBot();
