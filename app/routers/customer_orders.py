import secrets
from decimal import Decimal
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status, Query, Request
from sqlalchemy.orm import Session, joinedload

from app.db import get_db
import app.models as models
import app.schemas as schemas

router = APIRouter(prefix="/customer-orders", tags=["Customer Orders"])


def _money(val) -> float:
    return float(val or 0.0)


def _items(order: models.CustomerOrder):
    return [
        {
            "name": item.name,
            "variant": item.variant,
            "price": _money(item.price),
            "quantity": item.quantity,
            "product_id": getattr(item, "product_id", None)
        } for item in (order.items or [])
    ]


def _staff_view(order: models.CustomerOrder) -> dict:
    return {
        "id": order.id,
        "order_number": order.order_number,
        "customer_name": order.customer_name,
        "order_type": order.order_type,
        "table_number": order.table_number,
        "status": order.status,
        "notes": order.notes,
        "total_amount": _money(order.total_amount),
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "items": _items(order),
        "tracking_token": getattr(order, "tracking_token", None)
    }


def _public_view(order: models.CustomerOrder) -> dict:
    return {
        "order_number": order.order_number,
        "status": order.status,
        "order_type": order.order_type,
        "table_number": order.table_number,
        "total_amount": _money(order.total_amount),
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "items": _items(order),
        "tracking_token": getattr(order, "tracking_token", None)
    }


@router.post("", status_code=status.HTTP_201_CREATED, summary="Submit a customer order from the QR menu")
def submit_customer_order(body: schemas.CustomerOrderCreate, db: Session = Depends(get_db)):
    """
    Public endpoint used by the QR menu.
    Validates tenant, table number, product status, and quantities via CustomerOrderCreate schema.
    Calculates prices server-side, records order, and broadcasts real-time WebSocket events.
    """
    tenant = db.query(models.Tenant).filter(
        models.Tenant.id == body.tenant_id,
        models.Tenant.is_active.is_(True)
    ).first()
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This restaurant is not accepting orders.")

    if body.table_number:
        tables = db.query(models.RestaurantTable).filter(models.RestaurantTable.tenant_id == tenant.id)
        if tables.first() is not None:
            raw_t = str(body.table_number).strip()
            digits = "".join(filter(str.isdigit, raw_t))
            match = tables.filter(
                (models.RestaurantTable.table_number == raw_t) |
                (models.RestaurantTable.table_number == digits)
            ).first()
            if match and match.status != "active":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This table is not taking orders right now. Please ask the staff for help.",
                )

    product_ids = {item.product_id for item in body.items}
    products = {
        p.id: p for p in db.query(models.Product).filter(
            models.Product.id.in_(product_ids),
            models.Product.tenant_id == tenant.id
        )
    }

    total = Decimal("0")
    order_items = []
    for item in body.items:
        product = products.get(item.product_id)
        if product is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Product {item.product_id} is not on this menu.")
        if not product.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{product.name} is currently unavailable.")
        price = Decimal(str(product.price))
        total += price * item.quantity
        order_items.append(models.CustomerOrderItem(
            name=product.name,
            variant=item.variant,
            price=price,
            quantity=item.quantity,
            product_id=product.id,
        ))

    order = None
    for _ in range(5):
        order_num = f"CUST-{secrets.token_hex(4).upper()}"
        tracking_tok = secrets.token_urlsafe(24)
        order = models.CustomerOrder(
            tenant_id=tenant.id,
            order_number=order_num,
            tracking_token=tracking_tok,
            customer_name=body.customer_name,
            order_type=body.order_type,
            table_number=body.table_number,
            notes=body.notes,
            total_amount=round(float(total), 2),
            status="pending"
        )
        order.items = list(order_items)
        db.add(order)
        try:
            db.commit()
            db.refresh(order)
            break
        except Exception:
            db.rollback()
            order_items = [models.CustomerOrderItem(name=i.name, variant=i.variant, price=i.price,
                                                    quantity=i.quantity, product_id=i.product_id) for i in order_items]
    else:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Could not place the order. Please try again.")

    # Real-time WebSocket event broadcast to POS Cashier, Kitchen KDS, and Admin
    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant.id, "ORDER_CREATED", {
            "order_id": order.id,
            "order_number": order.order_number,
            "customer_name": order.customer_name,
            "order_type": order.order_type,
            "table_number": order.table_number,
            "total_amount": float(order.total_amount)
        })
        notify_realtime_event(tenant.id, "CUSTOMER_ORDER_CREATED", {
            "order_id": order.id,
            "order_number": order.order_number,
            "customer_name": order.customer_name,
            "order_type": order.order_type,
            "table_number": order.table_number,
            "total_amount": float(order.total_amount)
        })
    except Exception:
        pass

    return {
        "message": "Order placed successfully",
        "order_id": order.id,
        "order_number": order.order_number,
        "tracking_token": order.tracking_token,
        "total_amount": float(order.total_amount),
    }


