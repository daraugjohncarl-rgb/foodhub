from fastapi import APIRouter, Depends, HTTPException, Header, Query, Request, status
from sqlalchemy.orm import Session, joinedload, selectinload
from sqlalchemy.exc import IntegrityError
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from typing import Any, List, Optional
from datetime import datetime
from decimal import Decimal
import hashlib
import re
import secrets
import logging

from app.db import get_db
import app.models as models
from app.core.dependencies import require_pos_access, require_manager_or_admin, resolve_tenant_id
from app.services import payments as pay
from app.core.rate_limit import rate_limit, SlidingWindowLimiter, client_ip
from app.core.websocket import notify_realtime_event

logger = logging.getLogger("pos_customer_orders")

router = APIRouter(prefix="/customer-orders", tags=["Customer Orders"])

# Public endpoints are throttled per client IP (see core/rate_limit.py for the multi-instance caveat).
submit_order_limit = rate_limit(max_calls=10, window_seconds=60, scope="customer-order-submit")
menu_limit = rate_limit(max_calls=60, window_seconds=60, scope="customer-menu")
track_limit = rate_limit(max_calls=60, window_seconds=60, scope="customer-track")
track_failure_limiter = SlidingWindowLimiter(max_calls=10, window_seconds=300, scope="customer-track-failures")

MAX_ITEMS_PER_ORDER = 50
MAX_QUANTITY_PER_ITEM = 50
MAX_UNITS_PER_ORDER = 200

# Lifecycle of a customer (QR) order. completed / rejected are final.
CUSTOMER_ORDER_STATUSES = {"pending", "accepted", "preparing", "ready", "completed", "rejected"}
FINAL_CUSTOMER_ORDER_STATUSES = {"completed", "rejected"}
_STATUS_RANK = {"pending": 0, "accepted": 1, "preparing": 2, "ready": 2, "completed": 3, "rejected": 3}

# Table labels are printed into staff screens and QR links: keep them to plain label characters.
TABLE_LABEL_RE = re.compile(r"^[\w .#\-]{1,50}$")

ORDER_TYPES = {"dine in": "Dine In", "take out": "Take Out", "takeout": "Take Out"}


def apply_customer_order_status(order: models.CustomerOrder, new_status: str) -> None:
    """Validate and apply a status change; raises 400 for unknown values, 409 for illegal transitions."""
    if new_status not in CUSTOMER_ORDER_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid status")
    current = order.status
    if current == new_status:
        return
    if order.payment_status in pay.DISPUTED_STATUSES and new_status in pay.BLOCKED_WHILE_DISPUTED:
        # Fulfilment never proceeds on a disputed payment; the order can still be rejected.
        raise HTTPException(status_code=409, detail="This order's GCash payment is under review. Resolve the discrepancy or reject the order.")
    if current in FINAL_CUSTOMER_ORDER_STATUSES:
        raise HTTPException(status_code=409, detail=f"Order is already {current} and can no longer be changed.")
    if _STATUS_RANK.get(new_status, 0) < _STATUS_RANK.get(current, 0):
        raise HTTPException(status_code=409, detail=f"Order cannot move from {current} back to {new_status}.")
    order.status = new_status


class CustomerOrderItemIn(BaseModel):
    """Only the product reference and quantity are accepted. Name and price are always loaded server-side."""
    model_config = ConfigDict(extra="ignore")

    product_id: int = Field(..., gt=0, validation_alias=AliasChoices("product_id", "id"))
    quantity: int = Field(1, ge=1, le=MAX_QUANTITY_PER_ITEM)
    variant: Optional[str] = Field(None, max_length=100)


class CustomerOrderIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    tenant_id: Optional[int] = Field(None, gt=0)
    customer_name: Optional[str] = Field(None, max_length=100)
    order_type: Optional[str] = Field("Dine In", max_length=50)
    table_number: Optional[str] = Field(None, max_length=50)
    notes: Optional[str] = Field(None, max_length=500)
    # The customer's CHOICE only (GCASH or PAY_AT_COUNTER). Any payment/verification status in the body is ignored.
    payment_method: Optional[str] = Field(None, max_length=30)
    items: List[CustomerOrderItemIn] = Field(..., min_length=1, max_length=MAX_ITEMS_PER_ORDER)


def _resolve_public_tenant(db: Session, tenant_id: Optional[int]) -> int:
    """
    The branch comes from the QR code, which is public by design. It is accepted only if it is an
    existing, active tenant. With no tenant supplied it is inferred only when exactly one is active.
    """
    if tenant_id:
        tenant = db.query(models.Tenant).filter(models.Tenant.id == tenant_id, models.Tenant.is_active.is_(True)).first()
        if not tenant:
            raise HTTPException(status_code=400, detail="Unknown branch.")
        return tenant.id
    active = db.query(models.Tenant).filter(models.Tenant.is_active.is_(True)).limit(2).all()
    if len(active) != 1:
        raise HTTPException(status_code=400, detail="Branch is required.")
    return active[0].id


# What a customer may see about their own payment: no discrepancy wording, amounts or references.
_PUBLIC_PAYMENT_STATUS = {
    pay.PS_UNPAID: "unpaid", pay.PS_VERIFIED: "verified", pay.PS_COUNTER_PAID: "paid",
    pay.PS_DISCREPANCY: "under_review", pay.PS_INVALID: "under_review",
}


def _serialize_order(order: models.CustomerOrder, *, staff: bool = False, context: Optional[dict] = None) -> dict:
    data = {
        "id": order.id,
        "order_number": order.order_number,
        "customer_name": order.customer_name,
        "order_type": order.order_type,
        "table_number": order.table_number,
        "status": order.status,
        "notes": order.notes,
        "total_amount": float(order.total_amount),
        "payment_method": order.payment_method,
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "items": [
            {
                "name": item.name,
                "variant": item.variant,
                "price": float(item.price),
                "quantity": item.quantity,
                "product_id": getattr(item, "product_id", None)
            } for item in order.items
        ]
    }
    if not staff:
        data["payment_status"] = _PUBLIC_PAYMENT_STATUS.get(order.payment_status, "unpaid")
        return data
    context = context or {}
    attempt = context.get("attempt")
    data["payment_status"] = order.payment_status
    data["transaction_id"] = context.get("transaction_id")
    data["sale_recorded"] = context.get("transaction_id") is not None
    data["payment_attempt"] = None if attempt is None else {
        # What the cashier needs to see the warning. Who attempted and any notes are manager/admin only.
        "outcome": attempt.outcome,
        "expected_amount": float(attempt.expected_amount),
        "reported_amount": float(attempt.reported_amount),
        "discrepancy_amount": float(attempt.discrepancy_amount),
        "attempted_at": attempt.attempted_at.isoformat() if attempt.attempted_at else None,
    }
    return data


def _staff_context(db: Session, tenant_id: int, orders: list) -> dict:
    """Latest verification attempt and linked sale for each order, fetched in two queries."""
    ids = [o.id for o in orders]
    if not ids:
        return {}
    context = {i: {"transaction_id": None, "attempt": None} for i in ids}
    for tx_id, order_id in db.query(models.Transaction.id, models.Transaction.customer_order_id).filter(
        models.Transaction.tenant_id == tenant_id, models.Transaction.customer_order_id.in_(ids)
    ).all():
        context[order_id]["transaction_id"] = tx_id
    for attempt in db.query(models.PaymentVerification).filter(
        models.PaymentVerification.tenant_id == tenant_id, models.PaymentVerification.customer_order_id.in_(ids)
    ).order_by(models.PaymentVerification.id.asc()).all():
        context[attempt.customer_order_id]["attempt"] = attempt   # ascending: the last one wins
    return context


