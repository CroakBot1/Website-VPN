import WebSocket from "ws";
import crypto from "crypto";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// ================= CONFIG =================
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const MAX_LOSS = Number(process.env.MAX_LOSS ?? -0.01);
const TAKE_PROFIT = Number(process.env.TAKE_PROFIT ?? 45);

const WS_URL = "wss://stream.bybit.com/v5/private";
const BASE_URL = "https://api.bybit.com";

// ================= SIGN =================
function sign(timestamp) {
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(timestamp + API_KEY + "5000")
    .digest("hex");
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

    const query = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");

    const signature = crypto
      .createHmac("sha256", API_SECRET)
      .update(query)
      .digest("hex");

    const res = await axios.post(`${BASE_URL}/v5/order/create`, {
      ...params,
      sign: signature,
    });

    console.log("✅ POSITION CLOSED:", res.data);
  } catch (err) {
    console.error("❌ CLOSE ERROR:", err.response?.data || err.message);
  }
}

// ================= WS CONNECT =================
let ws;

function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("🔌 WS Connected");

    const timestamp = Date.now().toString();
    const signature = sign(timestamp);

    // AUTH
    ws.send(
      JSON.stringify({
        op: "auth",
        args: [API_KEY, timestamp, signature],
      })
    );
  });

  ws.on("message", async (data) => {
    const msg = JSON.parse(data);

    // SUCCESS AUTH
    if (msg.op === "auth" && msg.success) {
      console.log("🔐 Authenticated");

      // SUBSCRIBE POSITION
      ws.send(
        JSON.stringify({
          op: "subscribe",
          args: ["position"],
        })
      );
    }

    // POSITION UPDATE
    if (msg.topic === "position") {
      const list = msg.data;

      if (!list || list.length === 0) return;

      const pos = list.find((p) => p.symbol === SYMBOL);
      if (!pos) return;

      const size = Number(pos.size);
      if (size <= 0) {
        console.log("📭 No open position");
        return;
      }

      const pnl = Number(pos.unrealisedPnl || 0);
      const side = pos.side;

      console.log(`📊 ${SYMBOL} PnL: ${pnl}`);

      if (pnl <= MAX_LOSS) {
        console.log(`🚨 MAX LOSS HIT (${MAX_LOSS})`);
        await closePosition(side, size);
      }

      if (pnl >= TAKE_PROFIT) {
        console.log(`🎯 TAKE PROFIT HIT (${TAKE_PROFIT})`);
        await closePosition(side, size);
      }
    }
  });

  ws.on("close", () => {
    console.log("🔌 WS Disconnected. Reconnecting...");
    setTimeout(connectWS, 3000);
  });

  ws.on("error", (err) => {
    console.error("⚠️ WS Error:", err.message);
    ws.close();
  });
}

// ================= START =================
console.log("🤖 WS Bot Running...");
connectWS();
