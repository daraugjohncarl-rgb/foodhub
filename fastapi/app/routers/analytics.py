"""
Analytics Router
================
Branch dashboard statistics for ADMIN, MANAGER and SUPER_ADMIN.

Revenue counts every paid sale (anything not voided/cancelled/refunded) as soon as it is rung up, regardless of
whether the kitchen has finished it (C6). "Today" is the business-timezone calendar day (Asia/Manila by default),
converted to UTC boundaries for the query (M2).
"""
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import require_permission, resolve_tenant_id
from app.core.timeutils import business_day_bounds_utc

router = APIRouter(tags=["Analytics"])


def revenue_filter(query, tenant_id: int, start, end):
    return query.filter(
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status.notin_(models.NON_REVENUE_TRANSACTION_STATUSES),
        models.Transaction.created_at >= start,
        models.Transaction.created_at < end,
    )


@router.get(
    "/analytics/dashboard",
    response_model=schemas.DashboardStats,
    summary="Get tenant-scoped dashboard overview metrics"
)
def get_dashboard_stats(
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to view"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("analytics.read")),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    start, end = business_day_bounds_utc()

    tx_query = revenue_filter(
        db.query(
            func.coalesce(func.sum(models.Transaction.net_amount), 0).label("total_sales"),
            func.count(models.Transaction.id).label("tx_count"),
        ),
        scope_tenant, start, end,
    ).first()

    low_stock_count = (
        db.query(func.count(models.InventoryItem.id))
        .filter(
            models.InventoryItem.tenant_id == scope_tenant,
            models.InventoryItem.is_active.is_(True),
            models.InventoryItem.item_type != models.InventoryItemType.EQUIPMENT.value,
            models.InventoryItem.quantity <= models.InventoryItem.min_stock,
        )
        .scalar()
        or 0
    )

    active_staff_count = (
        db.query(func.count(models.User.id))
        .filter(
            models.User.tenant_id == scope_tenant,
            models.User.is_active.is_(True),
            models.User.role.notin_([models.UserRole.SUPER_ADMIN, models.UserRole.ADMIN])
        )
        .scalar()
        or 0
    )

    return schemas.DashboardStats(
        today_sales=Decimal(tx_query.total_sales or 0),
        total_transactions_today=int(tx_query.tx_count or 0),
        low_stock_count=low_stock_count,
        active_staff_count=active_staff_count
    )
