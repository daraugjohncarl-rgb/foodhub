"""
Payment rules shared by the POS and customer-order routers.

Manual GCash policy (no payment gateway is involved):
  * The customer pays by scanning the store's GCash QR at the counter.
  * The cashier reads the GCash transaction history and TYPES the amount received (and the reference
    number, when available). The system compares that typed amount with the server-computed amount due.
  * A match means "the cashier reports exactly the amount due". It is NOT independent proof that GCash
    received the money.

Customer-order payment_status values (independent of the fulfilment `status`):

    unpaid        nothing recorded yet. For a GCASH order this is "GCash verification pending".
    verified      GCash order: cashier-reported amount matched the amount due exactly.
    discrepancy   GCash order: reported amount did not match; blocks progression until resolved.
    invalid       GCash order: a manager/admin closed a discrepancy as "payment not valid".
    counter_paid  A POS sale settling the order was recorded at the counter.

Allowed transitions (anything else is rejected with 409):

    unpaid       -> verified | discrepancy | counter_paid
    discrepancy  -> verified | discrepancy | invalid
    verified     -> (final for verification; the sale then reuses it)
    invalid      -> (final)
    counter_paid -> (final)
"""
import hashlib
import json
import re
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Optional

from fastapi import HTTPException

CENT = Decimal("0.01")
MAX_MONEY = Decimal("99999999.99")  # Numeric(10, 2) ceiling

PAYMENT_GCASH = "GCASH"
PAYMENT_AT_COUNTER = "PAY_AT_COUNTER"
CUSTOMER_PAYMENT_METHODS = {PAYMENT_GCASH, PAYMENT_AT_COUNTER}

PS_UNPAID = "unpaid"
PS_VERIFIED = "verified"
PS_DISCREPANCY = "discrepancy"
PS_INVALID = "invalid"
PS_COUNTER_PAID = "counter_paid"
PAYMENT_STATUSES = {PS_UNPAID, PS_VERIFIED, PS_DISCREPANCY, PS_INVALID, PS_COUNTER_PAID}

PAYMENT_TRANSITIONS = {
    PS_UNPAID: {PS_VERIFIED, PS_DISCREPANCY, PS_COUNTER_PAID},
    PS_DISCREPANCY: {PS_VERIFIED, PS_DISCREPANCY, PS_INVALID},
    PS_VERIFIED: set(),
    PS_INVALID: set(),
    PS_COUNTER_PAID: set(),
}

# Fulfilment moves that are blocked while a GCash payment is in dispute (rejecting stays possible).
BLOCKED_WHILE_DISPUTED = {"accepted", "preparing", "ready", "completed"}
DISPUTED_STATUSES = {PS_DISCREPANCY, PS_INVALID}

# Methods a cashier may use to settle a PAY_AT_COUNTER order at the till.
COUNTER_SETTLEMENT_METHODS = {"CASH", "CARD"}

REFERENCE_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-_./]{3,39}$")

OUTCOME_MATCHED = "matched"
OUTCOME_MISMATCH = "mismatch"
OUTCOME_DUPLICATE = "duplicate_reference"


def normalize_payment_method(value: Optional[str]) -> Optional[str]:
    """Customer-facing choice: accept 'gcash', 'GCash', 'pay at counter', 'pay-at-counter' ..."""
    if value is None:
        return None
    cleaned = re.sub(r"[\s\-]+", "_", str(value).strip().upper())
    return cleaned or None


def parse_reported_amount(value) -> Decimal:
    """
    Parse the amount a cashier typed. Stricter than the sale-line parser: more than two decimals is
    rejected instead of rounded, because rounding 149.999 to 150.00 would fake an exact match.
    """
    if isinstance(value, bool) or value is None or (isinstance(value, str) and not value.strip()):
        raise HTTPException(status_code=400, detail="Enter the amount received.")
    try:
        raw = Decimal(str(value).strip().replace(",", ""))
    except (InvalidOperation, ValueError):
        raise HTTPException(status_code=400, detail="Invalid amount received.")
    if not raw.is_finite():
        raise HTTPException(status_code=400, detail="Invalid amount received.")
    amount = raw.quantize(CENT, rounding=ROUND_HALF_UP)
    if amount != raw:
        raise HTTPException(status_code=400, detail="Amount received can have at most 2 decimal places.")
    if amount <= 0 or amount > MAX_MONEY:
        raise HTTPException(status_code=400, detail="Amount received is out of range.")
    return amount


def normalize_reference(value) -> Optional[str]:
    """Trim, upper-case and drop whitespace (GCash shows refs as '1234 567 890 123'). Keeps - _ . /."""
    if value is None:
        return None
    cleaned = re.sub(r"\s+", "", str(value)).upper()
    if not cleaned:
        return None
    if not REFERENCE_RE.match(cleaned):
        raise HTTPException(status_code=400, detail="Invalid GCash reference number.")
    return cleaned


def parse_transaction_time(value) -> Optional[datetime]:
    """Optional time copied from the GCash history. Stored as typed (naive); never trusted for decisions."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid transaction time.")
    parsed = parsed.replace(tzinfo=None)
    if parsed > datetime.now().replace(microsecond=0) + timedelta(days=1):
        raise HTTPException(status_code=400, detail="Transaction time cannot be in the future.")
    return parsed


def amount_due_for_customer_order(order) -> Decimal:
    """
    Authoritative amount due for an online order: the sum of the item prices the SERVER stored when the
    order was placed (online orders carry no tax or discount). Never taken from a client request.
    """
    total = sum((Decimal(str(i.price)) * i.quantity for i in order.items), Decimal("0.00")).quantize(CENT, rounding=ROUND_HALF_UP)
    stored = Decimal(str(order.total_amount)).quantize(CENT, rounding=ROUND_HALF_UP)
    if total != stored:
        raise HTTPException(status_code=409, detail="This order's total is inconsistent. Ask a manager to review it before taking payment.")
    return total


def checkout_fingerprint(*, lines, tax: Decimal, discount: Decimal, status: str, methods, customer_order_id=None) -> str:
    """
    Stable digest of the parts of a checkout that define the sale. Amount tendered is deliberately
    excluded (it only affects change), so a retry that fixes the tendered cash is still the same checkout.
    """
    merged = {}
    for product_id, qty in lines:
        merged[product_id] = merged.get(product_id, 0) + qty
    canonical = {
        "lines": sorted(merged.items()),
        "tax": str(tax),
        "discount": str(discount),
        "status": status,
        "methods": sorted(m.strip().upper() for m in methods),
        "customer_order_id": customer_order_id,
    }
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()
