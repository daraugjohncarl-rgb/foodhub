"""
Superadmin Activity Logs & Audit Trail Router
Accessible EXCLUSIVELY to the SUPERADMIN account.
Server-side role protection with Philippine Standard Time (Asia/Manila, UTC+08:00).
Strictly append-only audit trail.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Query, Response
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_, func, desc
from typing import List, Optional, Dict, Any
from datetime import datetime, date, timedelta, timezone
import io
import csv

from app.db import get_db
import app.models as models
from app.core.dependencies import require_super_admin
from app.services.activity_log_service import (
    MANILA_TZ,
    get_manila_now,
    format_manila_date,
    format_manila_time,
    record_activity
)

router = APIRouter(
    prefix="/activity-logs",
    tags=["Activity Logs (Superadmin Exclusive)"]
)


def _serialize_log(log: models.ActivityLog) -> Dict[str, Any]:
    """Helper to serialize ActivityLog with formatted Philippine Standard Time."""
    created_dt = log.created_at
    ph_date = format_manila_date(created_dt)
    ph_time = format_manila_time(created_dt)
    formatted_ts = f"{ph_date} {ph_time}" if created_dt else "—"

    # Display activity name (prefer activity_type, fallback to action)
    act_name = log.activity_type or log.action or "Activity"
    # Display description (prefer description, fallback to details)
    desc_text = log.description or log.details or ""
    # Display username
    user_name = log.username or log.performed_by or "System"
    # Display full name
    f_name = log.full_name or user_name
    # Display status
    stat = (log.status or "SUCCESS").upper()

    return {
        "id": log.id,
        "tenant_id": log.tenant_id,
        "user_id": log.user_id,
        "action": log.action,
        "performed_by": log.performed_by,
        "target_user": log.target_user,
        "role": log.role,
        "details": log.details,
        "username": user_name,
        "full_name": f_name,
        "activity_type": act_name,
        "description": desc_text,
        "ip_address": log.ip_address or "—",
        "user_agent": log.user_agent or "—",
        "session_id": log.session_id or "—",
        "status": stat,
        "metadata_json": log.metadata_json,
        "ph_date": ph_date,
        "ph_time": ph_time,
        "formatted_timestamp": formatted_ts,
        "created_at": (created_dt.replace(tzinfo=MANILA_TZ) if created_dt.tzinfo is None else created_dt.astimezone(MANILA_TZ)).isoformat() if created_dt else None
    }


def _get_date_bounds(date_range: Optional[str], start_date: Optional[str], end_date: Optional[str]):
    """Calculates Philippine calendar date boundaries (start_dt, end_dt)."""
    now_manila = get_manila_now()
    today_manila = now_manila.date()

    if date_range == "today":
        start_d = today_manila
        end_d = today_manila
    elif date_range == "yesterday":
        start_d = today_manila - timedelta(days=1)
        end_d = today_manila - timedelta(days=1)
    elif date_range == "last_7_days":
        start_d = today_manila - timedelta(days=6)
        end_d = today_manila
    elif date_range == "last_30_days":
        start_d = today_manila - timedelta(days=29)
        end_d = today_manila
    elif date_range == "custom" and (start_date or end_date):
        try:
            start_d = datetime.strptime(start_date, "%Y-%m-%d").date() if start_date else today_manila - timedelta(days=365)
        except Exception:
            start_d = today_manila
        try:
            end_d = datetime.strptime(end_date, "%Y-%m-%d").date() if end_date else today_manila
        except Exception:
            end_d = today_manila
    else:
        # All time or unspecified
        return None, None

    start_dt = datetime.combine(start_d, datetime.min.time())
    end_dt = datetime.combine(end_d, datetime.max.time())
    return start_dt, end_dt


@router.get("", summary="List activity logs (SUPERADMIN ONLY)")
def get_activity_logs(
    search: Optional[str] = Query(None, description="Search employee name, username, description, IP, or action"),
    role: Optional[str] = Query(None, description="Filter by account role"),
    activity_type: Optional[str] = Query(None, description="Filter by activity type"),
    status_filter: Optional[str] = Query(None, alias="status", description="Filter by status (SUCCESS, FAILED, INFO, WARNING)"),
    date_range: Optional[str] = Query(None, description="Quick date range (today, yesterday, last_7_days, last_30_days, all, custom)"),
    start_date: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    limit: int = Query(25, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_super_admin)
):
    """
    Exclusive Superadmin Audit Trail listing with server-side role check,
    Philippine timezone timestamps, search, filtering, and summary statistics.
    """
    # 1. Base query: EXCLUDE SUPER_ADMIN from activity logs
    base_query = db.query(models.ActivityLog).filter(
        models.ActivityLog.role != "SUPER_ADMIN",
        models.ActivityLog.role != "UserRole.SUPER_ADMIN"
    )

    # 2. Apply search filter
    if search and search.strip():
        pat = f"%{search.strip()}%"
        base_query = base_query.filter(
            or_(
                models.ActivityLog.action.ilike(pat),
                models.ActivityLog.activity_type.ilike(pat),
                models.ActivityLog.performed_by.ilike(pat),
                models.ActivityLog.username.ilike(pat),
                models.ActivityLog.full_name.ilike(pat),
                models.ActivityLog.target_user.ilike(pat),
                models.ActivityLog.details.ilike(pat),
                models.ActivityLog.description.ilike(pat),
                models.ActivityLog.ip_address.ilike(pat)
            )
        )

    # 3. Apply role filter
    if role and role.strip() and role.strip().upper() != "ALL":
        r_val = role.strip().upper()
        base_query = base_query.filter(
            or_(
                models.ActivityLog.role == r_val,
                models.ActivityLog.role == f"UserRole.{r_val}",
                models.ActivityLog.role == r_val.lower()
            )
        )

    # 4. Apply activity type filter
    if activity_type and activity_type.strip() and activity_type.strip().upper() != "ALL":
        act_val = activity_type.strip()
        base_query = base_query.filter(
            or_(
                models.ActivityLog.activity_type.ilike(f"%{act_val}%"),
                models.ActivityLog.action.ilike(f"%{act_val}%")
            )
        )

    # 5. Apply status filter
    if status_filter and status_filter.strip() and status_filter.strip().upper() != "ALL":
        st_val = status_filter.strip().upper()
        base_query = base_query.filter(models.ActivityLog.status == st_val)

    # 6. Apply date range filter (Philippine calendar dates)
    start_dt, end_dt = _get_date_bounds(date_range, start_date, end_date)
    if start_dt and end_dt:
        base_query = base_query.filter(
            models.ActivityLog.created_at >= start_dt,
            models.ActivityLog.created_at <= end_dt
        )

    # Total matching count for pagination
    total_count = base_query.count()

    # Fetch paginated items
    logs = base_query.order_by(desc(models.ActivityLog.created_at), desc(models.ActivityLog.id)).offset(offset).limit(limit).all()

    # 7. Compute live summary statistics for today in Philippine Standard Time
    now_manila = get_manila_now()
    today_start = datetime.combine(now_manila.date(), datetime.min.time())
    today_end = datetime.combine(now_manila.date(), datetime.max.time())

    today_logs_q = db.query(models.ActivityLog).filter(
        models.ActivityLog.role != "SUPER_ADMIN",
        models.ActivityLog.role != "UserRole.SUPER_ADMIN",
        models.ActivityLog.created_at >= today_start,
        models.ActivityLog.created_at <= today_end
    )

    total_activities_today = today_logs_q.count()

    total_logins_today = today_logs_q.filter(
        or_(
            models.ActivityLog.activity_type.ilike("%login%"),
            models.ActivityLog.action.ilike("%login%")
        ),
        models.ActivityLog.status == "SUCCESS"
    ).count()

    failed_logins_today = today_logs_q.filter(
        or_(
            models.ActivityLog.activity_type.ilike("%failed%"),
            models.ActivityLog.action.ilike("%failed%"),
            models.ActivityLog.status == "FAILED"
        )
    ).count()

    # Active users: distinct non-superadmin users with recent session / activity today
    active_users_count = db.query(func.count(func.distinct(models.ActivityLog.user_id))).filter(
        models.ActivityLog.role != "SUPER_ADMIN",
        models.ActivityLog.role != "UserRole.SUPER_ADMIN",
        models.ActivityLog.user_id.isnot(None),
        models.ActivityLog.created_at >= today_start
    ).scalar() or 0

    items_serialized = [_serialize_log(l) for l in logs]

    return {
        "items": items_serialized,
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "page": (offset // limit) + 1 if limit > 0 else 1,
        "total_pages": ((total_count - 1) // limit) + 1 if (total_count > 0 and limit > 0) else 1,
        "summary": {
            "total_activities_today": total_activities_today,
            "total_logins_today": total_logins_today,
            "active_users": active_users_count,
            "failed_logins_today": failed_logins_today,
            "philippine_date": now_manila.strftime("%B %d, %Y"),
            "philippine_time": now_manila.strftime("%I:%M:%S %p")
        }
    }


@router.get("/summary", summary="Get summary metrics (SUPERADMIN ONLY)")
def get_activity_summary(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_super_admin)
):
    """Returns the 4 summary card values in Philippine Standard Time."""
    now_manila = get_manila_now()
    today_start = datetime.combine(now_manila.date(), datetime.min.time())
    today_end = datetime.combine(now_manila.date(), datetime.max.time())

    today_logs_q = db.query(models.ActivityLog).filter(
        models.ActivityLog.role != "SUPER_ADMIN",
        models.ActivityLog.role != "UserRole.SUPER_ADMIN",
        models.ActivityLog.created_at >= today_start,
        models.ActivityLog.created_at <= today_end
    )

    total_activities_today = today_logs_q.count()
    total_logins_today = today_logs_q.filter(
        or_(
            models.ActivityLog.activity_type.ilike("%login%"),
            models.ActivityLog.action.ilike("%login%")
        ),
        models.ActivityLog.status == "SUCCESS"
    ).count()

    failed_logins_today = today_logs_q.filter(
        or_(
            models.ActivityLog.activity_type.ilike("%failed%"),
            models.ActivityLog.action.ilike("%failed%"),
            models.ActivityLog.status == "FAILED"
        )
    ).count()

    active_users_count = db.query(func.count(func.distinct(models.ActivityLog.user_id))).filter(
        models.ActivityLog.role != "SUPER_ADMIN",
        models.ActivityLog.role != "UserRole.SUPER_ADMIN",
        models.ActivityLog.user_id.isnot(None),
        models.ActivityLog.created_at >= today_start
    ).scalar() or 0

    return {
        "total_activities_today": total_activities_today,
        "total_logins_today": total_logins_today,
        "active_users": active_users_count,
        "failed_logins_today": failed_logins_today,
        "philippine_date": now_manila.strftime("%B %d, %Y"),
        "philippine_time": now_manila.strftime("%I:%M:%S %p")
    }


@router.get("/export", summary="Export audit logs to CSV (SUPERADMIN ONLY)")
def export_activity_logs(
    search: Optional[str] = Query(None),
    role: Optional[str] = Query(None),
    activity_type: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    date_range: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_super_admin)
):
    """
    Exports filtered activity audit trail to CSV format respecting current filters
    and displaying formatted Philippine Standard Time timestamps.
    """
    query = db.query(models.ActivityLog).filter(
        models.ActivityLog.role != "SUPER_ADMIN",
        models.ActivityLog.role != "UserRole.SUPER_ADMIN"
    )

    if search and search.strip():
        pat = f"%{search.strip()}%"
        query = query.filter(
            or_(
                models.ActivityLog.action.ilike(pat),
                models.ActivityLog.activity_type.ilike(pat),
                models.ActivityLog.performed_by.ilike(pat),
                models.ActivityLog.username.ilike(pat),
                models.ActivityLog.full_name.ilike(pat),
                models.ActivityLog.details.ilike(pat),
                models.ActivityLog.description.ilike(pat),
                models.ActivityLog.ip_address.ilike(pat)
            )
        )

    if role and role.strip() and role.strip().upper() != "ALL":
        r_val = role.strip().upper()
        query = query.filter(
            or_(
                models.ActivityLog.role == r_val,
                models.ActivityLog.role == f"UserRole.{r_val}",
                models.ActivityLog.role == r_val.lower()
            )
        )

    if activity_type and activity_type.strip() and activity_type.strip().upper() != "ALL":
        act_val = activity_type.strip()
        query = query.filter(
            or_(
                models.ActivityLog.activity_type.ilike(f"%{act_val}%"),
                models.ActivityLog.action.ilike(f"%{act_val}%")
            )
        )

    if status_filter and status_filter.strip() and status_filter.strip().upper() != "ALL":
        st_val = status_filter.strip().upper()
        query = query.filter(models.ActivityLog.status == st_val)

    start_dt, end_dt = _get_date_bounds(date_range, start_date, end_date)
    if start_dt and end_dt:
        query = query.filter(
            models.ActivityLog.created_at >= start_dt,
            models.ActivityLog.created_at <= end_dt
        )

    logs = query.order_by(desc(models.ActivityLog.created_at), desc(models.ActivityLog.id)).limit(1000).all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Log ID",
        "Philippine Date",
        "Philippine Time",
        "Account Name",
        "Username",
        "Role",
        "Activity",
        "Description",
        "IP Address",
        "Status",
        "Session ID"
    ])

    for l in logs:
        s = _serialize_log(l)
        writer.writerow([
            s["id"],
            s["ph_date"],
            s["ph_time"],
            s["full_name"],
            s["username"],
            s["role"],
            s["activity_type"],
            s["description"],
            s["ip_address"],
            s["status"],
            s["session_id"]
        ])

    csv_data = output.getvalue()
    filename = f"activity_logs_ph_{get_manila_now().strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )
