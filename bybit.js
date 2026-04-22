require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");

const API_KEY = process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BYBIT_API_SECRET;

const BASE_URL = "https://api.bybit.com";

function buildSignature(timestamp, recvWindow, payload) {
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(`${timestamp}${API_KEY}${recvWindow}${payload}`)
    .digest("hex");
}

async function bybitRequest(method, path, params = {}, body = {}) {
  const timestamp = String(Date.now());
  const recvWindow = "5000";

  let queryString = "";
  let payload = "";

  if (method === "GET") {
    const search = new URLSearchParams(params);
    queryString = search.toString();
    payload = queryString;
  } else {
    payload = JSON.stringify(body);
  }

  const sign = buildSignature(timestamp, recvWindow, payload);

  const url =
    method === "GET" && queryString
      ? `${BASE_URL}${path}?${queryString}`
      : `${BASE_URL}${path}`;

  const response = await axios({
    method,
    url,
    headers: {
      "X-BAPI-API-KEY": API_KEY,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": sign,
      "Content-Type": "application/json"
    },
    data: method === "GET" ? undefined : body
  });

  const data = response.data;

  if (data.retCode !== 0) {
    throw new Error(`Bybit error ${data.retCode}: ${data.retMsg}`);
  }

  return data.result;
}

async function getUnifiedUsdtSafeAmount() {
  const result = await bybitRequest(
    "GET",
    "/v5/asset/transfer/query-account-coins-balance",
    {
      accountType: "UNIFIED",
      coin: "USDT"
    }
  );

  const list = result.balance?.list || result.list || [];
  const usdt = list.find((x) => x.coin === "USDT") || {};

  const safe =
    Number(
      usdt.transferBalance ??
      usdt.transferSafeAmount ??
      usdt.walletBalance ??
      0
    );

  return {
    raw: usdt,
    safeAmount: safe
  };
}

async function createInternalTransfer({ amount, transferId }) {
  return bybitRequest("POST", "/v5/asset/transfer/inter-transfer", {}, {
    transferId,
    coin: "USDT",
    amount: String(amount),
    fromAccountType: "UNIFIED",
    toAccountType: "FUND"
  });
}

async function getInternalTransferRecords(transferId) {
  return bybitRequest("GET", "/v5/asset/transfer/query-inter-transfer-list", {
    transferId
  });
}

module.exports = {
  getUnifiedUsdtSafeAmount,
  createInternalTransfer,
  getInternalTransferRecords
};
