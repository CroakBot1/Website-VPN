import WebSocket from "ws";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

// ================= CONFIG =================
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const MAX_LOSS = Number(process.env.MAX_LOSS ?? -0.01);
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT ?? 45);

const BASE_URL = "https://api.bybit.com";
const WS_URL = "wss://stream.bybit.com/v5/private";

// ================= SIGN (for auth) =================
function getExpires() {
  return Date.now() + 10000;
}

function sign(params) {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  return crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
}

// ================= CLOSE POSITION =================
async function closePosition(side, size) {
  try {
    const timestamp = Date.now().toString();

    const params = {
      api_key: API_KEY,
      timestamp,
      recv_window: "5000",
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

    console.log("✅ CLOSED:", res.data);
  } catch (err) {
    console.error("CLOSE ERROR:", err.response?.data || err.message);
  }
}

// ================= WEB SOCKET =================
function startWS() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("🔌 WebSocket Connected");

    const expires = getExpires();

    const auth = {
      op: "auth",
      args: [API_KEY, expires, sign({ api_key: API_KEY, expires })],
    };

    ws.send(JSON.stringify(auth));

    // subscribe positions
    ws.send(
      JSON.stringify({
        op: "subscribe",
        args: [`position.linear.${SYMBOL}`],
      })
    );
  });

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (!data.data) return;

      const pos = data.data[0];

      if (!pos || Number(pos.size) <= 0) return;

      const pnl = Number(pos.unrealisedPnl || 0);
      const size = pos.size;
      const side = pos.side;

      console.log(`📊 PnL: ${pnl}`);

      // ================= MAX LOSS =================
      if (pnl <= MAX_LOSS) {
        console.log("🚨 MAX LOSS HIT");
        await closePosition(side, size);
        return;
      }

      // ================= TAKE PROFIT =================
      if (pnl >= TAKE_PROFIT) {
        console.log("🎯 TAKE PROFIT HIT");
        await closePosition(side, size);
        return;
      }
    } catch (err) {
      console.error("WS ERROR:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket Disconnected... reconnecting in 5s");

    setTimeout(() => {
      startWS();
    }, 5000);
  });

  ws.on("error", (err) => {
    console.error("WS ERROR:", err.message);
  });
}

// ================= START =================
console.log("🤖 WebSocket Bot Starting...");
startWS();
