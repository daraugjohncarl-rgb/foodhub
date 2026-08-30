"""
Kitchen Router — Kitchen Display System (KDS)
=============================================
Handles live kitchen orders, item checklist status, and order completion for kitchen display.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from datetime import datetime, timedelta

from app.db import get_db
import app.models as models
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/kitchen", tags=["Kitchen — KDS"])

@router.get("/orders", summary="Fetch active kitchen orders")
def get_kitchen_orders(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Returns transactions with their ordered items formatted for the Kitchen Display System (KDS).
    """
    # Fetch recent transactions within the last 24 hours
    since_time = datetime.now() - timedelta(hours=24)
    q = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product),
        joinedload(models.Transaction.user)
    ).filter(models.Transaction.created_at >= since_time)

    if current_user.tenant_id:
        q = q.filter(models.Transaction.tenant_id == current_user.tenant_id)

    transactions = q.order_by(models.Transaction.created_at.desc()).limit(50).all()

    orders = []
    for tx in transactions:
        orders.append({
            "id": f"ORD-{tx.id:04d}",
            "raw_id": tx.id,
            "table": "Takeout" if not tx.client_tx_id else "Dine-In",
            "time": tx.created_at.strftime("%I:%M %p") if tx.created_at else "Just now",
            "server": tx.user.username if tx.user else "Cashier",
            "status": tx.status.upper() if tx.status else "PENDING",
            "items": [
                {
                    "id": item.id,
                    "name": item.product.name if item.product else f"Item #{item.product_id}",
                    "qty": item.quantity,
                    "notes": "",
                    "done": tx.status == "completed"
                }
                for item in tx.items
            ]
        })
    return orders


@router.put("/orders/{order_id}/status", summary="Update kitchen order status")
def update_order_status(
    order_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Updates the status of an order (e.g., PENDING, PREPARING, READY, COMPLETED).
    """
    new_status = body.get("status", "COMPLETED").lower()
    
    # Extract numeric ID if prefixed like ORD-0010
    numeric_id = order_id.replace("ORD-", "") if isinstance(order_id, str) else order_id
    try:
        tx_id = int(numeric_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid order ID format.")

    tx = db.query(models.Transaction).filter(models.Transaction.id == tx_id).first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found.")

    tx.status = new_status
    db.commit()

    return {
        "id": order_id,
        "status": new_status,
        "message": f"Order status updated to {new_status}"
    }
