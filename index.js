import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const MAX_LOSS = parseFloat(process.env.MAX_LOSS) || -40;
const INTERVAL = parseInt(process.env.INTERVAL) || 10000;

const BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = 5000;

function sign(params) {
  const query = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&");

  return crypto
    .createHmac("sha256", API_SECRET)
    .update(query)
    .digest("hex");
}

// 🔍 Get Position
async function getPosition() {
  const timestamp = Date.now();

  const params = {
    api_key: API_KEY,
    timestamp,
    recv_window: RECV_WINDOW,
    category: "linear",
    symbol: SYMBOL,
  };

  params.sign = sign(params);

  const res = await axios.get(`${BASE_URL}/v5/position/list`, { params });

  return res.data.result.list[0];
}

// ❌ Close Position
async function closePosition(side, size) {
  const timestamp = Date.now();

  const params = {
    api_key: API_KEY,
    timestamp,
    recv_window: RECV_WINDOW,
    category: "linear",
    symbol: SYMBOL,
    side: side === "Buy" ? "Sell" : "Buy",
    orderType: "Market",
    qty: size,
    reduceOnly: true,
  };

  params.sign = sign(params);

  const res = await axios.post(`${BASE_URL}/v5/order/create`, params);

  console.log("✅ CLOSED:", res.data);
}

// 🔁 Monitor Loop
async function monitor() {
  try {
    const pos = await getPosition();

    if (!pos || pos.size == 0) {
      console.log("📭 No open position");
      return;
    }

    const pnl = parseFloat(pos.unrealisedPnl);

    console.log(`📊 ${SYMBOL} PnL:`, pnl);

    if (pnl <= MAX_LOSS) {
      console.log("🚨 Max drawdown hit! Closing position...");
      await closePosition(pos.side, pos.size);
    }

  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
  }
}

// 🚀 Start bot
console.log("🤖 Bot started...");
setInterval(monitor, INTERVAL);
