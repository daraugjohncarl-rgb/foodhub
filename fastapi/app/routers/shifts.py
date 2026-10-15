"""
Cashier shifts (M3).

A shift must be opened explicitly with the opening float before sales can be rung up. Closing it records the
counted cash and computes:  expected = opening float + cash sales (net of change) + paid-in - paid-out,
and variance = counted - expected. Card/e-wallet payments are not part of the cash drawer.
"""
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core import audit
from app.core.dependencies import require_permission, resolve_tenant_id
from app.core.timeutils import utcnow

router = APIRouter(prefix="/shifts", tags=["Shifts"])

can_use_shifts = require_permission("shifts.own")


def _open_shift(db: Session, tenant_id: int, user: models.User, lock: bool = False) -> Optional[models.Shift]:
    q = db.query(models.Shift).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.user_id == user.id,
        models.Shift.status == "open",
    ).order_by(models.Shift.id.desc())
    if lock:
        q = q.with_for_update()
    return q.first()


def expected_cash(db: Session, shift: models.Shift) -> Decimal:
    cash_sales = db.query(func.coalesce(func.sum(models.Payment.amount), 0)).join(models.Transaction).filter(
        models.Transaction.shift_id == shift.id,
        models.Transaction.status.notin_(models.NON_REVENUE_TRANSACTION_STATUSES),
        func.upper(models.Payment.payment_method) == "CASH",
    ).scalar()
    movements = dict(
        db.query(models.ShiftCashMovement.type, func.coalesce(func.sum(models.ShiftCashMovement.amount), 0))
        .filter(models.ShiftCashMovement.shift_id == shift.id)
        .group_by(models.ShiftCashMovement.type)
        .all()
    )
    return (
        Decimal(shift.start_cash or 0)
        + Decimal(cash_sales or 0)
        + Decimal(movements.get("PAID_IN", 0))
        - Decimal(movements.get("PAID_OUT", 0))
    )


@router.get("/active", response_model=Optional[schemas.ShiftResponse])
def get_active_shift(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_use_shifts),
):
    """Retrieve the currently active shift for the user (null when none is open)."""
    return _open_shift(db, resolve_tenant_id(db, current_user, None), current_user)


@router.post("/start", response_model=schemas.ShiftResponse)
def start_shift(
    body: schemas.ShiftCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_use_shifts),
):
    """Start a new shift with the opening cash float."""
    tenant_id = resolve_tenant_id(db, current_user, None)
    # Serialise concurrent "start shift" clicks for the same user.
    db.query(models.User).filter(models.User.id == current_user.id).with_for_update().first()
    if _open_shift(db, tenant_id, current_user):
        raise HTTPException(status_code=400, detail="User already has an open shift.")

    new_shift = models.Shift(
        tenant_id=tenant_id,
        user_id=current_user.id,
        start_cash=body.start_cash,
        status="open"
    )
    db.add(new_shift)
    db.flush()
    audit.record(db, current_user, "Shift Started", tenant_id=tenant_id,
                 details=f"Shift #{new_shift.id} opened with float {body.start_cash:.2f}")
    db.commit()
    db.refresh(new_shift)
    return new_shift


@router.put("/end", response_model=schemas.ShiftResponse)
def end_shift(
    body: schemas.ShiftEnd,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_use_shifts),
):
    """Close the open shift, recording counted cash, expected cash and the variance."""
    tenant_id = resolve_tenant_id(db, current_user, None)
    shift = _open_shift(db, tenant_id, current_user, lock=True)
    if not shift:
        raise HTTPException(status_code=404, detail="No active shift found.")

    expected = expected_cash(db, shift)
    shift.end_cash = body.end_cash
    shift.expected_cash = expected
    shift.cash_variance = Decimal(body.end_cash) - expected
    shift.end_time = utcnow()
    shift.status = "closed"
    audit.record(db, current_user, "Shift Closed", tenant_id=tenant_id,
                 details=f"Shift #{shift.id}: counted {body.end_cash:.2f}, expected {expected:.2f}, "
                         f"variance {shift.cash_variance:.2f}")
    db.commit()
    db.refresh(shift)
    return shift


@router.post("/cash-movement", response_model=schemas.ShiftCashMovementResponse)
def add_cash_movement(
    body: schemas.ShiftCashMovementCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_use_shifts),
):
    """Log a cash movement (PAID_IN/PAID_OUT) during your open shift."""
    tenant_id = resolve_tenant_id(db, current_user, None)
    shift = _open_shift(db, tenant_id, current_user)
    if not shift or (body.shift_id is not None and body.shift_id != shift.id):
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
    audit.record(db, current_user, "Cash Movement", tenant_id=tenant_id,
                 details=f"{body.type} {body.amount:.2f} on shift #{shift.id}")
    db.commit()
    db.refresh(movement)
    return movement
