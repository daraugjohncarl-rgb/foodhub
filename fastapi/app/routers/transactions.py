"""
Transactions & POS Router
=========================
Handles POS transaction checkout, payment processing, and transaction retrieval.

A sale may settle an online (QR) customer order by sending `customer_order_id`. In that case the
server, not the browser, supplies the lines and prices, enforces the order's payment rules (manual
GCash verification / counter payment), links the sale to the order (at most one sale per order) and
updates the order, all in ONE database transaction.
"""
import logging
import os
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.db import get_db
import app.models as models
from app.core.dependencies import require_pos_access, require_manager_or_admin, resolve_tenant_id
from app.services import payments as pay
from app.services import stock

logger = logging.getLogger("pos_transactions")

router = APIRouter(prefix="/transactions", tags=["POS — Transactions"])

MAX_LINE_QUANTITY = 100
MAX_LINES = 100
MAX_MONEY = Decimal("99999999.99")  # Numeric(10, 2) ceiling
CENT = Decimal("0.01")
CREATE_STATUSES = {"pending", "completed"}
MAX_PAYMENT_METHOD_LENGTH = 50
AUDIT_ROLES = {models.UserRole.MANAGER, models.UserRole.ADMIN, models.UserRole.SUPER_ADMIN}

# BUSINESS DECISION PENDING: the cashier UI never opens a shift explicitly, so a sale with no open
# shift auto-opens one with start_cash = 0 (previous behaviour). Set AUTO_OPEN_SHIFT=false once the
# UI forces a drawer count first; sales will then be rejected until /shifts/start is called.
AUTO_OPEN_SHIFT = os.getenv("AUTO_OPEN_SHIFT", "true").strip().lower() not in ("0", "false", "no", "off")

# BUSINESS DECISION PENDING (who may void a sale): every POS role may void, as before. Set
# VOID_REQUIRES_MANAGER=true to restrict voids to MANAGER/ADMIN/SUPER_ADMIN once the owner decides.
VOID_REQUIRES_MANAGER = os.getenv("VOID_REQUIRES_MANAGER", "false").strip().lower() in ("1", "true", "yes", "on")

# Preparation progress that a sale-status request may record: fulfilment only, never the financial status.
FULFILMENT_ONLY_STATUSES = {"preparing", "ready"}
MIN_VOID_REASON = 3


def _money(value, field: str, *, allow_zero: bool = True) -> Decimal:
    """Client-supplied money: 2dp Decimal, never via float arithmetic; more decimals are rejected, not rounded."""
    return pay.parse_money(value, field, allow_zero=allow_zero)


def _quantity(value) -> int:
    if isinstance(value, bool):
        raise HTTPException(status_code=400, detail="Invalid quantity.")
    try:
        if isinstance(value, float) and not value.is_integer():
            raise ValueError
        qty = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid quantity.")
    if qty < 1 or qty > MAX_LINE_QUANTITY:
        raise HTTPException(status_code=400, detail=f"Quantity must be between 1 and {MAX_LINE_QUANTITY}.")
    return qty


def _is_cash(method: str) -> bool:
    # Exact method match, never a substring: "GCASH" contains "cash" but is not cash in the drawer.
    return pay.is_cash_method(method)


def _serialize_tx(tx: models.Transaction, *, detail: bool, audit: bool = False) -> dict:
    """`audit` (manager/admin only) adds the GCash reference and the verifying employee."""
    payments = []
    for p in tx.payments:
        row = {
            "id": p.id,
            "payment_method": p.payment_method,
            "amount": float(p.amount),
            "status": p.status,
            # Cashier-reported GCash verification; never presented as confirmed by GCash itself.
            "verification": "cashier_verified" if p.verified_at else None,
        }
        if audit and p.verified_at:
            row["reference_no"] = p.reference_no
            row["amount_received"] = float(p.amount_received) if p.amount_received is not None else None
            row["verified_by"] = p.verified_by
            row["verified_at"] = p.verified_at.isoformat()
        payments.append(row)
    data = {
        "id": tx.id,
        "order_code": f"TXN-{tx.id:04d}",
        "receipt_no": f"TXN-{tx.id:04d}",
        "client_tx_id": tx.client_tx_id,
        "tenant_id": tx.tenant_id,
        "shift_id": tx.shift_id,
        "user_id": tx.user_id,
        "customer_order_id": tx.customer_order_id,
        "cashier": tx.user.username if tx.user else "Staff",
        "total_amount": float(tx.total_amount),
        "tax_amount": float(tx.tax_amount),
        "discount_amount": float(tx.discount_amount),
        "net_amount": float(tx.net_amount),
        "status": tx.status,
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
        "voided_at": tx.voided_at.isoformat() if tx.voided_at else None,
        "void_reason": tx.void_reason,
        "refund_status": tx.refund_status,
        "items": [
            {
                "id": it.id,
                "product_id": it.product_id,
                "name": it.product.name if it.product else f"Item #{it.product_id}",
                "quantity": it.quantity,
                "unit_price": float(it.unit_price),
                "total_price": float(it.total_price)
            }
            for it in tx.items
        ],
        "payments": payments,
    }
    if detail:
        data["fulfillment_status"] = tx.fulfillment_status
    if audit:
        data["voided_by"] = tx.voided_by
    return data


