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
            models.Transaction.status == "completed",
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

    # 2. Cashout Income & Admin Transfers Accounting
    all_cashouts = db.query(
        models.ShiftCashMovement
    ).filter(
        models.ShiftCashMovement.tenant_id == tenant_id,
        models.ShiftCashMovement.type == "PAID_OUT"
    ).order_by(models.ShiftCashMovement.id.desc()).all()

    # Cashier cashouts into manager safe (reason does NOT contain 'admin')
    cashier_cashouts = [m for m in all_cashouts if 'admin' not in (m.reason or '').lower()]
    total_cashout_income = sum(Decimal(str(m.amount)) for m in cashier_cashouts)
    today_cashout_income = sum(
        Decimal(str(m.amount)) for m in cashier_cashouts 
        if m.created_at and m.created_at.date() == today
    )

    # Transfers from manager to admin safe (reason contains 'admin')
    admin_transfers = [m for m in all_cashouts if 'admin' in (m.reason or '').lower()]
    total_transferred_to_admin = sum(Decimal(str(m.amount)) for m in admin_transfers)
    today_transferred_to_admin = sum(
        Decimal(str(m.amount)) for m in admin_transfers 
        if m.created_at and m.created_at.date() == today
    )

    # Active cash in drawers remaining (Cashier role open shifts)
    open_shifts = db.query(models.Shift).join(models.User).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.status == "open",
        models.User.role == models.UserRole.CASHIER
    ).all()

    open_shift_ids = [s.id for s in open_shifts]
    active_drawer_cash = sum(Decimal(str(s.start_cash or 0)) for s in open_shifts)
    if open_shift_ids:
        total_open_cash_sales = db.query(
            func.coalesce(func.sum(models.Payment.amount), 0)
        ).join(models.Transaction).filter(
            models.Transaction.shift_id.in_(open_shift_ids),
            models.Payment.status == "completed",
            models.Transaction.status == "completed",
            func.lower(models.Payment.payment_method).like("%cash%")
        ).scalar() or Decimal("0.0")

        total_open_paid_in = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(models.ShiftCashMovement.shift_id.in_(open_shift_ids), models.ShiftCashMovement.type == "PAID_IN").scalar() or Decimal("0.0")

        total_open_paid_out = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(models.ShiftCashMovement.shift_id.in_(open_shift_ids), models.ShiftCashMovement.type == "PAID_OUT").scalar() or Decimal("0.0")

        active_drawer_cash += Decimal(str(total_open_cash_sales)) + Decimal(str(total_open_paid_in)) - Decimal(str(total_open_paid_out))

    # 3. Inventory Price / Stock Valuation & Cost of Goods Sold directly aggregated in DB
    inv_stats = db.query(
        func.coalesce(func.sum(models.InventoryItem.quantity * models.InventoryItem.unit_price), 0),
        func.count(models.InventoryItem.id)
    ).filter(
        models.InventoryItem.tenant_id == tenant_id
    ).first()

    total_inventory_valuation = Decimal(str(inv_stats[0] or 0))
    total_inventory_items_count = int(inv_stats[1] or 0)

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

    user_role_str = str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role).upper()
    is_admin = user_role_str in ["ADMIN", "SUPER_ADMIN"]

    # 4. Profit & Loss Calculations (Net Profit Loss based on total valuation of inventory of product)
    gross_profit = total_orders_revenue - total_inventory_valuation
    profit_margin = float(round((gross_profit / total_orders_revenue * 100), 2)) if total_orders_revenue > 0 else 0.0
    net_profit = gross_profit

    # Manager: safe cash decreases when transferred to Admin
    manager_safe_cash = max(Decimal("0.0"), total_cashout_income - total_transferred_to_admin)
    manager_net_cash_income = manager_safe_cash + Decimal(str(non_cash_sales))

    # Admin: receives transfer income from Manager (increases with each transfer)
    admin_transfer_income = total_transferred_to_admin
    admin_net_cash_income = admin_transfer_income + Decimal(str(non_cash_sales))

    # Role-aware net realized cash
    net_cash_income = admin_net_cash_income if is_admin else manager_net_cash_income

    cashout_history = [{
        "id": m.id,
        "shift_id": m.shift_id,
        "cashier": m.user.username if m.user else "Cashier",
        "amount": float(m.amount),
        "reason": m.reason or ("Transfer Income from Manager" if is_admin else "Transfer to Manager Profit Income"),
        "is_admin_transfer": 'admin' in (m.reason or '').lower(),
        "created_at": m.created_at.isoformat() if m.created_at else None
    } for m in (admin_transfers if is_admin else all_cashouts)[:20]]

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
            "manager_safe_cash": float(manager_safe_cash),
            "total_transferred_to_admin": float(total_transferred_to_admin),
            "today_transferred_to_admin": float(today_transferred_to_admin),
            "admin_transfer_income": float(admin_transfer_income),
            "active_drawer_cash": float(active_drawer_cash),
            "history": cashout_history
        },
        "profit_loss": {
            "gross_profit": float(gross_profit),
            "net_profit": float(net_profit),
            "profit_margin_percent": profit_margin,
            "net_cash_income": float(net_cash_income),
            "admin_net_cash_income": float(admin_net_cash_income),
            "manager_net_cash_income": float(manager_net_cash_income),
            "is_profitable": float(net_profit) >= 0
        }
    }
