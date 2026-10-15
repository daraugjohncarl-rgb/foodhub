"""
Customer QR orders.

Public (no login): read the menu, place an order, track ONE order with the secret tracking token returned when it
was placed. Everything else - the pending queue, history, accepting/rejecting - requires a staff login and is scoped
to the staff member's branch (C1, H2).
"""
import logging
import secrets
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core import audit, config
from app.core.dependencies import require_permission, resolve_tenant_id
from app.core.ratelimit import SlidingWindowLimiter, client_ip
from app.core.timeutils import isoformat_utc

logger = logging.getLogger("pos_customer_orders")

router = APIRouter(prefix="/customer-orders", tags=["Customer Orders"])

order_ip_limiter = SlidingWindowLimiter(config.CUSTOMER_ORDERS_PER_IP_PER_10_MIN, 600)
CENT = Decimal("0.01")

# Staff transitions. 'completed' is normally set by checkout (POST /transactions with customer_order_id).
ALLOWED_TRANSITIONS = {
    "pending": {"accepted", "rejected", "completed"},
    "accepted": {"rejected", "completed"},
    "rejected": set(),
    "completed": set(),
}


def _money(value) -> str:
    return str(Decimal(value).quantize(CENT))


def _items(order: models.CustomerOrder):
    return [
        {
            "name": item.name,
            "variant": item.variant,
            "price": _money(item.price),
            "quantity": item.quantity,
            "product_id": item.product_id,
        }
        for item in order.items
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
        "created_at": isoformat_utc(order.created_at),
        "items": _items(order),
    }


def _public_view(order: models.CustomerOrder) -> dict:
    """What an anonymous customer holding the tracking token may see: their own order only, no internal ids."""
    return {
        "order_number": order.order_number,
        "status": order.status,
        "order_type": order.order_type,
        "table_number": order.table_number,
        "total_amount": _money(order.total_amount),
        "created_at": isoformat_utc(order.created_at),
        "items": [{k: v for k, v in item.items() if k != "product_id"} for item in _items(order)],
    }


