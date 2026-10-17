from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional, Dict, Any
from decimal import Decimal
import uuid
import secrets
import traceback
import logging

from app.db import get_db
import app.models as models
from app.core.dependencies import get_current_user
from app.core.websocket import notify_realtime_event

logger = logging.getLogger("pos_customer_orders")

router = APIRouter(prefix="/customer-orders", tags=["Customer Orders"])


@router.post("", status_code=status.HTTP_201_CREATED, summary="Submit a customer order from the QR menu")
def submit_customer_order(body: dict, db: Session = Depends(get_db)):
    """
    Called by the customer QR menu to submit a new order.
    Generates order number and tracking token, calculates total, saves items, and emits WebSocket event.
    """
    tenant_id = int(body.get("tenant_id") or 1)
    customer_name = body.get("customer_name")
    order_type = body.get("order_type") or "dine_in"
    table_number = body.get("table_number")
    if table_number is not None:
        table_number = str(table_number)

    notes = body.get("notes")
    if notes is not None:
        notes = str(notes)

    items = body.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="Missing order items in order")

    if not customer_name or not str(customer_name).strip():
        if table_number and str(table_number).strip():
            customer_name = f"Table {str(table_number).strip()} Guest"
        else:
            customer_name = "Guest Customer"
    else:
        customer_name = str(customer_name).strip()

    order_number = body.get("order_number")
    if not order_number:
        order_number = f"CUST-{uuid.uuid4().hex[:6].upper()}"

    tracking_token = secrets.token_urlsafe(24)

    total_amount = Decimal("0.0")
    valid_items = []

    for item in items:
        prod_id = item.get("product_id") or item.get("id")
        name = item.get("name")
        qty = int(item.get("quantity") or 1)
        if qty <= 0:
            continue

        price_val = Decimal(str(item.get("price", 0)))
        variant = item.get("variant")

        # Cross-check product from database if product_id is provided
        if prod_id:
            db_product = db.query(models.Product).filter(
                models.Product.id == prod_id,
                models.Product.tenant_id == tenant_id
            ).first()
            if db_product:
                if not name:
                    name = db_product.name
                if price_val <= Decimal("0"):
                    price_val = Decimal(str(db_product.price))

        if not name:
            name = f"Item #{prod_id or 'Unknown'}"

        subtotal = price_val * qty
        total_amount += subtotal

        valid_items.append(models.CustomerOrderItem(
            product_id=prod_id,
            name=name,
            variant=variant,
            price=price_val,
            quantity=qty
        ))

    if not valid_items:
        raise HTTPException(status_code=400, detail="No valid items provided in order.")

    try:
        new_order = models.CustomerOrder(
            order_number=order_number,
            customer_name=customer_name,
            order_type=order_type,
            table_number=table_number,
            tenant_id=tenant_id,
            notes=notes,
            total_amount=total_amount,
            status="pending"
        )
        if hasattr(models.CustomerOrder, "tracking_token"):
            new_order.tracking_token = tracking_token

        db.add(new_order)
        db.flush()

        for new_item in valid_items:
            new_item.customer_order_id = new_order.id
            db.add(new_item)

        db.commit()

        # Real-time WebSocket event broadcast
        try:
            notify_realtime_event(tenant_id, "CUSTOMER_ORDER_CREATED", {
                "order_id": new_order.id,
                "order_number": new_order.order_number,
                "customer_name": new_order.customer_name,
                "table_number": new_order.table_number,
                "total_amount": float(new_order.total_amount),
                "tracking_token": tracking_token
            })
            notify_realtime_event(tenant_id, "ORDER_CREATED", {
                "order_id": new_order.id,
                "order_number": new_order.order_number
            })
        except Exception:
            pass
    except Exception as e:
        db.rollback()
        error_msg = f"Database error during customer order creation:\n{traceback.format_exc()}"
        logger.error(error_msg)
        raise HTTPException(status_code=500, detail="An internal error occurred while processing your order.")

    return {
        "message": "Order placed successfully",
        "order_id": new_order.id,
        "order_number": new_order.order_number,
        "tracking_token": tracking_token
    }


