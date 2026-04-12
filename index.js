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

// ================= STATE =================
let ws;
let isClosing = false;

// ================= SIGN (WS AUTH) =================
function wsSign(timestamp) {
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(timestamp + API_KEY + "5000")
    .digest("hex");
}

// ================= SIGN (ORDER V5 FIXED) =================
function orderSign(timestamp, body) {
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(timestamp + API_KEY + "5000" + body)
    .digest("hex");
}

// ================= CLOSE POSITION =================
async function closePosition(side, size) {
  if (isClosing) return; // prevent double close
  isClosing = true;

  try {
    const timestamp = Date.now().toString();

    const params = {
      category: "linear",
      symbol: SYMBOL,
      side: side === "Buy" ? "Sell" : "Buy",
      orderType: "Market",
      qty: String(size),
      timeInForce: "IOC"
    };

    const body = JSON.stringify(params);

    const signature = orderSign(timestamp, body);

    const res = await axios.post(
      `${BASE_URL}/v5/order/create`,
      params,
      {
        headers: {
          "X-BAPI-API-KEY": API_KEY,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": "5000",
          "X-BAPI-SIGN": signature,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ POSITION CLOSED:", res.data);
  } catch (err) {
    console.error("❌ CLOSE ERROR:", err.response?.data || err.message);
  } finally {
    setTimeout(() => (isClosing = false), 3000);
  }
}

// ================= WS CONNECT =================
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("🔌 WS Connected");

    const timestamp = Date.now().toString();
    const signature = wsSign(timestamp);

    ws.send(
      JSON.stringify({
        op: "auth",
        args: [API_KEY, timestamp, signature]
      })
    );
  });

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    // ================= AUTH =================
    if (msg.op === "auth" && msg.success) {
      console.log("🔐 Authenticated");

      ws.send(
        JSON.stringify({
          op: "subscribe",
          args: ["position"]
        })
      );
    }

    // ================= POSITION DATA =================
    if (msg.topic === "position") {
      const list = msg.data?.list || msg.data;
      if (!list) return;

      const pos = list.find((p) => p.symbol === SYMBOL);
      if (!pos) return;

      const size = Number(pos.size);
      if (size <= 0) return;

      const pnl = Number(pos.unrealisedPnl ?? pos.unrealisedPnlE6 ?? 0);
      const side = pos.side;

      console.log(`📊 ${SYMBOL} PnL: ${pnl}`);

      // ================= RISK RULES =================
      if (pnl <= MAX_LOSS) {
        console.log(`🚨 MAX LOSS HIT: ${pnl}`);
        await closePosition(side, size);
      }

      if (pnl >= TAKE_PROFIT) {
        console.log(`🎯 TAKE PROFIT HIT: ${pnl}`);
        await closePosition(side, size);
      }
    }
  });

  ws.on("close", () => {
    console.log("🔌 WS Disconnected → reconnecting...");
    setTimeout(connectWS, 3000);
  });

  ws.on("error", (err) => {
    console.error("⚠️ WS Error:", err.message);
    ws.close();
  });
}

// ================= START =================
console.log("🤖 Bybit WS Bot Running (FIXED VERSION)");
connectWS();