def _sale_lines(tx: models.Transaction) -> dict:
    """Committed lines and payments, so receipts are printed from what was saved, not from the browser cart."""
    return {
        "items": [{
            "product_id": it.product_id,
            "name": it.product.name if it.product else f"Item #{it.product_id}",
            "quantity": it.quantity,
            "unit_price": float(it.unit_price),
            "total_price": float(it.total_price),
        } for it in tx.items],
        "payments": [{"payment_method": p.payment_method, "amount": float(p.amount), "status": p.status}
                     for p in tx.payments],
    }


@router.get("", summary="List transactions for the user's tenant")
def list_transactions(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    tenant_id = resolve_tenant_id(current_user, db, request)
    transactions = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product),
        joinedload(models.Transaction.payments),
        joinedload(models.Transaction.user)
    ).filter(
        models.Transaction.tenant_id == tenant_id
    ).order_by(models.Transaction.created_at.desc()).offset(offset).limit(limit).all()

    audit = current_user.role in AUDIT_ROLES
    return [_serialize_tx(tx, detail=False, audit=audit) for tx in transactions]


@router.get("/{tx_id}", summary="Get transaction details by ID")
def get_transaction(
    tx_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    tenant_id = resolve_tenant_id(current_user, db, request)
    tx = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product),
        joinedload(models.Transaction.payments),
        joinedload(models.Transaction.user)
    ).filter(
        models.Transaction.id == tx_id,
        models.Transaction.tenant_id == tenant_id
    ).first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    return _serialize_tx(tx, detail=True, audit=current_user.role in AUDIT_ROLES)


def _existing_tx_response(existing_tx: models.Transaction, message: str = "Transaction already processed.") -> dict:
    """The original result, returned unchanged when the same checkout is repeated."""
    return {
        "id": existing_tx.id,
        "order_code": f"TXN-{existing_tx.id:04d}",
        "receipt_no": f"TXN-{existing_tx.id:04d}",
        "client_tx_id": existing_tx.client_tx_id,
        "customer_order_id": existing_tx.customer_order_id,
        "total_amount": float(existing_tx.total_amount),
        "tax_amount": float(existing_tx.tax_amount),
        "discount_amount": float(existing_tx.discount_amount),
        "net_amount": float(existing_tx.net_amount),
        "status": existing_tx.status,
        "created_at": existing_tx.created_at.isoformat() if existing_tx.created_at else None,
        **_sale_lines(existing_tx),
        "idempotent_replay": True,
        "message": message
    }


def _replay_or_conflict(existing_tx: models.Transaction, fingerprint: str) -> dict:
    """Same key + same checkout -> original result. Same key + different checkout -> 409."""
    if existing_tx.request_fingerprint and existing_tx.request_fingerprint != fingerprint:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This checkout reference was already used for a different order. Refresh the POS and try again."
        )
    return _existing_tx_response(existing_tx)


def _requested_methods(body: dict) -> list:
    """Payment method names the request asks for (used only for the idempotency fingerprint)."""
    rows = body.get("payments")
    if isinstance(rows, list) and rows:
        return [str((r or {}).get("payment_method") or "CASH") if isinstance(r, dict) else "CASH" for r in rows]
    return [str(body.get("payment_method") or "CASH")]


def _fingerprint_payment_lines(body: dict):
    """(method, amount) pairs of an explicit payments list, normalised for the idempotency fingerprint."""
    rows = body.get("payments")
    if not isinstance(rows, list) or not rows:
        return None
    lines = []
    for r in rows:
        if not isinstance(r, dict):
            return None
        try:
            amount = str(Decimal(str(r["amount"])).quantize(CENT)) if r.get("amount") is not None else "due"
        except (InvalidOperation, ValueError, TypeError):
            amount = "invalid"
        lines.append((str(r.get("payment_method") or "CASH"), amount))
    return lines


def _check_payment_method(method) -> str:
    """CASH / GCASH / CARD (case-insensitive input, stored upper-case). Anything else is a 400."""
    if method is not None and not isinstance(method, str):
        raise HTTPException(status_code=400, detail="Invalid payment method.")
    return pay.canonical_pos_method(method if method and method.strip() else None)


def _payment_list(payments_data, net_amount: Decimal) -> list:
    """
    An explicit payments list records APPLIED amounts (change is never recorded), so the lines must add up
    to exactly the amount due: more would inflate drawer and income figures, less would under-collect.
    """
    if not isinstance(payments_data, list) or len(payments_data) > 10:
        raise HTTPException(status_code=400, detail="Invalid payments.")
    rows = []
    for p in payments_data:
        if not isinstance(p, dict):
            raise HTTPException(status_code=400, detail="Invalid payment.")
        rows.append((_check_payment_method(p.get("payment_method")),
                     _money(p.get("amount", net_amount), "payment amount", allow_zero=False)))
    if sum(a for _, a in rows) != net_amount:
        raise HTTPException(status_code=400, detail="Payment lines must add up to exactly the amount due.")
    return rows


