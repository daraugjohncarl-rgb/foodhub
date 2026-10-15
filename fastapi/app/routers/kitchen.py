"""
Kitchen Router — Kitchen Display System (KDS)
=============================================
Live kitchen tickets and their preparation state.

The kitchen only changes Transaction.fulfillment_status. Whether a sale counts as revenue is decided by its
payment status, never by the kitchen (C6). Every lookup is scoped to the caller's branch (C9).
"""
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core import audit
from app.core.dependencies import require_permission, resolve_tenant_id
from app.core.timeutils import to_business, utcnow

router = APIRouter(prefix="/kitchen", tags=["Kitchen — KDS"])

# Allowed kitchen transitions. Re-sending the current state is accepted (idempotent button presses).
ALLOWED_TRANSITIONS = {
    "pending": {"preparing", "ready", "completed", "cancelled"},
    "preparing": {"ready", "completed", "cancelled", "pending"},
    "ready": {"completed", "preparing"},
    "completed": set(),
    "cancelled": set(),
}


def _ticket(tx: models.Transaction) -> dict:
    fulfillment = tx.fulfillment_status or models.FulfillmentStatus.PENDING.value
    local_time = to_business(tx.created_at)
    return {
        "id": f"ORD-{tx.id:04d}",
        "raw_id": tx.id,
        "order_type": tx.order_type,
        "table_number": tx.table_number,
        # Display label derived from the real order type / table (M1).
        "table": (f"Table {tx.table_number}" if tx.table_number else (tx.order_type or "Walk-in")),
        "time": local_time.strftime("%I:%M %p") if local_time else "Just now",
        "server": tx.user.username if tx.user else "Cashier",
        "status": fulfillment.upper(),
        "notes": tx.customer_order.notes if tx.customer_order is not None else None,
        "items": [
            {
                "id": item.id,
                "name": item.product.name if item.product else f"Item #{item.product_id}",
                "qty": item.quantity,
                "notes": "",
                "done": fulfillment in ("ready", "completed"),
            }
            for item in tx.items
        ],
    }


@router.get("/orders", summary="Fetch active kitchen orders")
def get_kitchen_orders(
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to view"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("kitchen.read")),
):
    """
    Tickets from the last 24 hours for the caller's branch (cancelled and voided sales excluded).
    """
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    since_time = utcnow() - timedelta(hours=24)
    transactions = (
        db.query(models.Transaction)
        .options(
            joinedload(models.Transaction.items).joinedload(models.TransactionItem.product),
            joinedload(models.Transaction.user),
            joinedload(models.Transaction.customer_order),
        )
        .filter(
            models.Transaction.tenant_id == scope_tenant,
            models.Transaction.created_at >= since_time,
            models.Transaction.status.notin_(models.NON_REVENUE_TRANSACTION_STATUSES),
            models.Transaction.fulfillment_status != models.FulfillmentStatus.CANCELLED.value,
        )
        .order_by(models.Transaction.created_at.desc())
        .limit(50)
        .all()
    )
    return [_ticket(tx) for tx in transactions]


@router.put("/orders/{order_id}/status", summary="Update kitchen order status")
def update_order_status(
    order_id: str,
    body: schemas.KitchenStatusUpdate,
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("kitchen.update")),
):
    """
    Updates the preparation state: pending -> preparing -> ready -> completed (or cancelled).
    """
    numeric_id = order_id.upper().replace("ORD-", "")
    try:
        tx_id = int(numeric_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid order ID format.")

    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    tx = (
        db.query(models.Transaction)
        .filter(models.Transaction.id == tx_id, models.Transaction.tenant_id == scope_tenant)
        .with_for_update()
        .first()
    )
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found.")

    current = tx.fulfillment_status or models.FulfillmentStatus.PENDING.value
    new_status = body.status
    if new_status != current and new_status not in ALLOWED_TRANSITIONS.get(current, set()):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot change an order from {current} to {new_status}.",
        )

    tx.fulfillment_status = new_status
    if new_status != current:
        audit.record(db, current_user, "Kitchen Status", tenant_id=scope_tenant,
                     details=f"Order #{tx.id}: {current} -> {new_status}")
    db.commit()

    return {
        "id": order_id,
        "status": new_status.upper(),
        "message": f"Order status updated to {new_status}"
    }
