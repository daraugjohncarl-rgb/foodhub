from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import List, Optional
from app.db import get_db
import app.models as models
from app.schemas import ActivityLogResponse, ActivityLogCreate
from app.core.dependencies import get_current_user

router = APIRouter(
    prefix="/activity-logs",
    tags=["Activity Logs"]
)

@router.get("", response_model=List[ActivityLogResponse])
def get_activity_logs(
    search: Optional[str] = Query(None, description="Search by action, user, or target"),
    action: Optional[str] = Query(None, description="Filter by action name"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Retrieve activity logs / audit trail.
    Branch Admins only see logs belonging to their own store branch (excluding SUPER_ADMIN logs).
    """
    query = db.query(models.ActivityLog)
    
    # Restrict non-SUPER_ADMIN users to their own tenant and exclude SUPER_ADMIN & global logs
    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.ActivityLog.tenant_id == current_user.tenant_id,
            models.ActivityLog.tenant_id.isnot(None),
            models.ActivityLog.role != "SUPER_ADMIN",
            models.ActivityLog.role != "UserRole.SUPER_ADMIN"
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
        
    logs = query.order_by(models.ActivityLog.created_at.desc()).offset(offset).limit(limit).all()
    return logs

@router.post("", response_model=ActivityLogResponse, status_code=status.HTTP_201_CREATED)
def create_activity_log(
    log_in: ActivityLogCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Manually record an activity log entry.
    """
    log = models.ActivityLog(
        tenant_id=current_user.tenant_id,
        user_id=current_user.id,
        action=log_in.action,
        performed_by=log_in.performed_by or current_user.username,
        target_user=log_in.target_user,
        role=log_in.role or str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=log_in.details
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log

@router.delete("")
def clear_activity_logs(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Clear all activity logs (Super Admin only).
    """
    if current_user.role != models.UserRole.SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Super Admins are permitted to clear audit trail logs."
        )
    db.query(models.ActivityLog).delete()
    db.commit()
    return {"message": "All activity logs have been cleared."}
