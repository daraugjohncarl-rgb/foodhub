"""
Kitchen Router — Kitchen Display System (KDS) & Drinks Counter
==============================================================
Handles live kitchen orders (food only) and cashier drinks orders (drinks only).
Implements authoritative station-based item routing and cross-role order handoff.
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query, Request
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional, Any
from datetime import datetime, timedelta

from app.db import get_db
import app.models as models
from app.core.dependencies import require_kitchen_access, resolve_tenant_id
from app.routers.customer_orders import change_customer_order_status, _lock_order

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

RETAIL_KEYWORDS = {
    'bottled water', 'water bottle', 'mineral water', 'wilkins',
    'canned', 'can of', 'coke can', 'sprite can', 'royal can',
    'packaged', 'retail', 'chips'
}


KITCHEN_STATUSES = {"pending", "accepted", "preparing", "ready", "completed", "cancelled", "rejected"}


def get_product_station(product: Any) -> str:
    """
    Authoritative resolution of product preparation destination:
    Returns: 'kitchen', 'drinks', or 'none'.
    """
    if not product:
        return "none"

    # 1. Authoritative explicit column from product configuration
    explicit = (getattr(product, "preparation_station", None) or "").lower().strip()
    if explicit in ("kitchen", "drinks", "none", "packaged", "retail"):
        if explicit in ("packaged", "retail"):
            return "none"
        return explicit

    # 2. Category and Name fallback inspection
    cat_name = (product.category.name if getattr(product, "category", None) else "").lower().strip()
    prod_name = (getattr(product, "name", "") or "").lower().strip()

    # Ready-to-serve retail items that do not require preparation
    if any(k in prod_name for k in RETAIL_KEYWORDS):
        return "none"

    # Drinks station
    if cat_name in DRINK_CATEGORIES or any(k in cat_name for k in DRINK_KEYWORDS):
        return "drinks"
    if any(k in prod_name for k in ITEM_DRINK_KEYWORDS):
        return "drinks"

    # Default to kitchen for food, burgers, pasta, hot snacks, cooking
    return "kitchen"


def is_kitchen_item(product: Any) -> bool:
    return get_product_station(product) == "kitchen"


def is_drink_item(product: Any) -> bool:
    return get_product_station(product) == "drinks"


def is_kitchen_name(name: str) -> bool:
    n = (name or "").lower().strip()
    if any(k in n for k in RETAIL_KEYWORDS):
        return False
    if any(k in n for k in ITEM_DRINK_KEYWORDS):
        return False
    return True


def is_drink_name(name: str) -> bool:
    n = (name or "").lower().strip()
    if any(k in n for k in RETAIL_KEYWORDS):
        return False
    return any(k in n for k in ITEM_DRINK_KEYWORDS)


@router.get("/orders", summary="Fetch active kitchen or drinks orders")
def get_kitchen_orders(
    request: Request,
    type: Optional[str] = Query("food", description="Filter order items: 'food', 'drinks', or 'all'"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_kitchen_access),
):
    """
    Returns orders formatted for KDS / Drinks counter.
    - When type='food', returns only orders with kitchen-preparation items, with only kitchen items included.
    - When type='drinks', returns only orders with drinks items, with only drink items included.
    - Automatically includes both POS Cashier Transactions and Accepted Customer Table QR orders.
    - Prevents empty tickets.
    """
    filter_type = (type or "food").lower().strip()
    tenant_id = resolve_tenant_id(current_user, db, request)
    since_time = datetime.now() - timedelta(hours=24)
    orders = []

    # 1. QUERY TRANSACTIONS (POS Cashier checkouts)
    tx_q = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product).joinedload(models.Product.category),
        joinedload(models.Transaction.user)
    ).filter(
        models.Transaction.created_at >= since_time,
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        ~models.Transaction.fulfillment_status.in_(["cancelled", "rejected"])
    )

    tx_q = tx_q.filter(models.Transaction.tenant_id == tenant_id)

    transactions = tx_q.order_by(models.Transaction.created_at.desc()).limit(60).all()

    for tx in transactions:
        # Filter items strictly by station
        if filter_type == "drinks":
            selected_items = [it for it in tx.items if is_drink_item(it.product)]
            station_status = (getattr(tx, "fulfillment_status", None) or "PENDING").upper()
        elif filter_type == "all":
            selected_items = list(tx.items)
            station_status = (getattr(tx, "fulfillment_status", None) or "PENDING").upper()
        else: # "food" by default
            selected_items = [it for it in tx.items if is_kitchen_item(it.product)]
            station_status = (getattr(tx, "fulfillment_status", None) or "PENDING").upper()

        # Omit ticket completely if no items match the requested station
        if not selected_items:
            continue

        orders.append({
            "id": f"ORD-{tx.id:04d}",
            "raw_id": tx.id,
            "order_type": "pos",
            "table": "Takeout" if not tx.client_tx_id else "Dine-In",
            "time": tx.created_at.strftime("%I:%M %p") if tx.created_at else "Just now",
            "created_at_dt": tx.created_at,
            "server": tx.user.username if tx.user else "Cashier",
            "status": station_status,
            "station": filter_type,
            "items": [
                {
                    "id": item.id,
                    "name": item.product.name if item.product else f"Item #{item.product_id}",
                    "qty": item.quantity,
                    "notes": "",
                    "is_drink": is_drink_item(item.product),
                    "done": station_status in ["COMPLETED", "READY"]
                }
                for item in selected_items
            ]
        })

    # 2. QUERY ACCEPTED CUSTOMER TABLE QR ORDERS
    cust_q = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items).joinedload(models.CustomerOrderItem.product).joinedload(models.Product.category)
    ).filter(
        models.CustomerOrder.created_at >= since_time,
        models.CustomerOrder.status.in_(["accepted", "preparing", "ready"])
    )

    cust_q = cust_q.filter(models.CustomerOrder.tenant_id == tenant_id)

    customer_orders = cust_q.order_by(models.CustomerOrder.created_at.desc()).limit(40).all()

    for co in customer_orders:
        if filter_type == "drinks":
            selected_items = [
                it for it in co.items
                if (it.product and is_drink_item(it.product)) or (not it.product and is_drink_name(it.name))
            ]
        elif filter_type == "all":
            selected_items = list(co.items)
        else: # "food" by default
            selected_items = [
                it for it in co.items
                if (it.product and is_kitchen_item(it.product)) or (not it.product and is_kitchen_name(it.name))
            ]

        # Omit ticket if no matching items for this station
        if not selected_items:
            continue

        co_status = (co.status or "ACCEPTED").upper()
        # Map "ACCEPTED" to "PENDING" for standard KDS display
        if co_status == "ACCEPTED":
            co_status = "PENDING"

        orders.append({
            "id": co.order_number or f"CUST-{co.id:04d}",
            "raw_id": f"CUST-{co.id}",
            "order_type": "customer_qr",
            "table": f"Table {co.table_number}" if co.table_number else (co.order_type or "Takeout"),
            "time": co.created_at.strftime("%I:%M %p") if co.created_at else "Just now",
            "created_at_dt": co.created_at,
            "server": f"Customer ({co.customer_name})",
            "status": co_status,
            "station": filter_type,
            "items": [
                {
                    "id": item.id,
                    "name": item.name,
                    "qty": item.quantity,
                    "notes": co.notes or "",
                    "is_drink": is_drink_item(item.product) if item.product else is_drink_name(item.name),
                    "done": co_status in ["COMPLETED", "READY"]
                }
                for item in selected_items
            ]
        })

    # Sort combined tickets by creation timestamp descending (newest first)
    orders.sort(key=lambda o: o.get("created_at_dt") or datetime.min, reverse=True)
    for o in orders:
        o.pop("created_at_dt", None)

    return orders


@router.get("/drinks-orders", summary="Fetch active drinks orders for Cashier")
def get_cashier_drink_orders(
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_kitchen_access),
):
    """
    Convenience endpoint for cashier to fetch live drink orders.
    """
    return get_kitchen_orders(request=request, type="drinks", db=db, current_user=current_user)


@router.put("/orders/{order_id}/status", summary="Update kitchen or customer order status")
def update_order_status(
    order_id: str,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_kitchen_access),
):
    """
    Updates the preparation/fulfillment status of a kitchen or drinks order.
    Supports both Transaction orders ('ORD-0005', '5') and Customer orders ('CUST-0005', 'CUST-5').
    Preserves financial status and prevents duplicate state collisions.
    """
    new_status = str(body.get("status") or "COMPLETED").lower().strip()
    station = str(body.get("station") or "food").lower().strip()
    order_str = str(order_id).strip()
    if new_status not in KITCHEN_STATUSES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid status.")
    if station not in ("food", "drinks", "kitchen"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid station.")
    tenant_id = resolve_tenant_id(current_user, db, request)

    # 1. HANDLE CUSTOMER QR ORDERS (CUST- prefix)
    if order_str.startswith("CUST-"):
        try:
            cust_id = int(order_str.replace("CUST-", ""))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid customer order ID.")

        # Same locked path and rules as PUT /customer-orders/{id}/status (payment disputes, final states,
        # no rejection while a sale is recorded), so the kitchen cannot bypass them.
        order = _lock_order(db, tenant_id, cust_id)

        # Map KDS statuses to CustomerOrder statuses
        target_status = "completed" if new_status in ["completed", "ready"] else new_status
        if target_status == "cancelled":
            target_status = "rejected"
        try:
            change_customer_order_status(db, order, target_status, current_user)
            db.commit()
        except HTTPException:
            db.rollback()
            raise

        # Real-time WebSocket notifications
        try:
            from app.core.websocket import notify_realtime_event
            notify_realtime_event(order.tenant_id, "KITCHEN_UPDATED", {
                "order_id": order_str,
                "status": target_status,
                "station": station
            })
            notify_realtime_event(order.tenant_id, "CUSTOMER_ORDER_UPDATED", {
                "order_id": order.id,
                "order_number": order.order_number,
                "status": target_status,
                "payment_status": order.payment_status
            })
            notify_realtime_event(order.tenant_id, "ORDER_UPDATED", {
                "order_id": order.id,
                "status": target_status
            })
        except Exception:
            pass

        return {
            "id": order_str,
            "status": target_status.upper(),
            "station": station,
            "message": f"Customer order status updated to {target_status.upper()}"
        }

    # 2. HANDLE POS TRANSACTION ORDERS
    numeric_id = order_str.replace("ORD-", "")
    try:
        tx_id = int(numeric_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid order ID format.")

    if new_status in ("rejected", "cancelled"):
        # Voiding a sale is a financial reversal (payments, refund flag, stock, audit) and goes through
        # PUT /transactions/{id}/status. This endpoint used to flip the sale to cancelled while leaving its
        # payments counted as completed.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="A POS sale is voided from Today's Orders (cashier/manager), not from the kitchen screen.")

    tx = db.query(models.Transaction).filter(
        models.Transaction.id == tx_id,
        models.Transaction.tenant_id == tenant_id
    ).with_for_update().first()

    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction order not found.")

    if tx.status in ["rejected", "cancelled"]:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Order #{tx.id} has already been {tx.status.upper()}. Its status is locked and cannot be changed."
        )
    if tx.fulfillment_status == "completed" and new_status != "completed":
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"Order #{tx.id} was already completed and cannot be reopened.")

    # Update fulfillment_status only; the sale's financial status and payments are never touched here.
    tx.fulfillment_status = new_status

    db.commit()

    # Real-time WebSocket event broadcast
    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tx.tenant_id, "KITCHEN_UPDATED", {
            "order_id": f"ORD-{tx.id:04d}",
            "raw_id": tx.id,
            "status": new_status.upper(),
            "station": station
        })
        notify_realtime_event(tx.tenant_id, "ORDER_UPDATED", {
            "order_id": tx.id,
            "status": tx.fulfillment_status
        })
    except Exception:
        pass

    return {
        "id": f"ORD-{tx.id:04d}",
        "status": new_status.upper(),
        "station": station,
        "message": f"Order status updated to {new_status.upper()}"
    }


@router.put("/orders/{order_id}/drinks-status", summary="Update cashier drink order status")
def update_drinks_order_status(
    order_id: str,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_kitchen_access),
):
    """
    Dedicated endpoint for Cashier to update drink preparation/served status.
    """
    body["station"] = "drinks"
    return update_order_status(order_id=order_id, body=body, request=request, db=db, current_user=current_user)
