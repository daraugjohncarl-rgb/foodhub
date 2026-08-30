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

    total_amount = Decimal(str(body.get("total_amount", 0)))
    tax_amount = Decimal(str(body.get("tax_amount", 0)))
    discount_amount = Decimal(str(body.get("discount_amount", 0)))
    net_amount = Decimal(str(body.get("net_amount", total_amount)))
    client_tx_id = body.get("client_tx_id") or str(uuid.uuid4())

    tx = models.Transaction(
        tenant_id=tenant_id,
        shift_id=active_shift.id,
        user_id=current_user.id,
        client_tx_id=client_tx_id,
        total_amount=total_amount,
        tax_amount=tax_amount,
        discount_amount=discount_amount,
        net_amount=net_amount,
        status="completed"
    )
    db.add(tx)
    db.commit()
    db.refresh(tx)

    # Insert transaction items
    for item in items_data:
        prod_id = item.get("product_id")
        qty = int(item.get("quantity", 1))
        unit_price = Decimal(str(item.get("unit_price", 0)))
        total_price = Decimal(str(item.get("total_price", unit_price * qty)))

        tx_item = models.TransactionItem(
            transaction_id=tx.id,
            product_id=prod_id,
            quantity=qty,
            unit_price=unit_price,
            total_price=total_price
        )
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
            status="completed"
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

    return {
        "id": tx.id,
        "client_tx_id": tx.client_tx_id,
        "net_amount": float(tx.net_amount),
        "status": tx.status,
        "created_at": tx.created_at.isoformat() if tx.created_at else None,
        "message": "Transaction created successfully."
    }
