"""
Central runtime configuration, read once from the environment (.env is loaded by app.db before this is used).

Nothing here has a default that is unsafe in production: secrets have no fallback, demo data and API docs are off
when APP_ENV=production unless explicitly enabled.
"""
import os
from typing import List

import app.core.env  # noqa: F401  (loads .env before anything below is read)

VALID_ENVS = {"development", "test", "staging", "production"}


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    try:
        return int(raw) if raw not in (None, "") else default
    except ValueError:
        raise RuntimeError(f"Environment variable {name} must be an integer.")


# A missing APP_ENV means production: demo data, default CORS origins and API docs must never switch on by accident
# on a server. Local development opts in with APP_ENV=development in fastapi/.env (see .env.example).
APP_ENV = (os.getenv("APP_ENV") or "production").strip().lower()
if APP_ENV not in VALID_ENVS:
    raise RuntimeError(f"APP_ENV must be one of {sorted(VALID_ENVS)}, got '{APP_ENV}'.")

IS_PRODUCTION = APP_ENV == "production"

# Demo accounts (admin/admin123, cashier/cashier123 ...), the official menu and default suppliers.
SEED_DEMO_DATA = _bool("SEED_DEMO_DATA", default=not IS_PRODUCTION and APP_ENV != "test")

# Interactive API docs (/docs, /redoc, /openapi.json).
ENABLE_API_DOCS = _bool("ENABLE_API_DOCS", default=not IS_PRODUCTION)

# Comma-separated list of browser origins allowed to call the API cross-origin. The bundled frontend is served
# from the same origin, so production normally needs no extra origins at all.
_default_origins = "" if IS_PRODUCTION else "http://localhost:8000,http://127.0.0.1:8000"
CORS_ALLOWED_ORIGINS: List[str] = [
    o.strip().rstrip("/") for o in (os.getenv("CORS_ALLOWED_ORIGINS", _default_origins) or "").split(",") if o.strip()
]
if "*" in CORS_ALLOWED_ORIGINS:
    raise RuntimeError("CORS_ALLOWED_ORIGINS must list explicit origins; '*' is not allowed.")

# Business timezone used for "today", shift reports and the kitchen clock. Timestamps are stored in UTC.
BUSINESS_TIMEZONE = os.getenv("BUSINESS_TIMEZONE", "Asia/Manila")

# Sales tax applied server-side to the item subtotal (e.g. 0.12 for 12% VAT). Prices are VAT-inclusive by default.
TAX_RATE = os.getenv("TAX_RATE", "0")

# Login throttling.
LOGIN_MAX_FAILED_ATTEMPTS = _int("LOGIN_MAX_FAILED_ATTEMPTS", 5)        # per account, then cooldown
LOGIN_LOCKOUT_MINUTES = _int("LOGIN_LOCKOUT_MINUTES", 15)
LOGIN_MAX_ATTEMPTS_PER_IP = _int("LOGIN_MAX_ATTEMPTS_PER_IP", 20)      # failed attempts per IP per window
LOGIN_IP_WINDOW_MINUTES = _int("LOGIN_IP_WINDOW_MINUTES", 15)

# Public customer ordering limits.
CUSTOMER_ORDER_MAX_ITEMS = _int("CUSTOMER_ORDER_MAX_ITEMS", 30)
CUSTOMER_ORDER_MAX_QUANTITY = _int("CUSTOMER_ORDER_MAX_QUANTITY", 50)
CUSTOMER_ORDERS_PER_IP_PER_10_MIN = _int("CUSTOMER_ORDERS_PER_IP_PER_10_MIN", 10)

# Upper bound for one POS line quantity.
POS_MAX_LINE_QUANTITY = _int("POS_MAX_LINE_QUANTITY", 999)

# Product images stored inline as data URLs (there is no persistent file storage on the free hosting plan).
PRODUCT_IMAGE_MAX_BYTES = _int("PRODUCT_IMAGE_MAX_BYTES", 300 * 1024)

# Activity log retention: the purge endpoint never deletes entries younger than this.
ACTIVITY_LOG_MIN_RETENTION_DAYS = _int("ACTIVITY_LOG_MIN_RETENTION_DAYS", 90)

PASSWORD_MIN_LENGTH = _int("PASSWORD_MIN_LENGTH", 10)
