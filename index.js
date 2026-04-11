import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

// ================= CONFIG =================
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

if (!API_KEY || !API_SECRET) {
  throw new Error("❌ Missing API_KEY or API_SECRET in .env");
}

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const MAX_LOSS = Number(process.env.MAX_LOSS ?? -40);
const INTERVAL = Number(process.env.INTERVAL ?? 10000);

const BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";

// ================= KEEP RENDER ALIVE SERVER =================
const app = express();

app.get("/", (req, res) => {
  res.send("🤖 Bybit Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// ================= SIGN FUNCTION =================
function sign(params) {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return crypto
    .createHmac("sha256", API_SECRET)
    .update(query)
    .digest("hex");
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
    return null;
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
      reduceOnly: true,
    };

    const signature = sign(params);

    const res = await axios.post(
      `${BASE_URL}/v5/order/create`,
      { ...params, sign: signature }
    );

    console.log("✅ POSITION CLOSED:", res.data);
  } catch (err) {
    console.error("CLOSE POSITION ERROR:", err.response?.data || err.message);
  }
}

// ================= MONITOR LOOP (SAFE) =================
let running = false;

async function monitor() {
  if (running) return; // prevent overlapping loops
  running = true;

  try {
    const pos = await getPosition();

    if (!pos || Number(pos.size) === 0) {
      console.log("📭 No open position");
      return;
    }

    const pnl = Number(pos.unrealisedPnl || 0);

    console.log(`📊 ${SYMBOL} PnL: ${pnl}`);

    if (pnl <= MAX_LOSS) {
      console.log("🚨 MAX DRAWDOWN HIT. Closing position...");
      await closePosition(pos.side, pos.size);
    }
  } catch (err) {
    console.error("MONITOR ERROR:", err.message);
  } finally {
    running = false;
  }
}

// ================= START BOT =================
console.log("🤖 Bybit Bot Running...");

setInterval(monitor, INTERVAL);
