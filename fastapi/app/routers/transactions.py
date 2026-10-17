"""
Transactions & POS Router
=========================
Handles POS transaction checkout, payment processing, and transaction retrieval.
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from decimal import Decimal
import uuid

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/transactions", tags=["POS — Transactions"])

@router.get("", summary="List transactions for the user's tenant")
def list_transactions(
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    q = db.query(models.Transaction).options(
        joinedload(models.Transaction.items).joinedload(models.TransactionItem.product),
        joinedload(models.Transaction.payments),
        joinedload(models.Transaction.user)
    )
    if current_user.tenant_id:
        q = q.filter(models.Transaction.tenant_id == current_user.tenant_id)
    
    transactions = q.order_by(models.Transaction.created_at.desc()).offset(offset).limit(limit).all()
    
    result = []
    for tx in transactions:
        result.append({
            "id": tx.id,
            "client_tx_id": tx.client_tx_id,
            "tenant_id": tx.tenant_id,
            "shift_id": tx.shift_id,
            "user_id": tx.user_id,
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
            "payments": [
                {
                    "id": p.id,
                    "payment_method": p.payment_method,
                    "amount": float(p.amount),
                    "status": p.status
                }
                for p in tx.payments
            ]
        })
    return result


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a new POS transaction")
def create_transaction(
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    tenant_id = current_user.tenant_id
    if not tenant_id:
        # Fallback to first available tenant or 1
        first_tenant = db.query(models.Tenant).first()
        tenant_id = first_tenant.id if first_tenant else 1

    # Ensure an active shift exists for user or tenant
    active_shift = db.query(models.Shift).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.user_id == current_user.id,
        models.Shift.status == "open"
    ).first()

    if not active_shift:
        active_shift = models.Shift(
            tenant_id=tenant_id,
            user_id=current_user.id,
            start_cash=Decimal("0.0"),
            status="open"
        )
        db.add(active_shift)
        db.commit()
        db.refresh(active_shift)

    items_data = body.get("items", [])
    if not items_data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transaction must contain at least 1 item.")

    calculated_total = Decimal("0.0")
    validated_items = []

    for item in items_data:
        prod_id = item.get("product_id")
        qty = int(item.get("quantity", 1))

        product = db.query(models.Product).filter(
            models.Product.id == prod_id,
            models.Product.tenant_id == tenant_id
        ).first()

        if not product:
            raise HTTPException(status_code=404, detail=f"Product ID {prod_id} not found or belongs to another tenant.")
        if not product.is_active:
            raise HTTPException(status_code=400, detail=f"Product '{product.name}' is currently inactive or unavailable.")

        unit_price = product.price
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

    tax_amount = Decimal(str(body.get("tax_amount", 0)))
    discount_amount = Decimal(str(body.get("discount_amount", 0)))
    net_amount = calculated_total + tax_amount - discount_amount
    if net_amount < 0:
        net_amount = Decimal("0.0")

    client_tx_id = body.get("client_tx_id") or str(uuid.uuid4())

    tx = models.Transaction(
        tenant_id=tenant_id,
        shift_id=active_shift.id,
        user_id=current_user.id,
        client_tx_id=client_tx_id,
        total_amount=calculated_total,
        tax_amount=tax_amount,
        discount_amount=discount_amount,
        net_amount=net_amount,
        status=body.get("status") or "completed"
    )
    db.add(tx)
    db.commit()
    db.refresh(tx)

    # Insert transaction items
    for tx_item in validated_items:
        tx_item.transaction_id = tx.id
        db.add(tx_item)

    # Insert payments
    payments_data = body.get("payments", [])
    if not payments_data:
        # Default to single cash payment for the net amount
        method = body.get("payment_method", "Cash")
        payments_data = [{"payment_method": method, "amount": net_amount}]

    for p in payments_data:
        pm = models.Payment(
            transaction_id=tx.id,
            payment_method=p.get("payment_method", "Cash"),
            amount=Decimal(str(p.get("amount", net_amount))),
            status="completed" if tx.status == "completed" else "pending"
        )
        db.add(pm)

    # Audit log
    try:
        log = models.ActivityLog(
            tenant_id=tenant_id,
            user_id=current_user.id,
            action="POS Sale",
            performed_by=current_user.username,
            role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
            details=f"Transaction #{tx.id} processed for ₱{float(net_amount):,.2f}"
        )
        db.add(log)
    except Exception:
        pass

    db.commit()
    db.refresh(tx)

    # Real-time WebSocket event broadcast
    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "ORDER_CREATED", {
            "order_id": tx.id,
            "client_tx_id": tx.client_tx_id,
            "net_amount": float(tx.net_amount),
            "status": tx.status,
            "cashier": current_user.username
        })
        notify_realtime_event(tenant_id, "DRAWER_UPDATED", {"reason": "pos_sale", "order_id": tx.id})
        notify_realtime_event(tenant_id, "FINANCIAL_UPDATED", {"reason": "pos_sale", "order_id": tx.id})
    except Exception:
        pass

    return {
        "id": tx.id,
        "client_tx_id": tx.client_tx_id,
        "net_amount": float(tx.net_amount),
        "status": tx.status,
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
        "message": "Transaction created successfully."
    }


@router.put("/{tx_id}/status", summary="Update transaction status (e.g. reject/cancel or complete)")
def update_transaction_status(
    tx_id: int,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Allows cashier and management to change order status.
    If the customer cancels the order, the cashier can reject the order,
    marking transaction as 'rejected' / 'cancelled' and voiding associated payments.
    """
    q = db.query(models.Transaction).filter(models.Transaction.id == tx_id)
    if current_user.tenant_id:
        q = q.filter(models.Transaction.tenant_id == current_user.tenant_id)
    
    tx = q.first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")

    # IMMUTABILITY RULE: Once an order is rejected (or cancelled), its status is final and cannot be changed!
    if tx.status in ["rejected", "cancelled"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Order #{tx.id} has already been {tx.status.upper()}. Once an order is rejected, its status is locked and cannot be changed."
        )

    raw_status = body.get("status", "").strip().lower()
    reason = body.get("reason", "").strip() or "Customer cancelled order"

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

    # Audit log
    try:
        log = models.ActivityLog(
            tenant_id=tx.tenant_id,
            user_id=current_user.id,
            action="Order Cancelled/Rejected" if raw_status in ["cancelled", "rejected"] else "Order Status Update",
            performed_by=current_user.username,
            role=current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role),
            details=f"Order #{tx.id} status changed from {old_status.upper()} to {raw_status.upper()}. Reason: {reason}"
        )
        db.add(log)
    except Exception:
        pass

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
        pass

    return {
        "id": tx.id,
        "status": tx.status,
        "message": f"Order #{tx.id} marked as {tx.status.upper()} successfully."
    }

