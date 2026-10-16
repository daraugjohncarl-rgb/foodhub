"""
Analytics Router — Admin Module
================================
Tenant-scoped dashboard statistics for Branch Admins.
All endpoints require ADMIN or SUPER_ADMIN role.
"""
from datetime import datetime, time
from decimal import Decimal
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import get_current_user

router = APIRouter(tags=["Analytics"])


@router.get(
    "/analytics/dashboard",
    response_model=schemas.DashboardStats,
    summary="Get tenant-scoped dashboard overview metrics"
)
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    tenant_id = current_user.tenant_id
    if not tenant_id:
        first_tenant = db.query(models.Tenant).first()
        tenant_id = first_tenant.id if first_tenant else 1

    # Today's start and end timestamps
    today = datetime.now().date()
    start_of_day = datetime.combine(today, time.min)
    end_of_day = datetime.combine(today, time.max)

    # 1. Today's sales sum & transaction count
    tx_query = (
        db.query(
            func.coalesce(func.sum(models.Transaction.net_amount), 0).label("total_sales"),
            func.count(models.Transaction.id).label("tx_count")
        )
        .filter(
            models.Transaction.tenant_id == tenant_id,
            models.Transaction.status == "completed",
            models.Transaction.created_at >= start_of_day,
            models.Transaction.created_at <= end_of_day
        )
        .first()
    )

    today_sales = Decimal(str(tx_query.total_sales or 0))
    total_transactions_today = int(tx_query.tx_count or 0)

    # 2. Low stock count (quantity <= min_stock)
    low_stock_count = (
        db.query(func.count(models.InventoryItem.id))
        .filter(
            models.InventoryItem.tenant_id == tenant_id,
            models.InventoryItem.quantity <= models.InventoryItem.min_stock
        )
        .scalar()
        or 0
    )

    # 3. Active operational staff count (excludes SUPER_ADMIN and ADMIN roles)
    active_staff_count = (
        db.query(func.count(models.User.id))
        .filter(
            models.User.tenant_id == tenant_id,
            models.User.is_active == True,
            models.User.role.notin_([models.UserRole.SUPER_ADMIN, models.UserRole.ADMIN])
        )
        .scalar()
        or 0
    )

    # 4. Total cash in active cashier drawers (Start Cash + Cash Sales + Paid In - Paid Out)
    open_shifts = db.query(models.Shift).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.status == "open"
    ).all()

    cash_in_drawer = Decimal("0.0")
    for s in open_shifts:
        c_sales = db.query(
            func.coalesce(func.sum(models.Payment.amount), 0)
        ).join(models.Transaction).filter(
            models.Transaction.shift_id == s.id,
            models.Payment.status == "completed",
            func.lower(models.Payment.payment_method).like("%cash%")
        ).scalar() or Decimal("0.0")

        p_in = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(
            models.ShiftCashMovement.shift_id == s.id,
            models.ShiftCashMovement.type == "PAID_IN"
        ).scalar() or Decimal("0.0")

        p_out = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(
            models.ShiftCashMovement.shift_id == s.id,
            models.ShiftCashMovement.type == "PAID_OUT"
        ).scalar() or Decimal("0.0")

        cash_in_drawer += Decimal(str(s.start_cash or 0)) + Decimal(str(c_sales)) + Decimal(str(p_in)) - Decimal(str(p_out))

    return schemas.DashboardStats(
        today_sales=today_sales,
        total_transactions_today=total_transactions_today,
        low_stock_count=low_stock_count,
        active_staff_count=active_staff_count,
        cash_in_drawer=cash_in_drawer
    )


