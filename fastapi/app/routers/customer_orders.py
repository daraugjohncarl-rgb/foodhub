from fastapi import APIRouter, Depends, HTTPException, status
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from datetime import datetime

from app.db import get_db
import app.models as models
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/customer-orders", tags=["Customer Orders"])

@router.post("", status_code=status.HTTP_201_CREATED, summary="Submit a customer order from the QR menu")
def submit_customer_order(body: dict, db: Session = Depends(get_db)):
    """
    Called by the customer QR menu to submit a new order.
    """
    order_number = body.get("order_number")
    customer_name = body.get("customer_name")
    order_type = body.get("order_type")
    table_number = body.get("table_number")
    tenant_id = body.get("tenant_id", 1)
    notes = body.get("notes")
    items = body.get("items", [])

    if not customer_name or not items:
        raise HTTPException(status_code=400, detail="Missing required order fields")
        
    if not order_number:
        import uuid
        order_number = f"CUST-{uuid.uuid4().hex[:6].upper()}"

    total_amount = 0.0
    valid_items = []
    
    for item in items:
        prod_id = item.get("product_id")
        qty = int(item.get("quantity", 1))
        
        if not prod_id:
            raise HTTPException(status_code=400, detail="Missing product_id in order items")
        if qty <= 0:
            raise HTTPException(status_code=400, detail=f"Invalid quantity {qty} for product {prod_id}")
            
        product = db.query(models.Product).filter(models.Product.id == prod_id).first()
        if not product:
            raise HTTPException(status_code=404, detail=f"Product with ID {prod_id} not found")
        if not product.is_active:
            raise HTTPException(status_code=400, detail=f"Product {product.name} is currently unavailable")
            
        real_price = float(product.price)
        total_amount += real_price * qty
        
        valid_items.append(models.CustomerOrderItem(
            name=product.name,
            variant=item.get("variant"),
            price=real_price,
            quantity=qty,
            product_id=product.id
        ))

    # Check if order_number already exists (should be unique)
    existing = db.query(models.CustomerOrder).filter(models.CustomerOrder.order_number == order_number).first()
    if existing:
        return {"message": "Order already exists"}

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
    db.add(new_order)
    db.flush()

    # Add items
    for new_item in valid_items:
        new_item.customer_order_id = new_order.id
        db.add(new_item)
    
    db.commit()

    return {"message": "Order placed successfully", "order_id": new_order.id, "order_number": new_order.order_number}


@router.get("/pending", summary="Get all pending customer orders for the POS")
def get_pending_orders(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """
    Polled by the POS cashier dashboard to show incoming orders.
    """
    orders = db.query(models.CustomerOrder).options(
        joinedload(models.CustomerOrder.items)
    ).filter(
        models.CustomerOrder.status == "pending",
        models.CustomerOrder.tenant_id == current_user.tenant_id
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
            "created_at": order.created_at.isoformat(),
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
    if new_status not in ["accepted", "rejected", "completed"]:
        raise HTTPException(status_code=400, detail="Invalid status")

    order = db.query(models.CustomerOrder).filter(models.CustomerOrder.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    order.status = new_status
    db.commit()

    return {"message": f"Order marked as {new_status}"}


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
            models.Product.is_active == True,
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
                    "name": p.name,
                    "price": float(p.price),
                    "image_url": getattr(p, "image_url", None)
                } for p in products
            ]
        })
        
    return result
