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

# Payment methods the POS records, stored upper-case. Only CASH is physical drawer cash: drawer and
# report queries compare against CASH_METHODS exactly (never a substring: "GCASH" contains "cash").
POS_PAYMENT_METHODS = {"CASH", "GCASH", "CARD"}
CASH_METHODS = {"CASH"}

# Transaction (sale) statuses that mean the sale was voided. Its rows are kept for the audit trail.
VOID_STATUSES = {"cancelled", "rejected"}

# transactions.refund_status: NULL = no money was collected / nothing to return.
REFUND_PENDING = "pending"            # sale voided after its payment was recorded; money not yet returned
REFUND_DONE = "refunded"              # a manager/admin recorded that the money was returned (outside the POS)
REFUND_NOT_REQUIRED = "not_required"  # a manager/admin recorded that nothing had actually been collected
REFUND_STATUSES = {REFUND_PENDING, REFUND_DONE, REFUND_NOT_REQUIRED}

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


def canonical_pos_method(value) -> str:
    """'cash', ' Cash ', 'GCash' -> CASH / GCASH. Anything outside POS_PAYMENT_METHODS is a 400."""
    method = str(value if value is not None else "CASH").strip().upper()
    if method not in POS_PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail="Invalid payment method. Use CASH, GCASH or CARD.")
    return method


def is_cash_method(method: Optional[str]) -> bool:
    return (method or "").strip().upper() in CASH_METHODS


def cash_method_clause(column):
    """SQL predicate: the payment-method column is physical cash (exact match, case/space-insensitive)."""
    from sqlalchemy import func
    return func.upper(func.trim(column)).in_(sorted(CASH_METHODS))


def parse_money(value, field: str, *, allow_zero: bool = True) -> Decimal:
    """
    Strict 2dp money parser for client-supplied amounts (tax, discount, tendered, payment lines).
    More than two decimals is rejected, never rounded, so a value cannot be nudged into a match.
    """
    if isinstance(value, bool) or value is None or (isinstance(value, str) and not value.strip()):
        raise HTTPException(status_code=400, detail=f"Invalid {field}.")
    try:
        raw = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise HTTPException(status_code=400, detail=f"Invalid {field}.")
    if not raw.is_finite():
        raise HTTPException(status_code=400, detail=f"Invalid {field}.")
    amount = raw.quantize(CENT, rounding=ROUND_HALF_UP)
    if amount != raw:
        raise HTTPException(status_code=400, detail=f"{field} can have at most 2 decimal places.")
    if amount < 0 or amount > MAX_MONEY or (amount == 0 and not allow_zero):
        raise HTTPException(status_code=400, detail=f"Invalid {field}.")
    return amount


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


def checkout_fingerprint(*, lines, tax: Decimal, discount: Decimal, status: str, methods,
                         customer_order_id=None, payment_lines=None) -> str:
    """
    Stable digest of the parts of a checkout that define the sale. Lines are merged per product and
    sorted, so item order and split duplicate lines do not change it. Amount tendered on a single-method
    checkout is deliberately excluded (it only affects change), so a retry that fixes the tendered cash is
    still the same checkout. An explicit `payments` list records its amounts, so they are included.
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
    if payment_lines:
        # Key added only when present so fingerprints of existing single-method sales stay unchanged.
        canonical["payment_lines"] = sorted([m.strip().upper(), str(a)] for m, a in payment_lines)
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()
