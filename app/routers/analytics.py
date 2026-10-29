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
from app.core.dependencies import require_manager_or_admin, resolve_tenant_id

router = APIRouter(tags=["Analytics"])


@router.get(
    "/analytics/dashboard",
    response_model=schemas.DashboardStats,
    summary="Get tenant-scoped dashboard overview metrics"
)
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    tenant_id = resolve_tenant_id(current_user, db)

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
            func.lower(models.Payment.payment_method).like("cash%")
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


from typing import Optional
from fastapi import Query, HTTPException, status
from app.services.financial_service import get_consolidated_financial_report


def _require_admin_or_manager(current_user: models.User) -> None:
    role_str = str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role).upper()
    if role_str not in ["ADMIN", "MANAGER", "SUPER_ADMIN"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access to financial reports is restricted to Admin and Manager roles only."
        )


@router.get(
    "/analytics/profit-loss",
    summary="Comprehensive Profit & Loss, Inventory Valuation, and Cashout Income Report"
)
def get_profit_loss(
    period: Optional[str] = Query("today", description="today, yesterday, this_week, this_month, this_year, all, custom"),
    start_date: Optional[str] = Query(None, description="ISO start timestamp"),
    end_date: Optional[str] = Query(None, description="ISO end timestamp"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    """
    Authoritative financial reporting endpoint.
    Restricted to ADMIN, SUPER_ADMIN, and MANAGER.
    Calculates gross sales, net sales, accurate COGS, gross profit, operating expenses,
    net operating profit/loss, margin, inventory valuation, drawer reconciliations,
    and Manager-to-Admin transfer remittances.
    """
    _require_admin_or_manager(current_user)

    tenant_id = resolve_tenant_id(current_user, db)

    return get_consolidated_financial_report(
        db=db,
        tenant_id=tenant_id,
        current_user=current_user,
        period=period,
        start_date=start_date,
        end_date=end_date
    )


@router.get(
    "/analytics/reconciliation",
    summary="System-wide Financial Reconciliation and Discrepancy Audit"
)
def get_reconciliation_audit(
    period: Optional[str] = Query("all"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    """
    Detailed financial balance verification across orders, payments, drawer movements,
    inventory costs, and internal transfers.
    Restricted to ADMIN and SUPER_ADMIN.
    """
    role_str = str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role).upper()
    if role_str not in ["ADMIN", "SUPER_ADMIN"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Reconciliation audit is restricted to Admin only."
        )

    tenant_id = resolve_tenant_id(current_user, db)

    report = get_consolidated_financial_report(
        db=db,
        tenant_id=tenant_id,
        current_user=current_user,
        period=period,
        start_date=start_date,
        end_date=end_date
    )
    return report.get("reconciliation", {})

