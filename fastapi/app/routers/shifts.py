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

@router.post("/cash-movement", response_model=schemas.ShiftCashMovementResponse)
def add_cash_movement(
    body: schemas.ShiftCashMovementCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Log a cash movement (PAID_IN/PAID_OUT) during a shift."""
    tenant_id = _get_user_tenant_id(db, current_user)
    shift = db.query(models.Shift).filter(
        models.Shift.id == body.shift_id,
        models.Shift.tenant_id == tenant_id,
        models.Shift.user_id == current_user.id,
        models.Shift.status == "open"
    ).first()

    if not shift:
        raise HTTPException(status_code=404, detail="Active shift not found for this user/tenant.")

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
