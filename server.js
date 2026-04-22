require("dotenv").config();
const express = require("express");
const { runReserveSweep } = require("./transfer-manager");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "bybit-uta-reserve-bot" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post("/run-sweep", async (_req, res) => {
  try {
    const result = await runReserveSweep();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || "Unknown error"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});

const intervalMs = Number(process.env.CHECK_INTERVAL_MS || 60000);
setInterval(async () => {
  try {
    const result = await runReserveSweep();
    console.log("[SWEEP]", result);
  } catch (err) {
    console.error("[SWEEP ERROR]", err.message);
  }
}, intervalMs);
