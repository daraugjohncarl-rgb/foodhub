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
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.db import get_db
import app.models as models
from app.core.dependencies import require_pos_access, resolve_tenant_id
from app.services import payments as pay

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


def _money(value, field: str, *, allow_zero: bool = True) -> Decimal:
    """Parse a client-supplied money value into a validated 2dp Decimal (never via float arithmetic)."""
    if isinstance(value, bool) or value is None:
        raise HTTPException(status_code=400, detail=f"Invalid {field}.")
    try:
        amount = Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise HTTPException(status_code=400, detail=f"Invalid {field}.")
    if not amount.is_finite() or amount < 0 or amount > MAX_MONEY or (amount == 0 and not allow_zero):
        raise HTTPException(status_code=400, detail=f"Invalid {field}.")
    return amount


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
    # startswith, not "in": "GCASH" contains "cash" but is not cash in the drawer.
    return (method or "").strip().lower().startswith("cash")


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
    return data


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
        return [str((r or {}).get("payment_method") or "Cash") if isinstance(r, dict) else "Cash" for r in rows]
    return [str(body.get("payment_method") or "Cash")]


def _check_payment_method(method) -> str:
    method = str(method or "Cash").strip()
    if not method or len(method) > MAX_PAYMENT_METHOD_LENGTH:
        raise HTTPException(status_code=400, detail="Invalid payment method.")
    return method


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
            return _resume_linked_order(db, order, linked, tenant_id)
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
        if not isinstance(payments_data, list) or len(payments_data) > 10:
            raise HTTPException(status_code=400, detail="Invalid payments.")
        for p in payments_data:
            if not isinstance(p, dict):
                raise HTTPException(status_code=400, detail="Invalid payment.")
            method = _check_payment_method(p.get("payment_method"))
            payment_rows.append((method, _money(p.get("amount", net_amount), "payment amount", allow_zero=False)))
        if tx_status == "completed" and sum(a for _, a in payment_rows) < net_amount:
            raise HTTPException(status_code=400, detail="Payments do not cover the amount due.")
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
        "message": "Transaction created successfully."
    }
    if order is not None:
        result["payment_status"] = order.payment_status
    return result


# ------------------------------------------------------------------------------------------------
# Online-order helpers
# ------------------------------------------------------------------------------------------------
def _resume_linked_order(db: Session, order: models.CustomerOrder, linked: models.Transaction, tenant_id: int) -> dict:
    """
    The order already has its sale. Never create a second one. If an earlier attempt was cut short
    before the order was updated (legacy two-step flow), finish that update now so the order does not
    stay pending, then return the original sale.
    """
    changed = False
    if order.status == "pending":
        order.status = "completed"
        changed = True
    if order.payment_status == pay.PS_UNPAID:
        order.payment_status = pay.PS_COUNTER_PAID
        changed = True
    if changed:
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
        if not isinstance(payments_data, list) or len(payments_data) > 10:
            raise HTTPException(status_code=400, detail="Invalid payments.")
        for p in payments_data:
            if not isinstance(p, dict):
                raise HTTPException(status_code=400, detail="Invalid payment.")
            rows.append((_check_payment_method(p.get("payment_method")), _money(p.get("amount", net_amount), "payment amount", allow_zero=False)))
        if sum(a for _, a in rows) < net_amount:
            raise HTTPException(status_code=400, detail="Payments do not cover the amount due.")
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


@router.put("/{tx_id}/status", summary="Update transaction status (e.g. reject/cancel or complete)")
def update_transaction_status(
    tx_id: int,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    """
    Allows cashier and management to change order status.
    If the customer cancels the order, the cashier can reject the order,
    marking transaction as 'rejected' / 'cancelled' and voiding associated payments.

    BUSINESS DECISION PENDING: who may void a completed sale (currently every POS role, as before)
    and whether voids need manager approval is not specified; see PRODUCTION_READINESS.md.
    """
    tenant_id = resolve_tenant_id(current_user, db, request)
    tx = db.query(models.Transaction).filter(
        models.Transaction.id == tx_id,
        models.Transaction.tenant_id == tenant_id
    ).first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")

    # IMMUTABILITY RULE: Once an order is rejected (or cancelled), its status is final and cannot be changed!
    if tx.status in ["rejected", "cancelled"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Order #{tx.id} has already been {tx.status.upper()}. Once an order is rejected, its status is locked and cannot be changed."
        )

    raw_status = str(body.get("status") or "").strip().lower()
    reason = str(body.get("reason") or "").strip()[:150] or "Customer cancelled order"

    allowed = ["pending", "preparing", "ready", "completed", "cancelled", "rejected"]
    if raw_status not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status '{raw_status}'. Allowed values: {', '.join(allowed)}"
        )

    old_status = tx.status
    tx.status = raw_status

    # Void or update payments
    if raw_status in ["cancelled", "rejected"]:
        for p in tx.payments:
            p.status = "cancelled"
    elif raw_status == "completed":
        for p in tx.payments:
            p.status = "completed"

    db.add(models.ActivityLog(
        tenant_id=tx.tenant_id,
        user_id=current_user.id,
        action="Order Cancelled/Rejected" if raw_status in ["cancelled", "rejected"] else "Order Status Update",
        performed_by=current_user.username,
        role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
        details=f"Order #{tx.id} status changed from {old_status.upper()} to {raw_status.upper()}. Reason: {reason}"[:255]
    ))

    db.commit()
    db.refresh(tx)

    # Real-time WebSocket event broadcast
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
        "message": f"Order #{tx.id} marked as {tx.status.upper()} successfully."
    }
