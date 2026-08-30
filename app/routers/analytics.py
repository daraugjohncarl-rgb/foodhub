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

    return schemas.DashboardStats(
        today_sales=today_sales,
        total_transactions_today=total_transactions_today,
        low_stock_count=low_stock_count,
        active_staff_count=active_staff_count
    )
