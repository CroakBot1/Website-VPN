// server.js
import express from "express";
import axios from "axios";
import cron from "node-cron";

const app = express();
const PORT = process.env.PORT || 3000;

// === List of URLs to keep alive ===
const urls = [
  "https://api-server-2-dkuk.onrender.com",
  "https://server-validation-expiry.onrender.com",
  "https://paymentserver-wr8h.onrender.com",
  "https://quantum-payment-server-900.onrender.com",
  "https://cronjob-w2t8.onrender.com",
  "https://quantum-payment-server-900-41dk.onrender.com",
  "https://api-server-rg0h.onrender.com",
];

// === Self URL (replace with your deployed link later) ===
const selfUrl = "https://cron-job-links.onrender.com"; // ⚠️ Change this after deployment

// === Function to ping all URLs ===
async function pingServers() {
  console.log(`\n[${new Date().toISOString()}] 🔁 Starting ping cycle...`);
  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 10000 });
      console.log(`✅ ${url} - ${res.status}`);
    } catch (err) {
      console.log(`❌ ${url} - ${err.message}`);
    }
  }
  console.log(`🕒 Ping cycle done.\n`);
}

// === Ping every 5 minutes ===
cron.schedule("*/5 * * * *", pingServers);

// === Self-ping every 10 minutes to stay alive ===
cron.schedule("*/10 * * * *", async () => {
  try {
    const res = await axios.get(selfUrl, { timeout: 10000 });
    console.log(`🔄 Self ping success (${res.status})`);
  } catch (err) {
    console.log(`⚠️ Self ping failed: ${err.message}`);
  }
});

// === Root route ===
app.get("/", (req, res) => {
  res.send("✅ Keep-alive server is running and pinging your servers.");
});

// === Start server ===
app.listen(PORT, () => {
  console.log(`🚀 Keep-alive pinger running on port ${PORT}`);
  pingServers(); // Initial ping right after start
});
