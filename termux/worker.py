import os
import uuid
import traceback
import time
from decimal import Decimal, ROUND_DOWN
from datetime import datetime
from pybit.unified_trading import HTTP

# ================= CONFIG =================
MODE = os.getenv("BYBIT_MODE", "live").strip().lower()
TESTNET = MODE != "live"

# ✅ FIXED ENV KEYS (IMPORTANT)
API_KEY = os.getenv("API_KEY", "")
API_SECRET = os.getenv("API_SECRET", "")

COIN = "USDT"

RESERVE_USDT = Decimal(os.getenv("RESERVE_USDT", "250"))
MIN_TRANSFER_USDT = Decimal(os.getenv("MIN_TRANSFER_USDT", "1"))
POSITION_TOPUP_USDT = Decimal(os.getenv("POSITION_TOPUP_USDT", "50"))
LOSS_CLOSE_USDT = Decimal(os.getenv("LOSS_CLOSE_USDT", "40"))
BOT_SLEEP_SEC = int(os.getenv("BOT_SLEEP_SEC", "15"))

POSITION_LOCK_FILE = os.getenv(
    "POSITION_LOCK_FILE",
    os.path.expanduser("~/.bybit_position_topup.lock")
)

# ================= SAFETY CHECK =================
if not API_KEY or not API_SECRET:
    raise SystemExit("❌ Missing API credentials (API_KEY / API_SECRET)")

session = HTTP(
    testnet=TESTNET,
    api_key=API_KEY,
    api_secret=API_SECRET
)

# ================= UTIL =================
def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

def D(x):
    try:
        return Decimal(str(x))
    except:
        return Decimal("0")

def q2(x):
    return x.quantize(Decimal("0.01"), rounding=ROUND_DOWN)

def lock_exists():
    return os.path.exists(POSITION_LOCK_FILE)

def create_lock():
    try:
        with open(POSITION_LOCK_FILE, "w") as f:
            f.write(str(datetime.now()))
    except Exception as e:
        log(f"LOCK ERROR: {e}")

def clear_lock():
    try:
        if lock_exists():
            os.remove(POSITION_LOCK_FILE)
    except Exception as e:
        log(f"CLEAR LOCK ERROR: {e}")

# ================= SAFE BYBIT CALLS =================
def get_positions():
    try:
        resp = session.get_positions(category="linear", settleCoin="USDT")

        if resp.get("retCode", 0) != 0:
            log(f"BYBIT ERROR: {resp}")
            return []

        return resp.get("result", {}).get("list", [])
    except Exception as e:
        log(f"get_positions crash: {e}")
        return []

def close_position(symbol, side, size):
    try:
        close_side = "Sell" if side == "Buy" else "Buy"

        session.place_order(
            category="linear",
            symbol=symbol,
            side=close_side,
            orderType="Market",
            qty=str(size),
            reduceOnly=True
        )

        log(f"❌ CLOSED POSITION {symbol} {side} size={size}")

    except Exception as e:
        log(f"CLOSE ERROR {symbol}: {e}")

def get_wallet():
    try:
        resp = session.get_wallet_balance(accountType="UNIFIED", coin=COIN)

        coins = resp.get("result", {}).get("list", [])[0].get("coin", [])

        for c in coins:
            if c.get("coin") == COIN:
                return D(c.get("walletBalance"))

    except Exception as e:
        log(f"WALLET ERROR: {e}")

    return Decimal("0")

def transfer(from_acc, to_acc, amount):
    try:
        session.create_internal_transfer(
            transferId=str(uuid.uuid4()),
            coin=COIN,
            amount=str(amount),
            fromAccountType=from_acc,
            toAccountType=to_acc
        )
        log(f"💸 TRANSFER {amount} {from_acc} -> {to_acc}")

    except Exception as e:
        log(f"TRANSFER ERROR: {e}")

# ================= LOGIC =================
def run_cycle():
    try:
        positions = get_positions()
        open_positions = [p for p in positions if float(p.get("size", 0)) > 0]

        # ===== LOSS CHECK =====
        for p in open_positions:
            pnl = D(p.get("unrealisedPnl", 0))

            if pnl <= -LOSS_CLOSE_USDT:
                log(f"🚨 LOSS HIT {p.get('symbol')} pnl={pnl}")
                close_position(p.get("symbol"), p.get("side"), p.get("size"))

        # ===== TRANSFER OUT =====
        if not open_positions:
            wallet = get_wallet()
            excess = wallet - RESERVE_USDT

            if excess > MIN_TRANSFER_USDT:
                transfer("UNIFIED", "FUND", q2(excess))
                log(f"💰 TRANSFER OUT {excess}")

        # ===== TOPUP =====
        if open_positions and not lock_exists():
            fund = get_wallet()

            if fund >= POSITION_TOPUP_USDT:
                transfer("FUND", "UNIFIED", POSITION_TOPUP_USDT)
                create_lock()
                log("🔐 TOPUP DONE + LOCK CREATED")

    except Exception as e:
        log(f"RUN CYCLE ERROR: {e}")
        traceback.print_exc()

# ================= LOOP =================
log("🧠 TERMUX WORKER STARTED (FIXED VERSION)")

while True:
    run_cycle()
    time.sleep(BOT_SLEEP_SEC)
