"""
Kitchen Router — Kitchen Display System (KDS) & Drinks Counter
==============================================================
Handles live kitchen orders (food only) and cashier drinks orders (drinks only).
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from datetime import datetime, timedelta

from app.db import get_db
import app.models as models
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/kitchen", tags=["Kitchen — KDS & Drinks"])

DRINK_CATEGORIES = {
    'non-alcoholic drinks', 'alcoholic drinks', 'gen-z tower',
    'milktea w/ boba pearls', 'sticky milk', 'milky shake frappe',
    'cold coffee', 'hot coffee', 'beverages', 'drinks', 'bar'
}

DRINK_KEYWORDS = {
    'drink', 'tower', 'milktea', 'milk tea', 'shake', 'frappe', 
    'coffee', 'beverage', 'juice', 'beer', 'liquor', 'cocktail', 
    'bar', 'sticky milk'
}

ITEM_DRINK_KEYWORDS = {
    'coke', 'water', 'sting', 'dew', 'royal', 'beer', 'tanduay', 
    'smirnoff', 'clvb', 'pelsin', 'eagle', 'gin', 'bucket ice', 
    'ice bucket', 'latte', 'matcha milk', 'matcha latte', 'americano', 
    'barako', 'frappe', 'milktea', 'milk tea', 'shake', 'boba', 
    'coffee', 'tea', 'sprite'
}


def is_drink_item(product) -> bool:
    if not product:
        return False
    cat_name = (product.category.name if getattr(product, "category", None) else "").lower().strip()
    prod_name = (product.name or "").lower().strip()

    if cat_name in DRINK_CATEGORIES:
        return True
    if any(k in cat_name for k in DRINK_KEYWORDS):
        return True
    if any(k in prod_name for k in ITEM_DRINK_KEYWORDS):
        return True
    return False


def is_food_item(product) -> bool:
    return not is_drink_item(product)


@router.get("/orders", summary="Fetch active kitchen or drinks orders")
def get_kitchen_orders(
    type: Optional[str] = Query("food", description="Filter order items: 'food', 'drinks', or 'all'"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Returns transactions formatted for KDS / Drinks counter.
    By default (type='food'), only returns orders that contain food items, with only the food items.
    When type='drinks', only returns orders that contain drink items, with only the drink items for the cashier.
    """
    filter_type = (type or "food").lower().strip()

    # Fetch recent transactions within the last 24 hours
    since_time = datetime.now() - timedelta(hours=24)
    q = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product).joinedload(models.Product.category),
        joinedload(models.Transaction.user)
    ).filter(
        models.Transaction.created_at >= since_time,
        ~models.Transaction.status.in_(["cancelled", "rejected"])
    )

    if current_user.tenant_id:
        q = q.filter(models.Transaction.tenant_id == current_user.tenant_id)

    transactions = q.order_by(models.Transaction.created_at.desc()).limit(50).all()

    orders = []
    for tx in transactions:
        # Determine items based on requested filter
        if filter_type == "drinks":
            selected_items = [it for it in tx.items if is_drink_item(it.product)]
            # Status for drinks comes from fulfillment_status (or status fallback)
            tx_status = (getattr(tx, "fulfillment_status", None) or tx.status or "PENDING").upper()
        elif filter_type == "all":
            selected_items = list(tx.items)
            tx_status = (tx.status or "PENDING").upper()
        else: # "food" by default
            selected_items = [it for it in tx.items if is_food_item(it.product)]
            tx_status = (tx.status or "PENDING").upper()

        # If this ticket has no matching items for this station, omit it completely
        if not selected_items:
            continue

        orders.append({
            "id": f"ORD-{tx.id:04d}",
            "raw_id": tx.id,
            "table": "Takeout" if not tx.client_tx_id else "Dine-In",
            "time": tx.created_at.strftime("%I:%M %p") if tx.created_at else "Just now",
            "server": tx.user.username if tx.user else "Cashier",
            "status": tx_status,
            "station": filter_type,
            "items": [
                {
                    "id": item.id,
                    "name": item.product.name if item.product else f"Item #{item.product_id}",
                    "qty": item.quantity,
                    "notes": "",
                    "is_drink": is_drink_item(item.product),
                    "done": tx_status in ["COMPLETED", "READY"]
                }
                for item in selected_items
            ]
        })
    return orders


@router.get("/drinks-orders", summary="Fetch active drinks orders for Cashier")
def get_cashier_drink_orders(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Convenience endpoint for cashier to fetch live drink orders.
    """
    return get_kitchen_orders(type="drinks", db=db, current_user=current_user)


@router.put("/orders/{order_id}/status", summary="Update kitchen order status")
def update_order_status(
    order_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Updates the status of an order (e.g., PENDING, PREPARING, READY, COMPLETED).
    If station == 'drinks', updates the fulfillment_status for drinks instead.
    """
    new_status = body.get("status", "COMPLETED").lower()
    station = body.get("station", "food").lower()
    
    # Extract numeric ID if prefixed like ORD-0010
    numeric_id = order_id.replace("ORD-", "") if isinstance(order_id, str) else order_id
    try:
        tx_id = int(numeric_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid order ID format.")

    tx = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product).joinedload(models.Product.category)
    ).filter(models.Transaction.id == tx_id).first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found.")

    if tx.status in ["rejected", "cancelled"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Order #{tx.id} has already been {tx.status.upper()}. Once an order is rejected, its status is locked and cannot be changed."
        )

    if station == "drinks":
        tx.fulfillment_status = new_status
        # If the order has no food items, also mark tx.status
        has_food = any(is_food_item(it.product) for it in tx.items)
        if not has_food:
            tx.status = new_status
    else:
        tx.status = new_status
        # If the order has no drinks, keep fulfillment_status in sync
        has_drinks = any(is_drink_item(it.product) for it in tx.items)
        if not has_drinks:
            tx.fulfillment_status = new_status

    db.commit()

    # Real-time WebSocket event broadcast
    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tx.tenant_id or 1, "KITCHEN_UPDATED", {
            "order_id": order_id,
            "status": new_status,
            "station": station
        })
        notify_realtime_event(tx.tenant_id or 1, "ORDER_UPDATED", {
            "order_id": tx.id,
            "status": tx.status
        })
    except Exception:
        pass

    return {
        "id": order_id,
        "status": new_status,
        "station": station,
        "message": f"Order status updated to {new_status}"
    }


@router.put("/orders/{order_id}/drinks-status", summary="Update cashier drink order status")
def update_drinks_order_status(
    order_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Dedicated endpoint for Cashier to update drink preparation/served status.
    """
    body["station"] = "drinks"
    return update_order_status(order_id=order_id, body=body, db=db, current_user=current_user)