@router.get("/pending", summary="Get all pending customer orders for the POS")
def get_pending_orders(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """
    Polled by the POS cashier dashboard to show incoming orders.
    """
    tenant_id = current_user.tenant_id or 1
    orders = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(
        models.CustomerOrder.status == "pending",
        models.CustomerOrder.tenant_id == tenant_id
    ).order_by(models.CustomerOrder.created_at.asc()).all()

    result = []
    for order in orders:
        result.append({
            "id": order.id,
            "order_number": order.order_number,
            "customer_name": order.customer_name,
            "order_type": order.order_type,
            "table_number": order.table_number,
            "notes": order.notes,
            "total_amount": float(order.total_amount),
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
        })

    return result


@router.put("/{order_id}/status", summary="Update customer order status")
def update_customer_order_status(order_id: int, body: dict, db: Session = Depends(get_db)):
    """
    Used by the POS to accept or reject a customer order.
    """
    new_status = body.get("status")
    if new_status not in ["pending", "accepted", "rejected", "completed"]:
        raise HTTPException(status_code=400, detail="Invalid status")

    order = db.query(models.CustomerOrder).filter(models.CustomerOrder.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    order.status = new_status
    db.commit()

    # Real-time WebSocket event broadcast
    try:
        notify_realtime_event(order.tenant_id or 1, "ORDER_UPDATED", {
            "order_id": order.id,
            "order_number": order.order_number,
            "status": new_status
        })
        notify_realtime_event(order.tenant_id or 1, "CUSTOMER_ORDER_UPDATED", {
            "order_id": order.id,
            "order_number": order.order_number,
            "status": new_status
        })
    except Exception:
        pass

    return {"message": f"Order marked as {new_status}", "order_id": order.id, "status": new_status}


@router.get("/history", summary="Get customer past orders by name or tenant")
def get_customer_history(customer_name: Optional[str] = None, limit: int = 20, db: Session = Depends(get_db)):
    """
    Returns recent customer orders filtered by customer name.
    """
    q = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    )
    if customer_name and customer_name.strip():
        q = q.filter(models.CustomerOrder.customer_name.ilike(f"%{customer_name.strip()}%"))

    orders = q.order_by(models.CustomerOrder.created_at.desc()).limit(limit).all()

    result = []
    for order in orders:
        result.append({
            "id": order.id,
            "order_number": order.order_number,
            "customer_name": order.customer_name,
            "order_type": order.order_type,
            "table_number": order.table_number,
            "status": order.status,
            "notes": order.notes,
            "total_amount": float(order.total_amount),
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
        })
    return result


@router.get("/track/{order_number}", summary="Track order status by order number")
def track_customer_order(order_number: str, db: Session = Depends(get_db)):
    """
    Allows customers to track the status of their order live.
    """
    order = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(models.CustomerOrder.order_number == order_number.strip().upper()).first()

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    return {
        "id": order.id,
        "order_number": order.order_number,
        "customer_name": order.customer_name,
        "order_type": order.order_type,
        "table_number": order.table_number,
        "status": order.status,
        "notes": order.notes,
        "total_amount": float(order.total_amount),
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


@router.get("/menu", summary="Get the public menu for a specific tenant")
def get_public_menu(tenant_id: int = 1, db: Session = Depends(get_db)):
    """
    Public endpoint to fetch active categories and their active products for a specific tenant.
    """
    categories = db.query(models.Category).filter(models.Category.tenant_id == tenant_id).all()

    result = []
    for cat in categories:
        products = db.query(models.Product).filter(
            models.Product.category_id == cat.id,
            models.Product.is_active != False,
            models.Product.is_active != 0,
            models.Product.is_active.isnot(None),
            models.Product.tenant_id == tenant_id
        ).all()

        if not products:
            continue

        result.append({
            "id": cat.id,
            "name": cat.name,
            "description": cat.description,
            "products": [
                {
                    "id": p.id,
                    "sku": p.sku,
                    "name": p.name,
                    "price": float(p.price),
                    "is_active": bool(p.is_active),
                    "image_url": getattr(p, "image_url", None)
                } for p in products
            ]
        })

    return result
