"""
Audit trail (H8).

* Read: SUPER_ADMIN (everything), ADMIN and MANAGER (their own branch only, excluding super-admin activity).
* Entries are written by the server only (app/core/audit.py); there is no endpoint that lets a client invent one.
* Bulk deletion is replaced by a SUPER_ADMIN-only retention purge that never removes entries younger than
  ACTIVITY_LOG_MIN_RETENTION_DAYS, and that itself leaves an audit entry.
"""
from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
from app.schemas import ActivityLogResponse
from app.core import audit, config
from app.core.dependencies import require_permission
from app.core.timeutils import utcnow

router = APIRouter(
    prefix="/activity-logs",
    tags=["Activity Logs"]
)


@router.get("", response_model=List[ActivityLogResponse])
def get_activity_logs(
    search: Optional[str] = Query(None, max_length=100, description="Search by action, user, or target"),
    action: Optional[str] = Query(None, max_length=50, description="Filter by action name"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("audit.read")),
):
    query = db.query(models.ActivityLog)

    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.ActivityLog.tenant_id == current_user.tenant_id,
            or_(models.ActivityLog.role.is_(None), models.ActivityLog.role.notin_(["SUPER_ADMIN", "UserRole.SUPER_ADMIN"])),
        )

    if action and action.strip():
        query = query.filter(models.ActivityLog.action.ilike(f"%{action.strip()}%"))

    if search and search.strip():
        pattern = f"%{search.strip()}%"
        query = query.filter(
            or_(
                models.ActivityLog.action.ilike(pattern),
                models.ActivityLog.performed_by.ilike(pattern),
                models.ActivityLog.target_user.ilike(pattern),
                models.ActivityLog.details.ilike(pattern)
            )
        )

    return query.order_by(models.ActivityLog.created_at.desc(), models.ActivityLog.id.desc()).offset(offset).limit(limit).all()


@router.delete("")
def purge_old_activity_logs(
    older_than_days: int = Query(..., description="Delete entries older than this many days"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("audit.purge")),
):
    """Retention purge (SUPER_ADMIN only). Recent history cannot be erased."""
    if older_than_days < config.ACTIVITY_LOG_MIN_RETENTION_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"Audit entries must be kept for at least {config.ACTIVITY_LOG_MIN_RETENTION_DAYS} days.",
        )
    cutoff = utcnow() - timedelta(days=older_than_days)
    deleted = db.query(models.ActivityLog).filter(models.ActivityLog.created_at < cutoff).delete(synchronize_session=False)
    audit.record(db, current_user, "Audit Log Purge",
                 details=f"Deleted {deleted} entries older than {older_than_days} days")
    db.commit()
    return {"message": f"Deleted {deleted} audit entries older than {older_than_days} days.", "deleted": deleted}
