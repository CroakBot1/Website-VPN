require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const {
  getUnifiedUsdtSafeAmount,
  createInternalTransfer,
  getInternalTransferRecords
} = require("./bybit");

const reserveUsdt = Number(process.env.UTA_RESERVE_USDT || 300);
const minTransferUsdt = Number(process.env.MIN_TRANSFER_USDT || 5);
const lockTtlMs = Number(process.env.TRANSFER_LOCK_TTL_MS || 45000);

let isRunning = false;
let lockUntil = 0;
let lastPendingTransferId = null;

function floorToDecimals(value, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

async function checkPendingTransfer() {
  if (!lastPendingTransferId) return null;

  const result = await getInternalTransferRecords(lastPendingTransferId);
  const records = result.list || result.rows || [];
  const rec = records.find((r) => r.transferId === lastPendingTransferId);

  if (!rec) return { pending: true, status: "UNKNOWN_NOT_FOUND" };

  if (rec.status === "SUCCESS" || rec.status === "FAILED") {
    lastPendingTransferId = null;
  }

  return {
    pending: rec.status === "PENDING",
    status: rec.status
  };
}

async function runReserveSweep() {
  const now = Date.now();

  if (isRunning || now < lockUntil) {
    return { skipped: true, reason: "locked" };
  }

  isRunning = true;
  lockUntil = now + lockTtlMs;

  try {
    const pending = await checkPendingTransfer();
    if (pending?.pending) {
      return {
        skipped: true,
        reason: "previous_transfer_pending",
        status: pending.status
      };
    }

    const balanceInfo = await getUnifiedUsdtSafeAmount();
    const safeAmount = Number(balanceInfo.safeAmount || 0);

    const excess = floorToDecimals(safeAmount - reserveUsdt, 6);

    if (excess < minTransferUsdt) {
      return {
        transferred: false,
        safeAmount,
        reserveUsdt,
        excess,
        reason: "below_min_transfer"
      };
    }

    const transferId = uuidv4();
    const transferResult = await createInternalTransfer({
      amount: excess,
      transferId
    });

    if (transferResult.status === "PENDING") {
      lastPendingTransferId = transferId;
    }

    return {
      transferred: transferResult.status === "SUCCESS" || transferResult.status === "PENDING",
      safeAmount,
      reserveUsdt,
      excess,
      transferId,
      status: transferResult.status
    };
  } finally {
    isRunning = false;
  }
}

module.exports = { runReserveSweep };
