import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

// ================= CONFIG =================
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const MAX_LOSS = Number(process.env.MAX_LOSS ?? -40); // USDT loss limit
const INTERVAL = Number(process.env.INTERVAL ?? 10000);

const BASE_URL = "https://api.bybit.com";
const RECV_WINDOW = "5000";

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
  }
}

// ================= MONITOR =================
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

  // ================= MAX LOSS RULE =================
  if (pnl <= MAX_LOSS) {
    console.log(`🚨 MAX LOSS HIT (${MAX_LOSS}). Closing position...`);
    await closePosition(side, size);
  }
}

// ================= START BOT =================
console.log("🤖 Bybit Bot Running...");

setInterval(() => {
  monitor().catch((err) =>
    console.error("MONITOR CRASH:", err.message)
  );
}, INTERVAL);