@router.post("", status_code=status.HTTP_201_CREATED, summary="Submit a customer order from the QR menu")
def submit_customer_order(
    body: CustomerOrderIn,
    db: Session = Depends(get_db),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key", min_length=16, max_length=64),
    _rl: None = Depends(submit_order_limit),
):
    """
    Public endpoint used by the customer QR menu.
    Prices, names and totals come only from the database. The order reference and tracking token
    are generated server-side. A client may send an Idempotency-Key header (a random UUID) so that
    a retried submission returns the original order instead of creating a duplicate.
    """
    tenant_id = _resolve_public_tenant(db, body.tenant_id)

    order_type = ORDER_TYPES.get((body.order_type or "dine in").strip().lower().replace("_", " ").replace("-", " "))
    if not order_type:
        raise HTTPException(status_code=400, detail="Invalid order type.")

    table_number = body.table_number.strip() if body.table_number and body.table_number.strip() else None
    if table_number and not TABLE_LABEL_RE.match(table_number):
        raise HTTPException(status_code=400, detail="Invalid table number.")
    notes = body.notes.strip() if body.notes and body.notes.strip() else None
    payment_method = pay.normalize_payment_method(body.payment_method)
    if payment_method is not None and payment_method not in pay.CUSTOMER_PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail="Invalid payment method. Choose GCASH or PAY_AT_COUNTER.")
    customer_name = body.customer_name.strip() if body.customer_name and body.customer_name.strip() else None
    if not customer_name:
        customer_name = f"Table {table_number} Guest" if table_number else "Guest Customer"

    if sum(i.quantity for i in body.items) > MAX_UNITS_PER_ORDER:
        raise HTTPException(status_code=400, detail="Order is too large.")

    # Load every referenced product from this tenant in one query.
    product_ids = {i.product_id for i in body.items}
    products = {
        p.id: p for p in db.query(models.Product).filter(
            models.Product.id.in_(product_ids),
            models.Product.tenant_id == tenant_id,
            models.Product.is_active.is_(True)
        ).all()
    }
    if len(products) != len(product_ids):
        raise HTTPException(status_code=400, detail="One or more items are unavailable.")

    if idempotency_key:
        digest = hashlib.sha256(f"{tenant_id}:{idempotency_key}".encode()).hexdigest()
        order_number = f"CUST-{digest[:12].upper()}"
        existing = db.query(models.CustomerOrder).options(joinedload(models.CustomerOrder.items)).filter(
            models.CustomerOrder.order_number == order_number,
            models.CustomerOrder.tenant_id == tenant_id
        ).first()
        if existing:
            return {
                "message": "Order already received",
                "order_id": existing.id,
                "order_number": existing.order_number,
                "tracking_token": existing.tracking_token
            }
    else:
        order_number = f"CUST-{secrets.token_hex(6).upper()}"

    tracking_token = secrets.token_urlsafe(24)

    total_amount = Decimal("0.00")
    order_items = []
    for line in body.items:
        product = products[line.product_id]
        unit_price = Decimal(str(product.price))
        total_amount += unit_price * line.quantity
        order_items.append(models.CustomerOrderItem(
            product_id=product.id,
            name=product.name,
            variant=line.variant.strip() if line.variant and line.variant.strip() else None,
            price=unit_price,
            quantity=line.quantity
        ))

    new_order = models.CustomerOrder(
        order_number=order_number,
        customer_name=customer_name,
        order_type=order_type,
        table_number=table_number,
        tenant_id=tenant_id,
        notes=notes,
        total_amount=total_amount,
        status="pending",
        payment_method=payment_method,
        payment_status=pay.PS_UNPAID,
        tracking_token=tracking_token
    )
    new_order.items = order_items

    try:
        db.add(new_order)
        db.commit()
    except IntegrityError:
        # Concurrent duplicate submission with the same idempotency key.
        db.rollback()
        existing = db.query(models.CustomerOrder).filter(models.CustomerOrder.order_number == order_number).first()
        if existing and existing.tenant_id == tenant_id:
            return {
                "message": "Order already received",
                "order_id": existing.id,
                "order_number": existing.order_number,
                "tracking_token": existing.tracking_token
            }
        logger.exception("Integrity error during customer order creation")
        raise HTTPException(status_code=500, detail="An internal error occurred while processing your order.")
    except Exception:
        db.rollback()
        logger.exception("Database error during customer order creation")
        raise HTTPException(status_code=500, detail="An internal error occurred while processing your order.")

    # Real-time notification to this tenant's authenticated staff. Never includes the tracking token.
    try:
        notify_realtime_event(tenant_id, "CUSTOMER_ORDER_CREATED", {
            "order_id": new_order.id,
            "order_number": new_order.order_number,
            "customer_name": new_order.customer_name,
            "table_number": new_order.table_number,
            "total_amount": float(new_order.total_amount)
        })
        notify_realtime_event(tenant_id, "ORDER_CREATED", {
            "order_id": new_order.id,
            "order_number": new_order.order_number
        })
    except Exception:
        logger.warning("Failed to broadcast customer order event", exc_info=True)

    return {
        "message": "Order placed successfully",
        "order_id": new_order.id,
        "order_number": new_order.order_number,
        "tracking_token": tracking_token
    }


