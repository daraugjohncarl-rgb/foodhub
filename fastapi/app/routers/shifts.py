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

    # Fetch shifts for this tenant (Cashier role accounts only, open shifts first)
    shifts = db.query(models.Shift).join(models.User).filter(
        models.Shift.tenant_id == tenant_id,
        models.User.role == models.UserRole.CASHIER
    ).order_by(
        (models.Shift.status == "open").desc(),
        models.Shift.id.desc()
    ).limit(30).all()

    has_open_shift = any(s.status == "open" for s in shifts)
    if not has_open_shift:
        cashier_user = db.query(models.User).filter(
            models.User.tenant_id == tenant_id,
            models.User.role == models.UserRole.CASHIER
        ).first()
        if cashier_user:
            new_shift = models.Shift(
                tenant_id=tenant_id,
                user_id=cashier_user.id,
                start_cash=Decimal("0.0"),
                status="open"
            )
            db.add(new_shift)
            db.commit()
            db.refresh(new_shift)
            shifts = [new_shift] + list(shifts)

    drawer_list = []
    total_cash_in_active_drawers = Decimal("0.0")
    active_drawers_count = 0
    today_total_cash_sales = Decimal("0.0")
    today_total_orders_amount = Decimal("0.0")

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
        shift_total_sales = Decimal(str(cash_sales_val)) + Decimal(str(non_cash_val))

        if s.status == "open":
            total_cash_in_active_drawers += expected_cash
            active_drawers_count += 1
            today_total_cash_sales += Decimal(str(cash_sales_val))
            today_total_orders_amount += shift_total_sales

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
            "role": str(s.user.role.value if hasattr(s.user.role, 'value') else s.user.role).lower() if s.user else "cashier",
            "status": s.status,
            "start_time": s.start_time.isoformat() if s.start_time else None,
            "end_time": s.end_time.isoformat() if s.end_time else None,
            "start_cash": float(s.start_cash or 0),
            "cash_sales": float(cash_sales_val),
            "non_cash_sales": float(non_cash_val),
            "total_sales": float(shift_total_sales),
            "paid_in": float(paid_in_val),
            "paid_out": float(paid_out_val),
            "cashed_out": float(paid_out_val),
            "expected_cash": float(expected_cash),
            "cashier_overall_income": float(shift_total_sales + Decimal(str(s.start_cash or 0)) + Decimal(str(paid_in_val)) if (shift_total_sales + Decimal(str(s.start_cash or 0)) + Decimal(str(paid_in_val))) > Decimal("0.0") else (shift_total_sales + expected_cash + Decimal(str(paid_out_val)))),
            "end_cash": float(s.end_cash) if s.end_cash is not None else None,
            "variance": float(s.end_cash - expected_cash) if s.end_cash is not None else None,
            "movements": movements
        })

    from datetime import datetime, time
    today = datetime.now().date()
    start_of_day = datetime.combine(today, time.min)
    end_of_day = datetime.combine(today, time.max)

    all_today_tx = db.query(
        func.coalesce(func.sum(models.Transaction.net_amount), 0)
    ).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status == "completed",
        models.Transaction.created_at >= start_of_day,
        models.Transaction.created_at <= end_of_day
    ).scalar() or Decimal("0.0")

    today_orders_val = Decimal(str(all_today_tx))
    if today_orders_val == Decimal("0.0"):
        today_orders_val = today_total_orders_amount

    all_today_cash = db.query(
        func.coalesce(func.sum(models.Payment.amount), 0)
    ).join(models.Transaction).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        func.lower(models.Payment.payment_method).like("%cash%"),
        models.Transaction.created_at >= start_of_day,
        models.Transaction.created_at <= end_of_day
    ).scalar() or Decimal("0.0")

    today_cash_val = Decimal(str(all_today_cash))
    if today_cash_val == Decimal("0.0"):
        today_cash_val = today_total_cash_sales

    all_time_income = db.query(
        func.coalesce(func.sum(models.Transaction.net_amount), 0)
    ).filter(
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status == "completed"
    ).scalar() or Decimal("0.0")

    overall_income_with_drawer = Decimal(str(all_time_income)) + Decimal(str(total_cash_in_active_drawers))

    return {
        "total_cash_in_drawers": float(total_cash_in_active_drawers),
        "active_drawers_count": active_drawers_count,
        "today_total_cash_sales": float(today_cash_val),
        "today_total_orders_amount": float(today_orders_val),
        "overall_income": float(overall_income_with_drawer),
        "orders_overall_income": float(all_time_income),
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

@router.post("/cashout")
@router.post("/withdraw")
def cashout_shift(
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Manager/Admin cashout of overall cashier money income:
    1. Records cash drop / paid out of the specified amount.
    2. Resets the drawer to zero by closing the shift and creating a new fresh open drawer at ₱0.00.
    """
    tenant_id = _get_user_tenant_id(db, current_user)
    role_val = current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role)
    is_admin_or_mgr = role_val.upper() in ["ADMIN", "MANAGER", "SUPER_ADMIN"]

    shift_id = body.get("shift_id")
    try:
        amount = Decimal(str(body.get("amount", 0)))
    except Exception:
        amount = Decimal("0.0")

    reason = body.get("reason", "Manager Cashout")

    query = db.query(models.Shift).join(models.User).filter(
        models.Shift.tenant_id == tenant_id,
        models.Shift.status == "open",
        models.User.role == models.UserRole.CASHIER
    )
    if shift_id:
        query = query.filter(models.Shift.id == shift_id)
    elif not is_admin_or_mgr:
        query = query.filter(models.Shift.user_id == current_user.id)

    shift = query.order_by(models.Shift.id.desc()).first()
    if not shift:
        if shift_id:
            shift = db.query(models.Shift).filter(
                models.Shift.id == shift_id,
                models.Shift.tenant_id == tenant_id
            ).first()

        if not shift:
            cashier_user = db.query(models.User).filter(
                models.User.tenant_id == tenant_id,
                models.User.role == models.UserRole.CASHIER
            ).first()
            user_id = cashier_user.id if cashier_user else current_user.id
            shift = models.Shift(
                tenant_id=tenant_id,
                user_id=user_id,
                start_cash=Decimal("0.0"),
                status="open"
            )
            db.add(shift)
            db.commit()
            db.refresh(shift)

    from sqlalchemy import func
    cash_sales = db.query(
        func.coalesce(func.sum(models.Payment.amount), 0)
    ).join(models.Transaction).filter(
        models.Transaction.shift_id == shift.id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        func.lower(models.Payment.payment_method).like("%cash%")
    ).scalar() or Decimal("0.0")

    paid_in = db.query(
        func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
    ).filter(
        models.ShiftCashMovement.shift_id == shift.id,
        models.ShiftCashMovement.type == "PAID_IN"
    ).scalar() or Decimal("0.0")

    paid_out = db.query(
        func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
    ).filter(
        models.ShiftCashMovement.shift_id == shift.id,
        models.ShiftCashMovement.type == "PAID_OUT"
    ).scalar() or Decimal("0.0")

    current_expected = Decimal(str(shift.start_cash or 0)) + Decimal(str(cash_sales)) + Decimal(str(paid_in)) - Decimal(str(paid_out))

    non_cash_sales = db.query(
        func.coalesce(func.sum(models.Payment.amount), 0)
    ).join(models.Transaction).filter(
        models.Transaction.shift_id == shift.id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        ~func.lower(models.Payment.payment_method).like("%cash%")
    ).scalar() or Decimal("0.0")

    shift_total_sales = cash_sales + non_cash_sales
    cashier_overall_income = shift_total_sales + Decimal(str(shift.start_cash or 0)) + Decimal(str(paid_in))

    if amount <= Decimal("0.0"):
        amount = cashier_overall_income if cashier_overall_income > Decimal("0.0") else current_expected

    # 1. Log Cash Movement (PAID_OUT / Cashout)
    movement = models.ShiftCashMovement(
        tenant_id=tenant_id,
        shift_id=shift.id,
        user_id=current_user.id,
        type="PAID_OUT",
        amount=amount,
        reason=reason or "Manager Cashout"
    )
    db.add(movement)

    # 2. Close current shift
    shift.end_cash = max(Decimal("0.0"), current_expected - amount)
    shift.end_time = datetime.utcnow()
    shift.status = "closed"
    db.commit()

    # 3. Create a brand new active drawer/shift for the cashier reset to 0.00
    new_shift = models.Shift(
        tenant_id=tenant_id,
        user_id=shift.user_id,
        start_cash=Decimal("0.0"),
        status="open"
    )
    db.add(new_shift)
    db.commit()
    db.refresh(new_shift)

    from app.core.websocket import notify_realtime_event
    notify_realtime_event(tenant_id, "DRAWER_UPDATED", {"shift_id": new_shift.id, "balance": 0.0})
    notify_realtime_event(tenant_id, "CASHOUT_COMPLETED" if "admin" not in (reason or "").lower() else "TRANSFER_TO_ADMIN", {
        "shift_id": shift.id,
        "amount": float(amount),
        "reason": reason
    })
    notify_realtime_event(tenant_id, "FINANCIAL_UPDATED", {})

    return {
        "message": f"Successfully cashed out ₱{float(amount):.2f}. Cashier drawer reset to ₱0.00 with new active Shift #{new_shift.id}.",
        "cashed_out_shift_id": shift.id,
        "amount_cashed_out": float(amount),
        "new_shift_id": new_shift.id,
        "new_drawer_balance": 0.0
    }

@router.put("/{shift_id}/drawer-cash")
@router.post("/{shift_id}/drawer-cash")
def edit_shift_drawer_cash(
    shift_id: int,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Directly edit/adjust cashier drawer balance for a shift.
    Computes delta and records appropriate cash movement so expected cash matches the requested amount.
    """
    tenant_id = _get_user_tenant_id(db, current_user)
    
    shift = db.query(models.Shift).filter(
        models.Shift.id == shift_id,
        models.Shift.tenant_id == tenant_id
    ).first()
    
    if not shift:
        raise HTTPException(status_code=404, detail="Shift record not found.")

    if shift.status != "open":
        raise HTTPException(
            status_code=400,
            detail="Only active open cashier shifts can have their drawer cash edited. Closed shifts are locked."
        )

    try:
        new_amount = Decimal(str(body.get("amount", 0)))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid amount provided.")

    reason = body.get("reason") or "Cashier drawer edited by manager"

    from sqlalchemy import func
    cash_sales = db.query(
        func.coalesce(func.sum(models.Payment.amount), 0)
    ).join(models.Transaction).filter(
        models.Transaction.shift_id == shift.id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        func.lower(models.Payment.payment_method).like("%cash%")
    ).scalar() or Decimal("0.0")

    paid_in = db.query(
        func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
    ).filter(
        models.ShiftCashMovement.shift_id == shift.id,
        models.ShiftCashMovement.type == "PAID_IN"
    ).scalar() or Decimal("0.0")

    paid_out = db.query(
        func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
    ).filter(
        models.ShiftCashMovement.shift_id == shift.id,
        models.ShiftCashMovement.type == "PAID_OUT"
    ).scalar() or Decimal("0.0")

    current_expected = Decimal(str(shift.start_cash or 0)) + Decimal(str(cash_sales)) + Decimal(str(paid_in)) - Decimal(str(paid_out))
    delta = new_amount - current_expected

    if delta > Decimal("0.0"):
        movement = models.ShiftCashMovement(
            tenant_id=tenant_id,
            shift_id=shift.id,
            user_id=current_user.id,
            type="PAID_IN",
            amount=delta,
            reason=f"{reason} (Adjusted from ₱{float(current_expected):.2f} to ₱{float(new_amount):.2f})"
        )
        db.add(movement)
    elif delta < Decimal("0.0"):
        movement = models.ShiftCashMovement(
            tenant_id=tenant_id,
            shift_id=shift.id,
            user_id=current_user.id,
            type="PAID_OUT",
            amount=abs(delta),
            reason=f"{reason} (Adjusted from ₱{float(current_expected):.2f} to ₱{float(new_amount):.2f})"
        )
        db.add(movement)

    if shift.end_cash is not None:
        shift.end_cash = new_amount

    db.commit()

    from app.core.websocket import notify_realtime_event
    notify_realtime_event(tenant_id, "DRAWER_UPDATED", {"shift_id": shift.id, "new_amount": float(new_amount)})
    notify_realtime_event(tenant_id, "FINANCIAL_UPDATED", {})

    return {
        "success": True,
        "message": f"Successfully updated cashier drawer balance to ₱{float(new_amount):.2f}",
        "shift_id": shift.id,
        "previous_drawer_cash": float(current_expected),
        "new_drawer_cash": float(new_amount),
        "adjustment": float(delta)
    }