@router.post("", status_code=status.HTTP_201_CREATED, summary="Submit a customer order from the QR menu")
def submit_customer_order(body: schemas.CustomerOrderCreate, request: Request, db: Session = Depends(get_db)):
    """
    Public endpoint used by the QR menu. The branch must exist and be active, every product must belong to that
    branch, quantities and sizes are capped, prices come from the database, and the order number is generated here.
    """
    if order_ip_limiter.hit(client_ip(request)):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Too many orders from this device. Please ask the staff for help.")

    tenant = db.query(models.Tenant).filter(models.Tenant.id == body.tenant_id, models.Tenant.is_active.is_(True)).first()
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This restaurant is not accepting orders.")

    if body.table_number:
        tables = db.query(models.RestaurantTable).filter(models.RestaurantTable.tenant_id == tenant.id)
        if tables.first() is not None:
            table = tables.filter(models.RestaurantTable.table_number == body.table_number).first()
            if table is None or table.status != "active":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This table is not taking orders right now. Please ask the staff for help.",
                )

    product_ids = {item.product_id for item in body.items}
    products = {
        p.id: p for p in db.query(models.Product).filter(
            models.Product.id.in_(product_ids), models.Product.tenant_id == tenant.id
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
        price = Decimal(product.price)
        total += price * item.quantity
        order_items.append(models.CustomerOrderItem(
            name=product.name, variant=item.variant, price=price, quantity=item.quantity, product_id=product.id,
        ))

    for _ in range(5):
        order = models.CustomerOrder(
            tenant_id=tenant.id,
            order_number=f"CUST-{secrets.token_hex(4).upper()}",
            tracking_token=secrets.token_urlsafe(24),
            customer_name=body.customer_name,
            order_type=body.order_type,
            table_number=body.table_number,
            notes=body.notes,
            total_amount=total.quantize(CENT),
            status=models.CustomerOrderStatus.PENDING.value,
        )
        order.items = list(order_items)
        db.add(order)
        try:
            db.commit()
            break
        except IntegrityError:
            db.rollback()   # astronomically unlikely order-number/token collision: try a new one
            order_items = [models.CustomerOrderItem(name=i.name, variant=i.variant, price=i.price,
                                                    quantity=i.quantity, product_id=i.product_id) for i in order_items]
    else:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Could not place the order. Please try again.")

    return {
        "message": "Order placed successfully",
        "order_number": order.order_number,
        "tracking_token": order.tracking_token,
        "total_amount": _money(order.total_amount),
    }


@router.get("/pending", summary="Pending customer orders for the POS")
def get_pending_orders(
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to view"),
    current_user: models.User = Depends(require_permission("customer_orders.manage")),
    db: Session = Depends(get_db),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    orders = (
        db.query(models.CustomerOrder)
        .options(joinedload(models.CustomerOrder.items))
        .filter(
            models.CustomerOrder.status.in_([models.CustomerOrderStatus.PENDING.value,
                                             models.CustomerOrderStatus.ACCEPTED.value]),
            models.CustomerOrder.tenant_id == scope_tenant,
        )
        .order_by(models.CustomerOrder.created_at.asc())
        .all()
    )
    return [_staff_view(order) for order in orders]


@router.put("/{order_id}/status", summary="Update customer order status")
def update_customer_order_status(
    order_id: int,
    body: schemas.CustomerOrderStatusUpdate,
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch"),
    current_user: models.User = Depends(require_permission("customer_orders.manage")),
    db: Session = Depends(get_db),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    order = (
        db.query(models.CustomerOrder)
        .filter(models.CustomerOrder.id == order_id, models.CustomerOrder.tenant_id == scope_tenant)
        .with_for_update()
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if body.status != order.status and body.status not in ALLOWED_TRANSITIONS.get(order.status, set()):
        raise HTTPException(status_code=409, detail=f"Order is already {order.status}.")

    previous = order.status
    order.status = body.status
    audit.record(db, current_user, "Customer Order Status", tenant_id=scope_tenant,
                 details=f"{order.order_number}: {previous} -> {body.status}")
    db.commit()
    return {"message": f"Order marked as {body.status}"}


@router.get("/history", summary="Recent customer orders of the caller's branch (staff only)")
def get_customer_history(
    customer_name: Optional[str] = Query(None, max_length=100),
    limit: int = Query(20, ge=1, le=100),
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to view"),
    current_user: models.User = Depends(require_permission("customer_orders.manage")),
    db: Session = Depends(get_db),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    q = (
        db.query(models.CustomerOrder)
        .options(joinedload(models.CustomerOrder.items))
        .filter(models.CustomerOrder.tenant_id == scope_tenant)
    )
    if customer_name and customer_name.strip():
        q = q.filter(models.CustomerOrder.customer_name.ilike(f"%{customer_name.strip()}%"))
    orders = q.order_by(models.CustomerOrder.created_at.desc()).limit(limit).all()
    return [_staff_view(order) for order in orders]


@router.get("/track/{tracking_token}", summary="Track one order with its secret tracking token (public)")
def track_customer_order(tracking_token: str, db: Session = Depends(get_db)):
    if len(tracking_token) < 20 or len(tracking_token) > 64:
        raise HTTPException(status_code=404, detail="Order not found")
    order = (
        db.query(models.CustomerOrder)
        .options(joinedload(models.CustomerOrder.items))
        .filter(models.CustomerOrder.tracking_token == tracking_token)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return _public_view(order)


@router.get("/menu", summary="Get the public menu for a specific tenant")
def get_public_menu(tenant_id: int = Query(1, gt=0), db: Session = Depends(get_db)):
    """
    Public endpoint: active categories and their active products for an active branch.
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
                {"id": p.id, "name": p.name, "price": _money(p.price), "image_url": p.image_url}
                for p in items
            ],
        })
    return result