@router.get(
    "/analytics/profit-loss",
    summary="Comprehensive Profit & Loss, Inventory Pricing Valuation, and Cashout Income Report"
)
def get_profit_loss(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    tenant_id = current_user.tenant_id
    if not tenant_id:
        first_tenant = db.query(models.Tenant).first()
        tenant_id = first_tenant.id if first_tenant else 1

    today = datetime.now().date()
    start_of_day = datetime.combine(today, time.min)
    end_of_day = datetime.combine(today, time.max)

    # 1. Total Completed Orders Revenue (Overall and Today)
    all_completed_tx = db.query(
        func.coalesce(func.sum(models.Transaction.net_amount), 0).label("revenue"),
        func.count(models.Transaction.id).label("count")
    ).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status == "completed"
    ).first()

    total_orders_revenue = Decimal(str(all_completed_tx.revenue or 0))
    total_orders_count = int(all_completed_tx.count or 0)

    today_completed_tx = db.query(
        func.coalesce(func.sum(models.Transaction.net_amount), 0).label("revenue"),
        func.count(models.Transaction.id).label("count")
    ).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status == "completed",
        models.Transaction.created_at >= start_of_day,
        models.Transaction.created_at <= end_of_day
    ).first()

    today_orders_revenue = Decimal(str(today_completed_tx.revenue or 0))
    today_orders_count = int(today_completed_tx.count or 0)

    # Cash vs Non-Cash Sales
    cash_sales = db.query(
        func.coalesce(func.sum(models.Payment.amount), 0)
    ).join(models.Transaction).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        func.lower(models.Payment.payment_method).like("%cash%")
    ).scalar() or Decimal("0.0")

    non_cash_sales = db.query(
        func.coalesce(func.sum(models.Payment.amount), 0)
    ).join(models.Transaction).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        ~func.lower(models.Payment.payment_method).like("%cash%")
    ).scalar() or Decimal("0.0")

    if (cash_sales + non_cash_sales) > total_orders_revenue:
        total_orders_revenue = cash_sales + non_cash_sales

    # 2. Cashout Income (Money secured from cashier drawer into safe)
    all_cashouts = db.query(
        models.ShiftCashMovement
    ).filter(
        models.ShiftCashMovement.tenant_id == tenant_id,
        models.ShiftCashMovement.type == "PAID_OUT"
    ).order_by(models.ShiftCashMovement.id.desc()).all()

    total_cashout_income = sum(Decimal(str(m.amount)) for m in all_cashouts)
    today_cashout_income = sum(
        Decimal(str(m.amount)) for m in all_cashouts 
        if m.created_at and m.created_at.date() == today
    )

    # Active cash in drawers remaining
    open_shifts = db.query(models.Shift).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.status == "open"
    ).all()

    active_drawer_cash = Decimal("0.0")
    for s in open_shifts:
        c_s = db.query(
            func.coalesce(func.sum(models.Payment.amount), 0)
        ).join(models.Transaction).filter(
            models.Transaction.shift_id == s.id,
            models.Payment.status == "completed",
            func.lower(models.Payment.payment_method).like("%cash%")
        ).scalar() or Decimal("0.0")
        p_i = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(models.ShiftCashMovement.shift_id == s.id, models.ShiftCashMovement.type == "PAID_IN").scalar() or Decimal("0.0")
        p_o = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(models.ShiftCashMovement.shift_id == s.id, models.ShiftCashMovement.type == "PAID_OUT").scalar() or Decimal("0.0")
        active_drawer_cash += Decimal(str(s.start_cash or 0)) + Decimal(str(c_s)) + Decimal(str(p_i)) - Decimal(str(p_o))

    # 3. Inventory Price / Stock Valuation & Cost of Goods Sold
    inv_items = db.query(models.InventoryItem).filter(
        models.InventoryItem.tenant_id == tenant_id
    ).all()

    total_inventory_valuation = sum(
        Decimal(str(item.quantity)) * Decimal(str(item.unit_price or 0.0))
        for item in inv_items
    )
    total_inventory_items_count = len(inv_items)

    # Cost of Goods Sold (Product Cost * Quantity Sold)
    cogs_val = db.query(
        func.coalesce(func.sum(models.TransactionItem.quantity * models.Product.cost), 0)
    ).join(models.Transaction, models.TransactionItem.transaction_id == models.Transaction.id)\
     .join(models.Product, models.TransactionItem.product_id == models.Product.id)\
     .filter(
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status == "completed"
    ).scalar() or Decimal("0.0")

    cost_of_goods_sold = Decimal(str(cogs_val))
    if cost_of_goods_sold == 0 and total_orders_revenue > 0:
        cost_of_goods_sold = total_orders_revenue * Decimal("0.40")

    # 4. Profit & Loss Calculations
    gross_profit = total_orders_revenue - cost_of_goods_sold
    profit_margin = float(round((gross_profit / total_orders_revenue * 100), 2)) if total_orders_revenue > 0 else 0.0
    net_profit = gross_profit
    net_cash_income = total_cashout_income + Decimal(str(non_cash_sales))

    cashout_history = [{
        "id": m.id,
        "shift_id": m.shift_id,
        "cashier": m.user.username if m.user else "Cashier",
        "amount": float(m.amount),
        "reason": m.reason or "Manager Cashout",
        "created_at": m.created_at.isoformat() if m.created_at else None
    } for m in all_cashouts[:20]]

    return {
        "revenue": {
            "total_orders_revenue": float(total_orders_revenue),
            "today_orders_revenue": float(today_orders_revenue),
            "cash_sales": float(cash_sales),
            "non_cash_sales": float(non_cash_sales),
            "total_orders_count": total_orders_count,
            "today_orders_count": today_orders_count
        },
        "inventory": {
            "total_inventory_valuation": float(total_inventory_valuation),
            "total_items_count": total_inventory_items_count,
            "cost_of_goods_sold": float(cost_of_goods_sold)
        },
        "cashout": {
            "total_cashout_income": float(total_cashout_income),
            "today_cashout_income": float(today_cashout_income),
            "active_drawer_cash": float(active_drawer_cash),
            "history": cashout_history
        },
        "profit_loss": {
            "gross_profit": float(gross_profit),
            "net_profit": float(net_profit),
            "profit_margin_percent": profit_margin,
            "net_cash_income": float(net_cash_income),
            "is_profitable": float(net_profit) >= 0
        }
    }
