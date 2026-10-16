from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Optional
from decimal import Decimal
from datetime import datetime

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/shifts", tags=["Shifts"])

def _get_user_tenant_id(db: Session, current_user: models.User) -> int:
    if current_user.tenant_id:
        return current_user.tenant_id
    first_tenant = db.query(models.Tenant).first()
    return first_tenant.id if first_tenant else 1

@router.get("/active", response_model=Optional[schemas.ShiftResponse])
def get_active_shift(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Retrieve the currently active shift for the user."""
    tenant_id = _get_user_tenant_id(db, current_user)
    shift = db.query(models.Shift).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.user_id == current_user.id,
        models.Shift.status == "open"
    ).first()
    return shift

@router.post("/start", response_model=schemas.ShiftResponse)
def start_shift(
    body: schemas.ShiftCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Start a new shift for the user."""
    tenant_id = _get_user_tenant_id(db, current_user)
    # Check if a shift is already open
    active_shift = db.query(models.Shift).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.user_id == current_user.id,
        models.Shift.status == "open"
    ).first()

    if active_shift:
        raise HTTPException(status_code=400, detail="User already has an open shift.")

    new_shift = models.Shift(
        tenant_id=tenant_id,
        user_id=current_user.id,
        start_cash=body.start_cash,
        status="open"
    )
    db.add(new_shift)
    db.commit()
    db.refresh(new_shift)
    return new_shift

@router.put("/end", response_model=schemas.ShiftResponse)
def end_shift(
    body: schemas.ShiftEnd,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """End the currently active shift."""
    tenant_id = _get_user_tenant_id(db, current_user)
    shift = db.query(models.Shift).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.user_id == current_user.id,
        models.Shift.status == "open"
    ).first()

    if not shift:
        raise HTTPException(status_code=404, detail="No active shift found.")

    shift.end_cash = body.end_cash
    shift.end_time = datetime.utcnow()
    shift.status = "closed"
    db.commit()
    db.refresh(shift)
    return shift

@router.get("/drawer-summary")
def get_drawer_summary(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Real-time cashier cash-in-drawer tracker and shift breakdown for Manager and Admin.
    Calculates expected cash in drawer (Float + Cash Sales + Paid In - Paid Out) for all cashier shifts.
    """
    from sqlalchemy import func
    tenant_id = _get_user_tenant_id(db, current_user)

    # Fetch shifts for this tenant (open shifts first, ordered by id descending)
    shifts = db.query(models.Shift).filter(
        models.Shift.tenant_id == tenant_id
    ).order_by(
        (models.Shift.status == "open").desc(),
        models.Shift.id.desc()
    ).limit(30).all()

    drawer_list = []
    total_cash_in_active_drawers = Decimal("0.0")
    active_drawers_count = 0
    today_total_cash_sales = Decimal("0.0")

    for s in shifts:
        # Cash sales for this shift
        cash_sales_val = db.query(
            func.coalesce(func.sum(models.Payment.amount), 0)
        ).join(models.Transaction).filter(
            models.Transaction.shift_id == s.id,
            models.Payment.status == "completed",
            ~models.Transaction.status.in_(["cancelled", "rejected"]),
            func.lower(models.Payment.payment_method).like("%cash%")
        ).scalar() or Decimal("0.0")

        # Non-cash sales (GCash, Card, E-wallet)
        non_cash_val = db.query(
            func.coalesce(func.sum(models.Payment.amount), 0)
        ).join(models.Transaction).filter(
            models.Transaction.shift_id == s.id,
            models.Payment.status == "completed",
            ~models.Transaction.status.in_(["cancelled", "rejected"]),
            ~func.lower(models.Payment.payment_method).like("%cash%")
        ).scalar() or Decimal("0.0")

        # Cash movements (PAID_IN / PAID_OUT)
        paid_in_val = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(
            models.ShiftCashMovement.shift_id == s.id,
            models.ShiftCashMovement.type == "PAID_IN"
        ).scalar() or Decimal("0.0")

        paid_out_val = db.query(
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(
            models.ShiftCashMovement.shift_id == s.id,
            models.ShiftCashMovement.type == "PAID_OUT"
        ).scalar() or Decimal("0.0")

        expected_cash = Decimal(str(s.start_cash or 0)) + Decimal(str(cash_sales_val)) + Decimal(str(paid_in_val)) - Decimal(str(paid_out_val))

        if s.status == "open":
            total_cash_in_active_drawers += expected_cash
            active_drawers_count += 1
            today_total_cash_sales += Decimal(str(cash_sales_val))

        cashier_name = s.user.username if s.user else "Unknown"
        if s.user and s.user.first_name:
            cashier_name = f"{s.user.first_name} {s.user.last_name or ''}".strip()

        movements = [{
            "id": m.id,
            "type": m.type,
            "amount": float(m.amount),
            "reason": m.reason,
            "recorded_by": m.user.username if m.user else "Staff",
            "created_at": m.created_at.isoformat() if m.created_at else None
        } for m in sorted(s.shift_cash_movements, key=lambda x: x.id, reverse=True)]

        drawer_list.append({
            "id": s.id,
            "cashier_id": s.user_id,
            "cashier_username": s.user.username if s.user else "unknown",
            "cashier_name": cashier_name,
            "status": s.status,
            "start_time": s.start_time.isoformat() if s.start_time else None,
            "end_time": s.end_time.isoformat() if s.end_time else None,
            "start_cash": float(s.start_cash or 0),
            "cash_sales": float(cash_sales_val),
            "non_cash_sales": float(non_cash_val),
            "total_sales": float(cash_sales_val + non_cash_val),
            "paid_in": float(paid_in_val),
            "paid_out": float(paid_out_val),
            "expected_cash": float(expected_cash),
            "end_cash": float(s.end_cash) if s.end_cash is not None else None,
            "variance": float(s.end_cash - expected_cash) if s.end_cash is not None else None,
            "movements": movements
        })

    return {
        "total_cash_in_drawers": float(total_cash_in_active_drawers),
        "active_drawers_count": active_drawers_count,
        "today_total_cash_sales": float(today_total_cash_sales),
        "shifts": drawer_list
    }

@router.post("/cash-movement", response_model=schemas.ShiftCashMovementResponse)
def add_cash_movement(
    body: schemas.ShiftCashMovementCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Log a cash movement (PAID_IN/PAID_OUT / Cash Drop) during a shift."""
    tenant_id = _get_user_tenant_id(db, current_user)
    role_val = current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role)
    is_admin_or_mgr = role_val.upper() in ["ADMIN", "MANAGER", "SUPER_ADMIN"]

    query = db.query(models.Shift).filter(
        models.Shift.id == body.shift_id,
        models.Shift.tenant_id == tenant_id,
        models.Shift.status == "open"
    )
    if not is_admin_or_mgr:
        query = query.filter(models.Shift.user_id == current_user.id)

    shift = query.first()

    if not shift:
        raise HTTPException(status_code=404, detail="Active open shift not found for this user/tenant.")

    movement = models.ShiftCashMovement(
        tenant_id=tenant_id,
        shift_id=shift.id,
        user_id=current_user.id,
        type=body.type,
        amount=body.amount,
        reason=body.reason
    )
    db.add(movement)
    db.commit()
    db.refresh(movement)
    return movement