def _load_customer_order_for_sale(db: Session, tenant_id: int, order_id: int) -> models.CustomerOrder:
    """Lock the order row (PostgreSQL/MySQL) so two cashiers cannot settle it at the same time."""
    # selectinload (not joinedload): PostgreSQL rejects FOR UPDATE on the nullable side of an outer join.
    order = db.query(models.CustomerOrder).options(
        selectinload(models.CustomerOrder.items)
    ).filter(
        models.CustomerOrder.id == order_id,
        models.CustomerOrder.tenant_id == tenant_id
    ).with_for_update().first()
    if not order:
        raise HTTPException(status_code=404, detail="Customer order not found.")
    return order


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a new POS transaction")
def create_transaction(
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    tenant_id = resolve_tenant_id(current_user, db, request)

    # --- Validate input before touching the database -------------------------------------------
    order_id = body.get("customer_order_id")
    if order_id is not None:
        if isinstance(order_id, bool) or (isinstance(order_id, float) and not order_id.is_integer()):
            raise HTTPException(status_code=400, detail="Invalid customer_order_id.")
        try:
            order_id = int(order_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid customer_order_id.")
        if order_id < 1:
            raise HTTPException(status_code=400, detail="Invalid customer_order_id.")

    parsed_lines = []
    if order_id is None:
        items_data = body.get("items")
        if not isinstance(items_data, list) or not items_data:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transaction must contain at least 1 item.")
        if len(items_data) > MAX_LINES:
            raise HTTPException(status_code=400, detail=f"A transaction can contain at most {MAX_LINES} lines.")
        for item in items_data:
            if not isinstance(item, dict):
                raise HTTPException(status_code=400, detail="Invalid item.")
            try:
                prod_id = int(item.get("product_id"))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Invalid product_id.")
            parsed_lines.append((prod_id, _quantity(item.get("quantity", 1))))

    tax_amount = _money(body.get("tax_amount", 0), "tax_amount")
    discount_amount = _money(body.get("discount_amount", 0), "discount_amount")
    if order_id is not None and (tax_amount or discount_amount):
        # The amount due for an online order is what the customer was quoted (and, for GCash, paid).
        raise HTTPException(status_code=400, detail="Tax and discount cannot be applied to an online order sale.")

    tx_status = str(body.get("status") or "completed").strip().lower()
    if tx_status not in CREATE_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid status.")
    if order_id is not None and tx_status != "completed":
        raise HTTPException(status_code=400, detail="An online order sale must be recorded as completed.")

    client_tx_id = body.get("client_tx_id")
    if client_tx_id is not None:
        client_tx_id = str(client_tx_id).strip()
        if not client_tx_id or len(client_tx_id) > 36:
            raise HTTPException(status_code=400, detail="Invalid client_tx_id.")

    fingerprint = pay.checkout_fingerprint(
        lines=parsed_lines, tax=tax_amount, discount=discount_amount, status=tx_status,
        methods=[] if order_id is not None else _requested_methods(body), customer_order_id=order_id,
        payment_lines=None if order_id is not None else _fingerprint_payment_lines(body),
    )

    # --- Idempotency: a repeated submission returns the original transaction -------------------
    if client_tx_id:
        existing_tx = db.query(models.Transaction).filter(
            models.Transaction.client_tx_id == client_tx_id,
            models.Transaction.tenant_id == tenant_id
        ).first()
        if existing_tx:
            return _replay_or_conflict(existing_tx, fingerprint)
    else:
        client_tx_id = str(uuid.uuid4())

    # --- Online order: one sale per order, payment rules enforced by the server ---------------
    order = None
    order_status_before = None
    verification = None
    if order_id is not None:
        order = _load_customer_order_for_sale(db, tenant_id, order_id)
        order_status_before = order.status
        linked = db.query(models.Transaction).filter(
            models.Transaction.tenant_id == tenant_id,
            models.Transaction.customer_order_id == order.id
        ).first()
        if linked:
            return _resume_linked_order(db, order, linked, tenant_id, current_user)
        if order.status == "rejected":
            raise HTTPException(status_code=409, detail="This order was rejected and cannot be paid.")
        parsed_lines = []
        for it in order.items:
            parsed_lines.append((it.product_id, _quantity(it.quantity)))

    # --- Trusted pricing: products come from this tenant's catalogue ---------------------------
    product_ids = {pid for pid, _ in parsed_lines if pid is not None}
    products = {
        p.id: p for p in db.query(models.Product).filter(
            models.Product.id.in_(product_ids),
            models.Product.tenant_id == tenant_id
        ).all()
    } if product_ids else {}
    calculated_total = Decimal("0.00")
    validated_items = []
    if order is not None:
        # Prices are the ones the server stored when the customer placed the order, not today's menu.
        for it in order.items:
            unit_price = Decimal(str(it.price)).quantize(CENT, rounding=ROUND_HALF_UP)
            total_price = unit_price * it.quantity
            calculated_total += total_price
            validated_items.append(
                models.TransactionItem(
                    product_id=it.product_id if it.product_id in products else None,
                    quantity=it.quantity,
                    unit_price=unit_price,
                    total_price=total_price
                )
            )
    else:
        for prod_id, qty in parsed_lines:
            product = products.get(prod_id)
            if not product:
                raise HTTPException(status_code=404, detail=f"Product ID {prod_id} not found.")
            if not product.is_active:
                raise HTTPException(status_code=400, detail=f"Product '{product.name}' is currently inactive or unavailable.")

            unit_price = Decimal(str(product.price)).quantize(CENT, rounding=ROUND_HALF_UP)
            total_price = unit_price * qty
            calculated_total += total_price
            validated_items.append(
                models.TransactionItem(
                    product_id=prod_id,
                    quantity=qty,
                    unit_price=unit_price,
                    total_price=total_price
                )
            )

    if discount_amount > calculated_total:
        raise HTTPException(status_code=400, detail="Discount cannot exceed the order total.")
    net_amount = calculated_total + tax_amount - discount_amount
    if net_amount > MAX_MONEY:
        raise HTTPException(status_code=400, detail="Order total is too large.")

    # --- Payments: validated against the server-computed net amount ----------------------------
    verified_attempt = None
    payments_data = body.get("payments")
    payment_rows = []   # (method, amount)
    if order is not None:
        if pay.amount_due_for_customer_order(order) != net_amount:
            raise HTTPException(status_code=409, detail="This order's total is inconsistent. Ask a manager to review it.")
        payment_rows, verified_attempt = _order_payment_rows(db, order, body, payments_data, net_amount)
    elif payments_data:
        payment_rows = _payment_list(payments_data, net_amount)
    else:
        method = _check_payment_method(body.get("payment_method"))
        # The amount recorded is the amount due; the tendered amount only affects change at the till.
        tendered = body.get("amount_paid")
        if tendered is not None and tx_status == "completed":
            tendered_amount = _money(tendered, "amount_paid")
            if tendered_amount < net_amount:
                raise HTTPException(status_code=400, detail="Payment does not cover the amount due.")
            if not _is_cash(method) and tendered_amount != net_amount:
                # Only cash has change. A non-cash amount that differs from the bill is a data error.
                raise HTTPException(status_code=400, detail=f"A {method.upper()} payment must equal the amount due.")
        payment_rows.append((method, net_amount))

    from app.routers.kitchen import is_kitchen_item, is_drink_item
    # Item.product is not populated until flush; classify using the loaded product map instead.
    kitchen_products = [products[it.product_id] for it in validated_items if it.product_id in products]
    has_kitchen = any(is_kitchen_item(p) for p in kitchen_products)
    has_drinks = any(is_drink_item(p) for p in kitchen_products)
    initial_fulfillment = "pending" if (has_kitchen or has_drinks) else "completed"
    if order is not None and order_status_before != "pending":
        # The kitchen already tracks this order as a customer (CUST) ticket; do not create a second ticket.
        initial_fulfillment = "completed"
        has_kitchen = has_drinks = False

    # --- Persist everything in ONE database transaction ----------------------------------------
    try:
        active_shift = db.query(models.Shift).filter(
            models.Shift.tenant_id == tenant_id,
            models.Shift.user_id == current_user.id,
            models.Shift.status == "open"
        ).first()
        if not active_shift:
            if not AUTO_OPEN_SHIFT:
                raise HTTPException(status_code=409, detail="No open shift. Start a shift (drawer count) before recording sales.")
            logger.warning("Auto-opening a zero-cash shift for user %s in tenant %s", current_user.id, tenant_id)
            active_shift = models.Shift(
                tenant_id=tenant_id,
                user_id=current_user.id,
                start_cash=Decimal("0.00"),
                status="open"
            )
            db.add(active_shift)
            db.flush()

        tx = models.Transaction(
            tenant_id=tenant_id,
            shift_id=active_shift.id,
            user_id=current_user.id,
            client_tx_id=client_tx_id,
            request_fingerprint=fingerprint,
            customer_order_id=order.id if order is not None else None,
            total_amount=calculated_total,
            tax_amount=tax_amount,
            discount_amount=discount_amount,
            net_amount=net_amount,
            status=tx_status,
            fulfillment_status=initial_fulfillment
        )
        tx.items = validated_items
        tx.payments = [
            _build_payment(method, amount, tx_status, verified_attempt)
            for method, amount in payment_rows
        ]
        db.add(tx)
        db.flush()

        # Recipe stock (only when INVENTORY_DEDUCTION=on_sale); 409 on insufficient stock rolls back the sale.
        stock.deduct_for_sale(db, tx, [(it.product_id, it.quantity) for it in validated_items], current_user.id)

        if order is not None:
            _settle_customer_order(db, order, verified_attempt, order_status_before)

        db.add(models.ActivityLog(
            tenant_id=tenant_id,
            user_id=current_user.id,
            action="POS Sale",
            performed_by=current_user.username,
            role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
            details=(f"Transaction #{tx.id} processed for ₱{float(net_amount):,.2f}"
                     + (f" (online order {order.order_number})" if order is not None else ""))[:255]
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        # Concurrent duplicate: same client_tx_id, or a second cashier settling the same online order.
        existing_tx = db.query(models.Transaction).filter(
            models.Transaction.client_tx_id == client_tx_id,
            models.Transaction.tenant_id == tenant_id
        ).first()
        if existing_tx:
            return _replay_or_conflict(existing_tx, fingerprint)
        if order_id is not None:
            linked = db.query(models.Transaction).filter(
                models.Transaction.tenant_id == tenant_id,
                models.Transaction.customer_order_id == order_id
            ).first()
            if linked:
                return _existing_tx_response(linked, "Order was already processed.")
        logger.exception("Integrity error while creating transaction")
        raise HTTPException(status_code=409, detail="Could not record the transaction. Please retry.")
    except Exception:
        db.rollback()
        logger.exception("Failed to create transaction")
        raise HTTPException(status_code=500, detail="Could not record the transaction.")
    db.refresh(tx)

    # Real-time events are sent only after the commit above succeeded (tenant-scoped).
    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "ORDER_CREATED", {
            "order_id": tx.id,
            "order_code": f"TXN-{tx.id:04d}",
            "client_tx_id": tx.client_tx_id,
            "net_amount": float(tx.net_amount),
            "status": tx.status,
            "fulfillment_status": tx.fulfillment_status,
            "cashier": current_user.username
        })
        if has_kitchen:
            notify_realtime_event(tenant_id, "KITCHEN_UPDATED", {
                "order_id": f"ORD-{tx.id:04d}",
                "raw_id": tx.id,
                "status": "PENDING",
                "station": "food"
            })
        if has_drinks:
            notify_realtime_event(tenant_id, "KITCHEN_UPDATED", {
                "order_id": f"ORD-{tx.id:04d}",
                "raw_id": tx.id,
                "status": "PENDING",
                "station": "drinks"
            })
        if order is not None:
            # Status and payment status only: no amounts, references or discrepancy details.
            notify_realtime_event(tenant_id, "CUSTOMER_ORDER_UPDATED", {
                "order_id": order.id,
                "order_number": order.order_number,
                "status": order.status,
                "payment_status": order.payment_status
            })
        notify_realtime_event(tenant_id, "DRAWER_UPDATED", {"reason": "pos_sale", "order_id": tx.id})
        notify_realtime_event(tenant_id, "FINANCIAL_UPDATED", {"reason": "pos_sale", "order_id": tx.id})
    except Exception:
        logger.warning("Failed to broadcast transaction events", exc_info=True)

    result = {
        "id": tx.id,
        "order_code": f"TXN-{tx.id:04d}",
        "receipt_no": f"TXN-{tx.id:04d}",
        "client_tx_id": tx.client_tx_id,
        "customer_order_id": tx.customer_order_id,
        "total_amount": float(tx.total_amount),
        "tax_amount": float(tx.tax_amount),
        "discount_amount": float(tx.discount_amount),
        "net_amount": float(tx.net_amount),
        "status": tx.status,
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
        **_sale_lines(tx),
        "message": "Transaction created successfully."
    }
    if order is not None:
        result["payment_status"] = order.payment_status
    return result


# ------------------------------------------------------------------------------------------------
# Online-order helpers
# ------------------------------------------------------------------------------------------------
def reconcile_order_with_sale(order: models.CustomerOrder, sale: models.Transaction) -> list:
    """
    Repair an order left behind by the old two-step flow (sale saved, order update lost). Only finishes
    what the sale already proves; never creates a sale and never touches a voided sale's order.
    Returns a list of the changes made (empty = nothing to do). The caller commits and audits.
    """
    if sale.status in pay.VOID_STATUSES or order.status == "rejected":
        return []
    changes = []
    if order.status == "pending":
        order.status = "completed"
        changes.append("status pending->completed")
    # A GCash order is paid only through verification; a sale cannot certify it after the fact.
    if order.payment_status == pay.PS_UNPAID and order.payment_method != pay.PAYMENT_GCASH:
        order.payment_status = pay.PS_COUNTER_PAID
        changes.append("payment unpaid->counter_paid")
    return changes


def _resume_linked_order(db: Session, order: models.CustomerOrder, linked: models.Transaction, tenant_id: int,
                         user: models.User) -> dict:
    """
    The order already has its sale. Never create a second one. If an earlier attempt was cut short
    before the order was updated (legacy two-step flow), finish that update now so the order does not
    stay pending, then return the original sale.
    """
    if linked.status in pay.VOID_STATUSES:
        raise HTTPException(status_code=409, detail="This order's sale was voided. It cannot be sold again; ask a manager.")
    changes = reconcile_order_with_sale(order, linked)
    if changes:
        db.add(models.ActivityLog(
            tenant_id=tenant_id, user_id=user.id, action="Order Reconciled", performed_by=user.username,
            role=user.role.value if hasattr(user.role, "value") else str(user.role),
            details=f"Order {order.order_number} matched to existing sale #{linked.id}: {', '.join(changes)}."[:255]
        ))
        db.commit()
        try:
            from app.core.websocket import notify_realtime_event
            notify_realtime_event(tenant_id, "CUSTOMER_ORDER_UPDATED", {
                "order_id": order.id, "order_number": order.order_number,
                "status": order.status, "payment_status": order.payment_status
            })
        except Exception:
            logger.warning("Failed to broadcast reconciled order event", exc_info=True)
    return _existing_tx_response(linked, "Order was already processed.")


def _order_payment_rows(db: Session, order: models.CustomerOrder, body: dict, payments_data, net_amount: Decimal):
    """Apply the order's payment rules. Returns ([(method, amount)], matched_verification_or_None)."""
    chosen = order.payment_method
    ps = order.payment_status

    if chosen == pay.PAYMENT_GCASH:
        if ps == pay.PS_VERIFIED:
            pass
        elif ps in pay.DISPUTED_STATUSES:
            raise HTTPException(status_code=409, detail="This GCash payment has an unresolved discrepancy. A manager must review it before the order can be paid.")
        else:
            raise HTTPException(status_code=409, detail="Verify the GCash payment (amount received) before recording this order.")
        requested = [m.strip().upper() for m in _requested_methods(body)] if (payments_data or body.get("payment_method")) else []
        if any(m != pay.PAYMENT_GCASH for m in requested):
            raise HTTPException(status_code=400, detail="This order was paid by GCash and cannot be recorded with another method.")
        attempt = db.query(models.PaymentVerification).filter(
            models.PaymentVerification.tenant_id == order.tenant_id,
            models.PaymentVerification.customer_order_id == order.id,
            models.PaymentVerification.outcome == pay.OUTCOME_MATCHED
        ).order_by(models.PaymentVerification.id.desc()).first()
        if attempt is None or Decimal(str(attempt.expected_amount)) != net_amount:
            raise HTTPException(status_code=409, detail="The verified amount no longer matches the order. Verify the payment again or ask a manager.")
        return [(pay.PAYMENT_GCASH, net_amount)], attempt

    if ps != pay.PS_UNPAID:
        raise HTTPException(status_code=409, detail="This order's payment was already recorded.")

    rows = []
    if payments_data:
        rows = _payment_list(payments_data, net_amount)
    else:
        method = _check_payment_method(body.get("payment_method"))
        tendered = body.get("amount_paid")
        if tendered is not None:
            tendered_amount = _money(tendered, "amount_paid")
            if tendered_amount < net_amount:
                raise HTTPException(status_code=400, detail="Payment does not cover the amount due.")
            if not _is_cash(method) and tendered_amount != net_amount:
                raise HTTPException(status_code=400, detail=f"A {method.upper()} payment must equal the amount due.")
        rows.append((method, net_amount))

    if chosen == pay.PAYMENT_AT_COUNTER:
        # Legacy orders (chosen is None) keep the old behaviour: any method, cashier's judgement.
        for method, _ in rows:
            if method.strip().upper() not in pay.COUNTER_SETTLEMENT_METHODS:
                raise HTTPException(status_code=400, detail="A pay-at-counter order is settled with CASH or CARD at the till.")
    return rows, None


def _build_payment(method: str, amount: Decimal, tx_status: str, verified_attempt) -> models.Payment:
    payment = models.Payment(
        payment_method=method,
        amount=amount,
        status="completed" if tx_status == "completed" else "pending"
    )
    if verified_attempt is not None and method == pay.PAYMENT_GCASH:
        payment.reference_no = verified_attempt.reference_no
        payment.amount_received = verified_attempt.reported_amount
        payment.verified_by = verified_attempt.attempted_by
        payment.verified_at = verified_attempt.attempted_at
    return payment


def _settle_customer_order(db: Session, order: models.CustomerOrder, verified_attempt, status_before: str) -> None:
    """Update the order inside the sale's database transaction (compare-and-swap on payment_status)."""
    if status_before == "pending":
        order.status = "completed"
    if verified_attempt is None:   # counter / legacy settlement
        updated = db.query(models.CustomerOrder).filter(
            models.CustomerOrder.id == order.id,
            models.CustomerOrder.payment_status == pay.PS_UNPAID
        ).update({"payment_status": pay.PS_COUNTER_PAID}, synchronize_session=False)
        if updated != 1:
            raise HTTPException(status_code=409, detail="This order's payment changed while you were checking out. Reload and try again.")
        order.payment_status = pay.PS_COUNTER_PAID


@router.put("/{tx_id}/status", summary="Void a sale, complete a pending sale, or record preparation progress")
def update_transaction_status(
    tx_id: int,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    """
    * `cancelled` / `rejected` VOIDS the sale: a reason is required, the sale and its payment rows are kept
      (payments marked cancelled), who/when/why is stored on the sale, recipe stock taken by the sale is
      restored, and if money had been collected the sale is flagged `refund_status = pending` until a
      manager/admin records the manual refund (POST /transactions/{id}/refund). Voiding never claims that
      money was returned.
    * `completed` completes a PENDING sale (its payments must equal the total). A completed sale is never
      moved back to pending.
    * `preparing` / `ready` record preparation progress (fulfilment status only).

    BUSINESS DECISION PENDING: who may void a completed sale. Every POS role may (previous behaviour)
    unless VOID_REQUIRES_MANAGER=true.
    """
    raw_status = str(body.get("status") or "").strip().lower()
    allowed = ["pending", "preparing", "ready", "completed", "cancelled", "rejected"]
    if raw_status not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status '{raw_status}'. Allowed values: {', '.join(allowed)}"
        )
    reason = str(body.get("reason") or "").strip()[:150]
    voiding = raw_status in pay.VOID_STATUSES

    tenant_id = resolve_tenant_id(current_user, db, request)
    # Row lock: a void, a completion and a refund on the same sale are applied one at a time.
    tx = db.query(models.Transaction).options(selectinload(models.Transaction.payments)).filter(
        models.Transaction.id == tx_id,
        models.Transaction.tenant_id == tenant_id
    ).with_for_update().first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    if voiding:
        # Checked after the tenant-scoped lookup, so another tenant's sale is always a plain 404.
        if len(reason) < MIN_VOID_REASON:
            db.rollback()
            raise HTTPException(status_code=400, detail="A reason is required to void a sale.")
        if VOID_REQUIRES_MANAGER and current_user.role not in AUDIT_ROLES:
            db.rollback()
            raise HTTPException(status_code=403, detail="Only a manager or admin can void a sale.")

    # IMMUTABILITY RULE: Once an order is rejected (or cancelled), its status is final and cannot be changed!
    if tx.status in pay.VOID_STATUSES:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Order #{tx.id} has already been {tx.status.upper()}. Once an order is rejected, its status is locked and cannot be changed."
        )

    old_status = tx.status
    role = current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role)
    try:
        if voiding:
            collected = any(p.status == "completed" for p in tx.payments)
            tx.status = raw_status
            tx.voided_at = datetime.now()
            tx.voided_by = current_user.id
            tx.void_reason = reason
            tx.refund_status = pay.REFUND_PENDING if collected else None
            for p in tx.payments:
                p.status = "cancelled"
            restored = stock.restore_for_void(db, tx, current_user.id)
            action = "Order Cancelled/Rejected"
            details = (f"Sale #{tx.id} ({old_status.upper()} -> {raw_status.upper()}, ₱{float(tx.net_amount):,.2f}) voided. "
                       f"Reason: {reason}. " + ("Payment was collected: refund pending (manual)." if collected else "No payment collected.")
                       + (f" Stock restored for {restored} item(s)." if restored else ""))
        elif raw_status in FULFILMENT_ONLY_STATUSES:
            if tx.fulfillment_status == "completed":
                raise HTTPException(status_code=409, detail=f"Order #{tx.id} was already served and cannot move back to {raw_status}.")
            tx.fulfillment_status = raw_status
            action = "Order Status Update"
            details = f"Order #{tx.id} preparation status set to {raw_status.upper()}."
        elif raw_status == "completed":
            if tx.status == "pending":
                paid = sum((Decimal(str(p.amount)) for p in tx.payments), Decimal("0.00"))
                if paid != Decimal(str(tx.net_amount)):
                    raise HTTPException(status_code=409, detail="The payments recorded for this sale do not match its total.")
                tx.status = "completed"
                for p in tx.payments:
                    p.status = "completed"
            action = "Order Status Update"
            details = f"Order #{tx.id} status changed from {old_status.upper()} to COMPLETED." + (f" Reason: {reason}" if reason else "")
        else:   # "pending"
            if tx.status != "pending":
                raise HTTPException(status_code=409, detail="A completed sale cannot be moved back to pending. Void it instead.")
            action = "Order Status Update"
            details = f"Order #{tx.id} left PENDING."

        db.add(models.ActivityLog(
            tenant_id=tx.tenant_id,
            user_id=current_user.id,
            action=action,
            performed_by=current_user.username,
            role=role,
            details=details[:255]
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    db.refresh(tx)

    # Real-time WebSocket event broadcast (after the commit)
    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tx.tenant_id, "ORDER_UPDATED", {
            "order_id": tx.id,
            "status": tx.status,
            "old_status": old_status
        })
        notify_realtime_event(tx.tenant_id, "DRAWER_UPDATED", {"reason": "order_status_change", "order_id": tx.id})
        notify_realtime_event(tx.tenant_id, "FINANCIAL_UPDATED", {"reason": "order_status_change", "order_id": tx.id})
    except Exception:
        logger.warning("Failed to broadcast transaction status events", exc_info=True)

    return {
        "id": tx.id,
        "status": tx.status,
        "fulfillment_status": tx.fulfillment_status,
        "refund_status": tx.refund_status,
        "message": f"Order #{tx.id} marked as {raw_status.upper()} successfully."
    }


@router.post("/{tx_id}/refund", summary="Record the manual refund of a voided sale (manager/admin)")
def record_refund(
    tx_id: int,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    """
    The POS does not move money. After the money of a voided sale was handed back (cash from the drawer,
    a GCash transfer from the store's GCash app, a card reversal on the terminal), a manager/admin records
    it here. `outcome`:
      * `refunded` (default): `amount` must be the full amount collected and `refund_method` one of the
        sale's payment methods (partial refunds are an open business decision); optional `reference_no`.
      * `not_required`: nothing had actually been collected (e.g. a sale keyed in by mistake).
    `note` (5-200 characters) is required. One record per sale; a second one is 409.
    Reports are unaffected: the voided sale was already excluded from income and drawer cash.
    """
    outcome = str(body.get("outcome") or pay.REFUND_DONE).strip().lower()
    if outcome not in (pay.REFUND_DONE, pay.REFUND_NOT_REQUIRED):
        raise HTTPException(status_code=400, detail="Invalid outcome. Use 'refunded' or 'not_required'.")
    note = str(body.get("note") or "").strip()
    if not 5 <= len(note) <= 200:
        raise HTTPException(status_code=400, detail="A note of 5 to 200 characters is required.")

    tenant_id = resolve_tenant_id(current_user, db, request)
    tx = db.query(models.Transaction).options(selectinload(models.Transaction.payments)).filter(
        models.Transaction.id == tx_id,
        models.Transaction.tenant_id == tenant_id
    ).with_for_update().first()
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found.")
    if tx.status not in pay.VOID_STATUSES:
        db.rollback()
        raise HTTPException(status_code=409, detail="Only a voided sale can be refunded. Void the sale first.")
    if tx.refund_status != pay.REFUND_PENDING:
        db.rollback()
        if tx.refund_status in (pay.REFUND_DONE, pay.REFUND_NOT_REQUIRED):
            raise HTTPException(status_code=409, detail="A refund outcome was already recorded for this sale.")
        raise HTTPException(status_code=409, detail="No payment was collected for this sale, so there is nothing to refund.")

    collected = sum((Decimal(str(p.amount)) for p in tx.payments), Decimal("0.00"))
    amount, method, reference = Decimal("0.00"), None, None
    if outcome == pay.REFUND_DONE:
        amount = _money(body.get("amount"), "refund amount", allow_zero=False)
        if amount != collected:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"A refund must be the full amount collected (₱{collected:,.2f}). Partial refunds are not supported.")
        method = _check_payment_method(body.get("refund_method"))
        if method not in {(p.payment_method or "").strip().upper() for p in tx.payments}:
            db.rollback()
            raise HTTPException(status_code=400, detail="The refund method must match how the sale was paid.")
        reference = pay.normalize_reference(body.get("reference_no"))

    try:
        # Compare-and-swap: only one refund outcome can ever be recorded for a sale.
        updated = db.query(models.Transaction).filter(
            models.Transaction.id == tx.id,
            models.Transaction.refund_status == pay.REFUND_PENDING
        ).update({"refund_status": outcome}, synchronize_session=False)
        if updated != 1:
            raise HTTPException(status_code=409, detail="A refund outcome was already recorded for this sale.")
        refund = models.SaleRefund(
            tenant_id=tenant_id, transaction_id=tx.id, outcome=outcome, amount=amount,
            refund_method=method, reference_no=reference, note=note, recorded_by=current_user.id,
        )
        db.add(refund)
        db.add(models.ActivityLog(
            tenant_id=tenant_id, user_id=current_user.id,
            action="Refund Recorded" if outcome == pay.REFUND_DONE else "Refund Not Required",
            performed_by=current_user.username,
            role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
            details=(f"Sale #{tx.id}: ₱{amount:,.2f} returned by {method} (recorded manually). Note: {note}"
                     if outcome == pay.REFUND_DONE else f"Sale #{tx.id}: no refund needed. Note: {note}")[:255]
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A refund outcome was already recorded for this sale.")
    db.refresh(refund)

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "FINANCIAL_UPDATED", {"reason": "refund_recorded", "order_id": tx.id})
    except Exception:
        logger.warning("Failed to broadcast refund event", exc_info=True)

    return {
        "transaction_id": tx.id,
        "refund_status": outcome,
        "amount": float(amount),
        "refund_method": method,
        "reference_no": reference,
        "recorded_at": refund.recorded_at.isoformat() if refund.recorded_at else None,
        "basis": "Recorded by staff; the POS did not send or verify the refund.",
    }
