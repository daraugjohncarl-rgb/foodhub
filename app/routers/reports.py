"""
Reports Router (app/routers/reports.py)
========================================
Handles incident/issue report submission by tenant users and Super Admin management.

Endpoints:
  POST   /reports                         — Any authenticated user submits a report
  GET    /reports/my-reports              — Authenticated user views their own reports
  GET    /super-admin/reports             — Super Admin: view all reports with filters
  PUT    /super-admin/reports/{report_id} — Super Admin: update status & add admin notes
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional

from app.db import get_db
import app.models as models
from app.schemas import ReportCreate, ReportUpdateStatus, ReportResponse
from app.core.dependencies import get_current_user


router = APIRouter(tags=["Incident Reports"])


# ─────────────────────────────────────────────────────────────
# Helper: enforce Super Admin access
# ─────────────────────────────────────────────────────────────

def _require_super_admin(current_user: models.User) -> None:
    """Raise HTTP 403 if the caller is not SUPER_ADMIN."""
    if current_user.role != models.UserRole.SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access restricted to Super Admin only."
        )


# ─────────────────────────────────────────────────────────────
# POST /reports — Tenant user submits a new report
# ─────────────────────────────────────────────────────────────

@router.post("/reports", response_model=ReportResponse, status_code=status.HTTP_201_CREATED)
def submit_report(
    report_in: ReportCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Submit a new incident/bug/issue report.
    Open to any authenticated user (ADMIN, MANAGER, CASHIER, INVENTORY, KITCHEN).
    The report is automatically scoped to the caller's tenant and user ID.
    """
    # Only tenant-bound users can submit reports (SUPER_ADMIN has no tenant scope)
    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Super Admin accounts are not associated with a tenant and cannot submit reports."
        )

    report = models.IncidentReport(
        tenant_id=current_user.tenant_id,
        user_id=current_user.id,
        title=report_in.title.strip(),
        category=report_in.category,
        priority=report_in.priority,
        status=models.ReportStatus.OPEN,
        description=report_in.description.strip(),
    )
    db.add(report)

    # Audit trail — "Report Submitted"
    try:
        log = models.ActivityLog(
            tenant_id=current_user.tenant_id,
            user_id=current_user.id,
            action="Report Submitted",
            performed_by=current_user.username,
            target_user=None,
            role=str(current_user.role.value if hasattr(current_user.role, "value") else current_user.role),
            details=f"Report '{report_in.title}' submitted by {current_user.username} [{report_in.category.value}]",
        )
        db.add(log)
    except Exception:
        pass  # Never block report submission due to log failure

    db.commit()
    db.refresh(report)

    # Eager-load relationships for serialisation
    report = (
        db.query(models.IncidentReport)
        .options(joinedload(models.IncidentReport.tenant), joinedload(models.IncidentReport.user))
        .filter(models.IncidentReport.id == report.id)
        .first()
    )
    return report


# ─────────────────────────────────────────────────────────────
# GET /reports/my-reports — Caller views their own reports
# ─────────────────────────────────────────────────────────────

@router.get("/reports/my-reports", response_model=List[ReportResponse])
def get_my_reports(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Retrieve all incident reports previously submitted by the authenticated user.
    Returns results ordered by most-recent first.
    """
    reports = (
        db.query(models.IncidentReport)
        .options(joinedload(models.IncidentReport.tenant), joinedload(models.IncidentReport.user))
        .filter(models.IncidentReport.user_id == current_user.id)
        .order_by(models.IncidentReport.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return reports


# ─────────────────────────────────────────────────────────────
# GET /super-admin/reports — Super Admin views all reports
# ─────────────────────────────────────────────────────────────

@router.get("/super-admin/reports", response_model=List[ReportResponse])
def get_all_reports(
    tenant_id: Optional[int] = Query(None, description="Filter by specific tenant ID"),
    status: Optional[models.ReportStatus] = Query(None, description="Filter by report status"),
    priority: Optional[models.ReportPriority] = Query(None, description="Filter by priority level"),
    category: Optional[models.ReportCategory] = Query(None, description="Filter by report category"),
    search: Optional[str] = Query(None, description="Search by report title"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Super Admin endpoint — retrieve all system-wide incident reports with optional filters.
    Supports filtering by tenant, status, priority, category, and a title search.
    """
    _require_super_admin(current_user)

    query = (
        db.query(models.IncidentReport)
        .options(joinedload(models.IncidentReport.tenant), joinedload(models.IncidentReport.user))
    )

    if tenant_id is not None:
        query = query.filter(models.IncidentReport.tenant_id == tenant_id)
    if status is not None:
        query = query.filter(models.IncidentReport.status == status)
    if priority is not None:
        query = query.filter(models.IncidentReport.priority == priority)
    if category is not None:
        query = query.filter(models.IncidentReport.category == category)
    if search and search.strip():
        query = query.filter(models.IncidentReport.title.ilike(f"%{search.strip()}%"))

    reports = query.order_by(models.IncidentReport.created_at.desc()).offset(offset).limit(limit).all()
    return reports


# ─────────────────────────────────────────────────────────────
# PUT /super-admin/reports/{report_id} — Super Admin updates a report
# ─────────────────────────────────────────────────────────────

@router.put("/super-admin/reports/{report_id}", response_model=ReportResponse)
def update_report_status(
    report_id: int,
    update_in: ReportUpdateStatus,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Super Admin endpoint — update the status and/or admin notes of an incident report.
    Automatically writes an ActivityLog entry for the audit trail.
    """
    _require_super_admin(current_user)

    report = (
        db.query(models.IncidentReport)
        .options(joinedload(models.IncidentReport.tenant), joinedload(models.IncidentReport.user))
        .filter(models.IncidentReport.id == report_id)
        .first()
    )
    if not report:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Incident report #{report_id} not found."
        )

    previous_status = report.status.value if hasattr(report.status, "value") else str(report.status)
    report.status = update_in.status
    if update_in.admin_notes is not None:
        report.admin_notes = update_in.admin_notes.strip() if update_in.admin_notes.strip() else None

    # Audit trail — "Report Status Updated"
    try:
        new_status = update_in.status.value if hasattr(update_in.status, "value") else str(update_in.status)
        log = models.ActivityLog(
            tenant_id=report.tenant_id,
            user_id=current_user.id,
            action="Report Status Updated",
            performed_by=current_user.username,
            target_user=report.user.username if report.user else None,
            role=str(current_user.role.value if hasattr(current_user.role, "value") else current_user.role),
            details=(
                f"Report #{report_id} '{report.title}' status changed from "
                f"{previous_status} → {new_status} by {current_user.username}"
            ),
        )
        db.add(log)
    except Exception:
        pass  # Never block status update due to log failure

    db.commit()
    db.refresh(report)

    # Re-query to ensure fresh relationship data after update
    report = (
        db.query(models.IncidentReport)
        .options(joinedload(models.IncidentReport.tenant), joinedload(models.IncidentReport.user))
        .filter(models.IncidentReport.id == report_id)
        .first()
    )
    return report