@router.get("/pending", summary="Get all pending customer orders for the POS")
def get_pending_orders(
    request: Request,
    limit: int = Query(100, ge=1, le=200),
    current_user: models.User = Depends(require_pos_access),
    db: Session = Depends(get_db)
):
    """
    Polled by the POS cashier dashboard to show incoming orders.
    """
    tenant_id = resolve_tenant_id(current_user, db, request)
    orders = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(
        models.CustomerOrder.status == "pending",
        models.CustomerOrder.tenant_id == tenant_id
    ).order_by(models.CustomerOrder.created_at.asc()).limit(limit).all()

    context = _staff_context(db, tenant_id, orders)
    result = []
    for order in orders:
        data = _serialize_order(order, staff=True, context=context.get(order.id))
        data.pop("status", None)
        result.append(data)
    return result


@router.put("/{order_id}/status", summary="Update customer order status")
def update_customer_order_status(
    order_id: int,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    """
    Used by the POS to accept or reject a customer order. Staff only, scoped to the caller's tenant.
    """
    new_status = str(body.get("status") or "").strip().lower()
    if new_status not in CUSTOMER_ORDER_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid status")

    tenant_id = resolve_tenant_id(current_user, db, request)
    order = db.query(models.CustomerOrder).filter(
        models.CustomerOrder.id == order_id,
        models.CustomerOrder.tenant_id == tenant_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    apply_customer_order_status(order, new_status)
    if new_status == "rejected" and order.payment_status == pay.PS_VERIFIED:
        # No refund flow exists: record that a verified payment now needs handling outside the system.
        db.add(models.ActivityLog(
            tenant_id=tenant_id, user_id=current_user.id, action="Paid Order Rejected",
            performed_by=current_user.username,
            role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
            details=f"Order {order.order_number} rejected after its GCash payment was verified; refund is manual."[:255]
        ))
    db.commit()

    # Real-time WebSocket event broadcast (tenant-scoped)
    try:
        notify_realtime_event(order.tenant_id, "ORDER_UPDATED", {
            "order_id": order.id,
            "order_number": order.order_number,
            "status": new_status
        })
        notify_realtime_event(order.tenant_id, "CUSTOMER_ORDER_UPDATED", {
            "order_id": order.id,
            "order_number": order.order_number,
            "status": new_status,
            "payment_status": order.payment_status
        })
        notify_realtime_event(order.tenant_id, "KITCHEN_UPDATED", {
            "order_id": f"CUST-{order.id}",
            "order_number": order.order_number,
            "status": new_status.upper()
        })
    except Exception:
        logger.warning("Failed to broadcast customer order status event", exc_info=True)

    return {"message": f"Order marked as {new_status}", "order_id": order.id, "status": new_status}


@router.get("/history", summary="Recent customer orders for the staff's tenant")
def get_customer_history(
    request: Request,
    customer_name: Optional[str] = Query(None, max_length=100),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    """
    Staff-only order history for the caller's tenant, optionally filtered by customer name.
    """
    tenant_id = resolve_tenant_id(current_user, db, request)
    q = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(models.CustomerOrder.tenant_id == tenant_id)
    if customer_name and customer_name.strip():
        q = q.filter(models.CustomerOrder.customer_name.ilike(f"%{customer_name.strip()}%"))

    orders = q.order_by(models.CustomerOrder.created_at.desc()).offset(offset).limit(limit).all()
    context = _staff_context(db, tenant_id, orders)
    return [_serialize_order(order, staff=True, context=context.get(order.id)) for order in orders]


# ------------------------------------------------------------------------------------------------
# Manual GCash verification (no payment gateway: the cashier reads GCash history and types the amount)
# ------------------------------------------------------------------------------------------------
class GcashVerifyIn(BaseModel):
    """Only what the cashier observed. Expected amount, status and verifier are always server-side."""
    model_config = ConfigDict(extra="ignore")

    amount_received: Any = None
    reference_no: Optional[str] = Field(None, max_length=60)
    transaction_time: Optional[str] = Field(None, max_length=40)


class ResolveDiscrepancyIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    resolution: str = Field(..., max_length=20)
    note: str = Field(..., min_length=5, max_length=200)


def _broadcast_payment_event(order: models.CustomerOrder) -> None:
    """Status only: never amounts, references or discrepancy details."""
    try:
        notify_realtime_event(order.tenant_id, "CUSTOMER_ORDER_UPDATED", {
            "order_id": order.id,
            "order_number": order.order_number,
            "status": order.status,
            "payment_status": order.payment_status
        })
    except Exception:
        logger.warning("Failed to broadcast payment event", exc_info=True)


def _log(db: Session, user: models.User, tenant_id: int, action: str, details: str) -> None:
    db.add(models.ActivityLog(
        tenant_id=tenant_id, user_id=user.id, action=action, performed_by=user.username,
        role=user.role.value if hasattr(user.role, "value") else str(user.role), details=details[:255]
    ))


def _lock_order(db: Session, tenant_id: int, order_id: int) -> models.CustomerOrder:
    # selectinload (not joinedload): PostgreSQL rejects FOR UPDATE on the nullable side of an outer join.
    order = db.query(models.CustomerOrder).options(selectinload(models.CustomerOrder.items)).filter(
        models.CustomerOrder.id == order_id,
        models.CustomerOrder.tenant_id == tenant_id
    ).with_for_update().first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


def _swap_payment_status(db: Session, order: models.CustomerOrder, old: str, new: str) -> None:
    """Compare-and-swap so two simultaneous requests cannot both move the same order."""
    if old not in pay.PAYMENT_TRANSITIONS or new not in pay.PAYMENT_TRANSITIONS[old]:
        raise HTTPException(status_code=409, detail=f"Payment cannot move from {old} to {new}.")
    updated = db.query(models.CustomerOrder).filter(
        models.CustomerOrder.id == order.id, models.CustomerOrder.payment_status == old
    ).update({"payment_status": new}, synchronize_session=False)
    if updated != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="This order's payment was changed by someone else. Reload and check it again.")
    order.payment_status = new


def _verification_view(order: models.CustomerOrder, attempt: models.PaymentVerification, message: str) -> dict:
    return {
        "order_id": order.id,
        "order_number": order.order_number,
        "payment_method": order.payment_method,
        "payment_status": order.payment_status,
        "outcome": attempt.outcome,
        "verified": attempt.outcome == pay.OUTCOME_MATCHED,
        "expected_amount": float(attempt.expected_amount),
        "reported_amount": float(attempt.reported_amount),
        "discrepancy_amount": float(attempt.discrepancy_amount),
        "reference_no": attempt.reference_no,
        "message": message,
        "basis": "Cashier-reported amount from GCash transaction history; not confirmed by GCash.",
    }


@router.post("/{order_id}/payment/verify", summary="Cashier records the GCash amount actually received")
def verify_gcash_payment(
    order_id: int,
    body: GcashVerifyIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    tenant_id = resolve_tenant_id(current_user, db, request)
    order = _lock_order(db, tenant_id, order_id)
    if order.payment_method != pay.PAYMENT_GCASH:
        raise HTTPException(status_code=409, detail="Only GCash orders are verified this way.")
    if order.status == "rejected":
        raise HTTPException(status_code=409, detail="This order was rejected.")

    reported = pay.parse_reported_amount(body.amount_received)
    reference = pay.normalize_reference(body.reference_no)
    paid_at = pay.parse_transaction_time(body.transaction_time)
    expected = pay.amount_due_for_customer_order(order)

    if order.payment_status == pay.PS_VERIFIED:
        # Repeating the same verification is safe; a different amount or reference is refused.
        done = db.query(models.PaymentVerification).filter(
            models.PaymentVerification.customer_order_id == order.id,
            models.PaymentVerification.outcome == pay.OUTCOME_MATCHED
        ).order_by(models.PaymentVerification.id.desc()).first()
        if done and done.reported_amount == reported and (reference is None or reference == done.reference_no):
            return _verification_view(order, done, "Payment was already verified.")
        raise HTTPException(status_code=409, detail="This payment is already verified and cannot be changed.")
    if order.payment_status in (pay.PS_INVALID, pay.PS_COUNTER_PAID):
        raise HTTPException(status_code=409, detail="This order's payment can no longer be verified.")

    if reference:
        clash = db.query(models.PaymentVerification.id).filter(
            models.PaymentVerification.tenant_id == tenant_id,
            models.PaymentVerification.claimed_reference == reference,
            models.PaymentVerification.customer_order_id != order.id
        ).first()
        if clash:
            return _reject_duplicate_reference(db, current_user, tenant_id, order, reported, expected, reference, paid_at)

    matched = reported == expected
    attempt = models.PaymentVerification(
        tenant_id=tenant_id, customer_order_id=order.id, attempted_by=current_user.id,
        expected_amount=expected, reported_amount=reported, discrepancy_amount=reported - expected,
        reference_no=reference, transaction_time=paid_at,
        outcome=pay.OUTCOME_MATCHED if matched else pay.OUTCOME_MISMATCH,
        claimed_reference=reference if matched else None,
    )
    try:
        db.add(attempt)
        db.flush()
        if matched:
            _swap_payment_status(db, order, order.payment_status, pay.PS_VERIFIED)
            # A matching re-verification supersedes earlier open discrepancies (they stay on record).
            db.query(models.PaymentVerification).filter(
                models.PaymentVerification.customer_order_id == order.id,
                models.PaymentVerification.id != attempt.id,
                models.PaymentVerification.resolution.is_(None),
                models.PaymentVerification.outcome != pay.OUTCOME_MATCHED
            ).update({"resolution": "superseded", "resolved_by": current_user.id, "resolved_at": datetime.now(),
                      "resolution_note": "Re-verified with a matching amount."}, synchronize_session=False)
            _log(db, current_user, tenant_id, "GCash Payment Verified",
                 f"Order {order.order_number}: cashier reported exactly ₱{expected:,.2f} from GCash history.")
        else:
            if order.payment_status != pay.PS_DISCREPANCY:
                _swap_payment_status(db, order, order.payment_status, pay.PS_DISCREPANCY)
            _log(db, current_user, tenant_id, "GCash Payment Discrepancy",
                 f"Order {order.order_number}: expected ₱{expected:,.2f}, cashier reported ₱{reported:,.2f} "
                 f"(difference ₱{reported - expected:+,.2f}). Needs review.")
        db.commit()
    except HTTPException:
        raise
    except IntegrityError:
        # Another order claimed this reference between our check and the insert.
        db.rollback()
        order = _lock_order(db, tenant_id, order_id)
        return _reject_duplicate_reference(db, current_user, tenant_id, order, reported, expected, reference, paid_at)
    except Exception:
        db.rollback()
        logger.exception("Failed to record GCash verification")
        raise HTTPException(status_code=500, detail="Could not record the verification.")

    db.refresh(order)
    _broadcast_payment_event(order)
    if matched:
        return _verification_view(order, attempt, "Amount matches. GCash payment verified.")
    return _verification_view(order, attempt, "Amount does NOT match. The payment is flagged for review and the order cannot proceed.")


def _reject_duplicate_reference(db, user, tenant_id, order, reported, expected, reference, paid_at):
    """Audit the attempt, leave the order's payment state alone, and answer without naming the other order."""
    try:
        db.add(models.PaymentVerification(
            tenant_id=tenant_id, customer_order_id=order.id, attempted_by=user.id,
            expected_amount=expected, reported_amount=reported, discrepancy_amount=reported - expected,
            reference_no=reference, transaction_time=paid_at, outcome=pay.OUTCOME_DUPLICATE,
        ))
        _log(db, user, tenant_id, "GCash Duplicate Reference",
             f"Order {order.order_number}: a GCash reference already used to verify another order was entered.")
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Failed to audit duplicate GCash reference")
    raise HTTPException(
        status_code=409,
        detail="This GCash reference number was already used to verify another order. Check the reference in GCash history."
    )


@router.post("/{order_id}/payment/resolve", summary="Manager/admin closes a GCash discrepancy as invalid")
def resolve_payment_discrepancy(
    order_id: int,
    body: ResolveDiscrepancyIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    """
    The only resolution offered is 'invalid' (the payment cannot be accepted). Re-verifying with the
    correct amount is available to any POS user. Accepting a short/over payment is a business decision
    that has not been made, so it is deliberately not offered. The original attempts are kept.
    """
    if body.resolution.strip().lower() != "invalid":
        raise HTTPException(status_code=400, detail="Unsupported resolution. Only 'invalid' is available.")
    tenant_id = resolve_tenant_id(current_user, db, request)
    order = _lock_order(db, tenant_id, order_id)
    if order.payment_status != pay.PS_DISCREPANCY:
        raise HTTPException(status_code=409, detail="Only a payment with an open discrepancy can be resolved.")
    _swap_payment_status(db, order, pay.PS_DISCREPANCY, pay.PS_INVALID)
    db.query(models.PaymentVerification).filter(
        models.PaymentVerification.customer_order_id == order.id,
        models.PaymentVerification.resolution.is_(None),
        models.PaymentVerification.outcome != pay.OUTCOME_MATCHED
    ).update({"resolution": "invalidated", "resolved_by": current_user.id, "resolved_at": datetime.now(),
              "resolution_note": body.note.strip()}, synchronize_session=False)
    _log(db, current_user, tenant_id, "GCash Discrepancy Resolved",
         f"Order {order.order_number}: payment closed as invalid. Note: {body.note.strip()}")
    db.commit()
    db.refresh(order)
    _broadcast_payment_event(order)
    return {"order_id": order.id, "payment_status": order.payment_status, "message": "Discrepancy closed as invalid. The order can now be rejected."}


@router.get("/{order_id}/payment/attempts", summary="Verification audit trail (manager/admin)")
def list_payment_attempts(
    order_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    tenant_id = resolve_tenant_id(current_user, db, request)
    order = db.query(models.CustomerOrder.id).filter(
        models.CustomerOrder.id == order_id, models.CustomerOrder.tenant_id == tenant_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    names = {u.id: u.username for u in db.query(models.User.id, models.User.username).filter(models.User.tenant_id == tenant_id).all()}
    attempts = db.query(models.PaymentVerification).filter(
        models.PaymentVerification.tenant_id == tenant_id,
        models.PaymentVerification.customer_order_id == order_id
    ).order_by(models.PaymentVerification.id.asc()).all()
    return [{
        "id": a.id,
        "outcome": a.outcome,
        "attempted_by": names.get(a.attempted_by),
        "attempted_at": a.attempted_at.isoformat() if a.attempted_at else None,
        "expected_amount": float(a.expected_amount),
        "reported_amount": float(a.reported_amount),
        "discrepancy_amount": float(a.discrepancy_amount),
        "reference_no": a.reference_no,
        "transaction_time": a.transaction_time.isoformat() if a.transaction_time else None,
        "resolution": a.resolution,
        "resolved_by": names.get(a.resolved_by),
        "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
        "resolution_note": a.resolution_note,
    } for a in attempts]


@router.get("/track/{order_number}", summary="Track an order with its tracking token")
def track_customer_order(
    order_number: str,
    request: Request,
    x_tracking_token: Optional[str] = Header(None, alias="X-Tracking-Token", max_length=128),
    db: Session = Depends(get_db),
    _rl: None = Depends(track_limit),
):
    """
    Lets a customer follow their own order. Requires the order number AND the tracking token that
    was returned when the order was placed (sent in the X-Tracking-Token header).
    A wrong or missing token is indistinguishable from an unknown order (404).
    """
    failure_key = f"track-fail:{client_ip(request)}"
    if track_failure_limiter.is_limited(failure_key):
        raise HTTPException(status_code=429, detail="Too many requests. Please try again later.")

    order = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(models.CustomerOrder.order_number == order_number.strip().upper()).first()

    supplied = x_tracking_token or ""
    valid = bool(
        order and order.tracking_token and supplied
        and secrets.compare_digest(order.tracking_token.encode(), supplied.encode())
    )
    if not valid:
        track_failure_limiter.record(failure_key)
        raise HTTPException(status_code=404, detail="Order not found")

    return _serialize_order(order)


@router.get("/menu", summary="Get the public menu for a specific tenant")
def get_public_menu(
    tenant_id: Optional[int] = Query(None, gt=0),
    db: Session = Depends(get_db),
    _rl: None = Depends(menu_limit),
):
    """
    Public endpoint to fetch active categories and their active products for a specific tenant.
    """
    tenant_id = _resolve_public_tenant(db, tenant_id)

    categories = db.query(models.Category).filter(models.Category.tenant_id == tenant_id).all()
    active_products = db.query(models.Product).filter(
        models.Product.is_active.is_(True),
        models.Product.tenant_id == tenant_id
    ).all()

    by_category = {}
    for p in active_products:
        by_category.setdefault(p.category_id, []).append(p)

    def product_dict(p):
        return {
            "id": p.id,
            "sku": p.sku,
            "name": p.name,
            "price": float(p.price),
            "is_active": bool(p.is_active),
            "image_url": getattr(p, "image_url", None)
        }

    result = []
    for cat in categories:
        products = by_category.get(cat.id)
        if not products:
            continue
        result.append({
            "id": cat.id,
            "name": cat.name,
            "description": cat.description,
            "products": [product_dict(p) for p in products]
        })

    # Also include products without a category
    uncat_products = by_category.get(None)
    if uncat_products:
        result.append({
            "id": 0,
            "name": "Other",
            "description": "Other items",
            "products": [product_dict(p) for p in uncat_products]
        })

    return result


# Defined last on purpose: "/{order_id}" must not shadow the static GET paths above (/pending, /history, /menu).
@router.get("/{order_id}", summary="One customer order with its payment state (staff)")
def get_customer_order(
    order_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access),
):
    tenant_id = resolve_tenant_id(current_user, db, request)
    order = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(
        models.CustomerOrder.id == order_id,
        models.CustomerOrder.tenant_id == tenant_id
    ).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    context = _staff_context(db, tenant_id, [order])
    return _serialize_order(order, staff=True, context=context.get(order.id))