@router.get("/pending", summary="Get all pending customer orders for the POS")
def get_pending_orders(db: Session = Depends(get_db)):
    """
    Polled by the POS cashier dashboard or received via WebSockets to show incoming orders.
    """
    orders = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(
        models.CustomerOrder.status.in_(["pending", "accepted"])
    ).order_by(models.CustomerOrder.created_at.asc()).all()

    return [_staff_view(order) for order in orders]


@router.put("/{order_id}/status", summary="Update customer order status")
def update_customer_order_status(
    order_id: int,
    body: schemas.CustomerOrderStatusUpdate,
    db: Session = Depends(get_db)
):
    """
    Used by the POS to accept, reject, or complete a customer order.
    """
    order = db.query(models.CustomerOrder).filter(models.CustomerOrder.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    new_status = body.status
    if new_status not in ["accepted", "rejected", "completed", "pending"]:
        raise HTTPException(status_code=400, detail="Invalid status")

    previous = order.status
    order.status = new_status
    db.commit()

    # Real-time WebSocket event broadcast
    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(order.tenant_id or 1, "ORDER_UPDATED", {
            "order_id": order.id,
            "order_number": order.order_number,
            "status": new_status,
            "previous_status": previous
        })
    except Exception:
        pass

    return {"message": f"Order marked as {new_status}"}


@router.get("/history", summary="Get customer past orders by name or tenant")
def get_customer_history(
    customer_name: Optional[str] = None,
    limit: int = 20,
    db: Session = Depends(get_db)
):
    """
    Returns recent customer orders filtered by customer name.
    """
    q = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    )
    if customer_name and customer_name.strip():
        q = q.filter(models.CustomerOrder.customer_name.ilike(f"%{customer_name.strip()}%"))

    orders = q.order_by(models.CustomerOrder.created_at.desc()).limit(limit).all()
    return [_staff_view(order) for order in orders]


@router.get("/track/{token_or_number}", summary="Track order status by order number or tracking token")
def track_customer_order(token_or_number: str, db: Session = Depends(get_db)):
    """
    Allows customers to track the status of their order live using either their tracking token or order number.
    """
    val = token_or_number.strip()
    order = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(
        (models.CustomerOrder.tracking_token == val) |
        (models.CustomerOrder.order_number == val.upper())
    ).first()

    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    return _public_view(order)


@router.get("/menu", summary="Get the public menu for a specific tenant")
def get_public_menu(tenant_id: int = 1, db: Session = Depends(get_db)):
    """
    Public endpoint: active categories and active products for the branch QR ordering.
    """
    tenant = db.query(models.Tenant).filter(models.Tenant.id == tenant_id, models.Tenant.is_active.is_(True)).first()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Menu not found")

    categories = db.query(models.Category).filter(models.Category.tenant_id == tenant_id).order_by(models.Category.id).all()
    products = (
        db.query(models.Product)
        .filter(models.Product.tenant_id == tenant_id, models.Product.is_active.is_(True))
        .order_by(models.Product.id)
        .all()
    )
    by_category = {}
    for p in products:
        by_category.setdefault(p.category_id, []).append(p)

    result = []
    for cat in categories:
        items = by_category.get(cat.id)
        if not items:
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
                } for p in items
            ]
        })
    return result
