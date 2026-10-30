from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Optional
from decimal import Decimal
from datetime import datetime

from app.db import get_db
import app.models as models
from app.services.payments import cash_method_clause, is_cash_method
import app.schemas as schemas
from app.core.dependencies import require_pos_access, resolve_tenant_id

router = APIRouter(prefix="/shifts", tags=["Shifts"])

def _get_user_tenant_id(db: Session, current_user: models.User) -> int:
    return resolve_tenant_id(current_user, db)


# Roles with cross-cashier drawer oversight (same set as require_manager_or_admin).
DRAWER_MANAGER_ROLES = {models.UserRole.MANAGER, models.UserRole.ADMIN, models.UserRole.SUPER_ADMIN}


def _is_drawer_manager(user: models.User) -> bool:
    return user.role in DRAWER_MANAGER_ROLES

@router.get("/active", response_model=Optional[schemas.ShiftResponse])
def get_active_shift(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access)
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
    current_user: models.User = Depends(require_pos_access)
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
    current_user: models.User = Depends(require_pos_access)
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
    current_user: models.User = Depends(require_pos_access)
):
    """
    Cash-in-drawer tracker: expected cash (Float + Cash Sales + Paid In - Paid Out) per shift.

    * MANAGER / ADMIN / SUPER_ADMIN: every cashier shift of their tenant (the Cash Drawer screen).
    * CASHIER: only their OWN shifts and their own sales totals (the POS "Cash in Drawer" header);
      never another cashier's float, sales or balance.

    Read-only: this GET never opens, closes or changes a shift. With no open shift it returns
    `has_open_shift: false`; shifts are opened by a sale (AUTO_OPEN_SHIFT) or POST /shifts/start.
    """
    from sqlalchemy import func, case
    from sqlalchemy.orm import joinedload, selectinload
    tenant_id = _get_user_tenant_id(db, current_user)
    is_manager = _is_drawer_manager(current_user)

    # Fetch shifts for this tenant (open shifts first) with eager loading
    shift_query = db.query(models.Shift).options(
        joinedload(models.Shift.user),
        selectinload(models.Shift.shift_cash_movements).joinedload(models.ShiftCashMovement.user)
    ).join(models.User).filter(
        models.Shift.tenant_id == tenant_id
    )
    if is_manager:
        shift_query = shift_query.filter(models.User.role == models.UserRole.CASHIER)
    else:
        shift_query = shift_query.filter(models.Shift.user_id == current_user.id)
    shifts = shift_query.order_by(
        (models.Shift.status == "open").desc(),
        models.Shift.id.desc()
    ).limit(30).all()

    has_open_shift = any(s.status == "open" for s in shifts)
    if not has_open_shift:
        cashier_q = db.query(models.User).filter(
            models.User.tenant_id == tenant_id,
            models.User.role == models.UserRole.CASHIER,
            models.User.is_active == True
        )
        if not is_manager:
            cashier_q = cashier_q.filter(models.User.id == current_user.id)
        cashier_user = cashier_q.order_by(models.User.id.asc()).first()
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
            has_open_shift = True
    # Sales totals below are tenant-wide for managers and the caller's own sales for a cashier.
    own_sales = [] if is_manager else [models.Transaction.user_id == current_user.id]

    drawer_list = []
    total_cash_in_active_drawers = Decimal("0.0")
    active_drawers_count = 0
    today_total_cash_sales = Decimal("0.0")
    today_total_orders_amount = Decimal("0.0")

    # High-performance batch aggregation for all shifts in a single query
    shift_ids = [s.id for s in shifts]
    cash_sales_map = {}
    non_cash_map = {}
    paid_in_map = {}
    paid_out_map = {}
    refund_pending_map = {}

    if shift_ids:
        # 1. Batch cash vs non-cash sales
        pmt_rows = db.query(
            models.Transaction.shift_id,
            func.coalesce(func.sum(case((cash_method_clause(models.Payment.payment_method), models.Payment.amount), else_=0)), 0).label("cash_sales"),
            func.coalesce(func.sum(case((~cash_method_clause(models.Payment.payment_method), models.Payment.amount), else_=0)), 0).label("non_cash_sales")
        ).join(models.Payment, models.Payment.transaction_id == models.Transaction.id).filter(
            models.Transaction.shift_id.in_(shift_ids),
            models.Payment.status == "completed",
            models.Transaction.status == "completed"
        ).group_by(models.Transaction.shift_id).all()

        for r in pmt_rows:
            cash_sales_map[r[0]] = Decimal(str(r[1] or 0))
            non_cash_map[r[0]] = Decimal(str(r[2] or 0))

        # Cash of voided sales whose refund has not been recorded yet. It is NOT in expected_cash (the sale
        # was voided), so until the money is handed back the drawer will count this much over.
        for sid, amt in db.query(
            models.Transaction.shift_id, func.coalesce(func.sum(models.Payment.amount), 0)
        ).join(models.Payment, models.Payment.transaction_id == models.Transaction.id).filter(
            models.Transaction.shift_id.in_(shift_ids),
            models.Transaction.refund_status == "pending",
            cash_method_clause(models.Payment.payment_method)
        ).group_by(models.Transaction.shift_id).all():
            refund_pending_map[sid] = Decimal(str(amt or 0))

        # 2. Batch movements grouped by shift_id and type
        mov_rows = db.query(
            models.ShiftCashMovement.shift_id,
            models.ShiftCashMovement.type,
            func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
        ).filter(
            models.ShiftCashMovement.shift_id.in_(shift_ids)
        ).group_by(models.ShiftCashMovement.shift_id, models.ShiftCashMovement.type).all()

        for sid, mtype, msum in mov_rows:
            if mtype == "PAID_IN":
                paid_in_map[sid] = Decimal(str(msum or 0))
            elif mtype == "PAID_OUT":
                paid_out_map[sid] = Decimal(str(msum or 0))

    for s in shifts:
        cash_sales_val = cash_sales_map.get(s.id, Decimal("0.0"))
        non_cash_val = non_cash_map.get(s.id, Decimal("0.0"))
        paid_in_val = paid_in_map.get(s.id, Decimal("0.0"))
        paid_out_val = paid_out_map.get(s.id, Decimal("0.0"))

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
            "expected_cash": float(expected_cash),   # read by the POS / drawer screens; was never returned
            "voided_cash_refund_pending": float(refund_pending_map.get(s.id, Decimal("0.0"))),
            "cash_sales": float(cash_sales_val),
            "non_cash_sales": float(non_cash_val),
            "total_sales": float(shift_total_sales),
            "paid_in": float(paid_in_val),
            "paid_out": float(paid_out_val),
            "cashed_out": float(paid_out_val),
            "cashier_overall_income": float(shift_total_sales),
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
        *own_sales,
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
        *own_sales,
        models.Transaction.tenant_id == tenant_id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        cash_method_clause(models.Payment.payment_method),
        models.Transaction.created_at >= start_of_day,
        models.Transaction.created_at <= end_of_day
    ).scalar() or Decimal("0.0")

    today_cash_val = Decimal(str(all_today_cash))
    if today_cash_val == Decimal("0.0"):
        today_cash_val = today_total_cash_sales

    all_time_income = db.query(
        func.coalesce(func.sum(models.Transaction.net_amount), 0)
    ).filter(
        *own_sales,
        models.Transaction.tenant_id == tenant_id,
        models.Transaction.status == "completed"
    ).scalar() or Decimal("0.0")

    # Overall Income is total sales revenue from completed orders (net sales).
    # Cash in drawer is a physical cash asset; separating them prevents double-counting.
    overall_income_val = Decimal(str(all_time_income))

    # Authoritative manager safe balance from cashier cashouts minus admin remittances (single lightweight column query)
    mov_records = db.query(
        models.ShiftCashMovement.type,
        models.ShiftCashMovement.amount,
        models.ShiftCashMovement.reason
    ).filter(
        models.ShiftCashMovement.tenant_id == tenant_id
    ).all()

    admin_transfers_sum = Decimal("0.00")
    admin_reversals_sum = Decimal("0.00")
    cashier_cashouts_sum = Decimal("0.00")

    for m_type, m_amt, m_reason in mov_records:
        r_low = (m_reason or '').lower()
        amt_dec = Decimal(str(m_amt or 0))
        if m_type == "PAID_OUT":
            if 'admin' in r_low and not any(k in r_low for k in ['cancel', 'revers', 'void', 'reject']):
                admin_transfers_sum += amt_dec
            elif (
                'admin' not in r_low
                and not any(term in r_low for term in ['drawer edited', 'modal', 'adjustment', 'shortage', 'overage'])
                and not any(term in r_low for term in ['cancel', 'revers', 'void', 'reject'])
            ):
                cashier_cashouts_sum += amt_dec
        elif m_type == "PAID_IN":
            if 'admin' in r_low and any(k in r_low for k in ['revers', 'return', 'refund', 'cancel']):
                admin_reversals_sum += amt_dec

    total_transferred_to_admin = max(Decimal("0.00"), admin_transfers_sum - admin_reversals_sum)
    manager_safe_cash = max(Decimal("0.00"), cashier_cashouts_sum - total_transferred_to_admin)

    return {
        "total_cash_in_drawers": float(total_cash_in_active_drawers),
        "active_drawers_count": active_drawers_count,
        "today_total_cash_sales": float(today_cash_val),
        "today_total_orders_amount": float(today_orders_val),
        "overall_income": float(overall_income_val),
        "orders_overall_income": float(all_time_income),
        "manager_safe_cash": float(manager_safe_cash),
        "manager_income": float(manager_safe_cash),
        "total_cashout_income": float(cashier_cashouts_sum),
        "admin_transfer_income": float(total_transferred_to_admin),
        "has_open_shift": has_open_shift,
        "scope": "tenant_cashiers" if is_manager else "own",
        "shifts": drawer_list
    }

@router.post("/cash-movement", response_model=schemas.ShiftCashMovementResponse)
def add_cash_movement(
    body: schemas.ShiftCashMovementCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access)
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
    body: schemas.ShiftCashoutRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access)
):
    """
    Manager/Admin cashout of overall cashier money income:
    1. Records cash drop / paid out of the specified amount.
    2. Resets the drawer to zero by closing the shift and creating a new fresh open drawer at ₱0.00.
    """
    tenant_id = _get_user_tenant_id(db, current_user)
    role_val = current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role)
    is_admin_or_mgr = role_val.upper() in ["ADMIN", "MANAGER", "SUPER_ADMIN"]

    shift_id = body.shift_id
    if shift_id in ("", None):
        shift_id = None
    else:
        if isinstance(shift_id, bool):
            raise HTTPException(status_code=400, detail="Invalid shift_id.")
        try:
            shift_id = int(shift_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid shift_id.")
    # Validated by the schema (finite, >= 0, 2 decimal places); omitted or null still means 0 = cash out everything.
    amount = body.amount if body.amount is not None else Decimal("0.0")

    reason = body.reason if "reason" in body.model_fields_set else "Manager Cashout"

    # Resolve the shift explicitly. Nothing is created here, and every refusal happens before any write.
    # A cashier may only cash out their OWN open drawer (previous rule for requests without shift_id);
    # managers/admins may cash out any open drawer of their tenant.
    if shift_id is not None:
        shift = db.query(models.Shift).filter(
            models.Shift.id == shift_id,
            models.Shift.tenant_id == tenant_id
        ).with_for_update().first()
        if not shift:
            raise HTTPException(status_code=404, detail="Shift not found.")
        if not is_admin_or_mgr and shift.user_id != current_user.id:
            raise HTTPException(status_code=403, detail="You can only cash out your own drawer.")
        if shift.status != "open":
            raise HTTPException(status_code=409, detail="This shift is already closed.")
    else:
        query = db.query(models.Shift).join(models.User).filter(
            models.Shift.tenant_id == tenant_id,
            models.Shift.status == "open"
        )
        if is_admin_or_mgr:
            query = query.filter(models.User.role == models.UserRole.CASHIER)
        else:
            query = query.filter(models.Shift.user_id == current_user.id)
        shift = query.order_by(models.Shift.id.desc()).with_for_update(of=models.Shift).first()
        if not shift:
            raise HTTPException(status_code=404, detail="No open cashier drawer to cash out.")

    from sqlalchemy import func
    cash_sales = db.query(
        func.coalesce(func.sum(models.Payment.amount), 0)
    ).join(models.Transaction).filter(
        models.Transaction.shift_id == shift.id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        cash_method_clause(models.Payment.payment_method)
    ).scalar() or Decimal("0.0")

    paid_in = Decimal("0.0")
    paid_out = Decimal("0.0")
    for mtype, msum in db.query(
        models.ShiftCashMovement.type,
        func.coalesce(func.sum(models.ShiftCashMovement.amount), 0)
    ).filter(
        models.ShiftCashMovement.shift_id == shift.id
    ).group_by(models.ShiftCashMovement.type).all():
        if mtype == "PAID_IN":
            paid_in = Decimal(str(msum or 0))
        elif mtype == "PAID_OUT":
            paid_out = Decimal(str(msum or 0))

    current_expected = Decimal(str(shift.start_cash or 0)) + Decimal(str(cash_sales)) + paid_in - paid_out

    if amount <= Decimal("0.0"):
        amount = current_expected if current_expected > Decimal("0.0") else Decimal("0.0")

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

    # 3. Create a brand new active drawer/shift for the cashier reset to 0.00
    new_shift = models.Shift(
        tenant_id=tenant_id,
        user_id=shift.user_id,
        start_cash=Decimal("0.0"),
        status="open"
    )
    db.add(new_shift)
    # Movement, closed shift and replacement shift are one commit: a failure leaves none of them behind.
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(new_shift)

    from app.core.websocket import notify_realtime_event
    notify_realtime_event(tenant_id, "DRAWER_UPDATED", {"shift_id": new_shift.id, "balance": 0.0})
    notify_realtime_event(tenant_id, "CASHOUT_COMPLETED" if "admin" not in (reason or "").lower() else "TRANSFER_TO_ADMIN", {
        "shift_id": shift.id,
        "amount": float(amount),
        "reason": reason
    })
    notify_realtime_event(tenant_id, "FINANCIAL_UPDATED", {})

    is_to_admin = "admin" in (reason or "").lower()
    dest_name = "Admin Safe" if is_to_admin else "Manager Income Safe"
    return {
        "message": f"Successfully transferred ₱{float(amount):.2f} to {dest_name}. Cashier drawer reset to ₱0.00 with new active Shift #{new_shift.id}.",
        "cashed_out_shift_id": shift.id,
        "amount_cashed_out": float(amount),
        "new_shift_id": new_shift.id,
        "new_drawer_balance": 0.0
    }

@router.put("/{shift_id}/drawer-cash")
@router.post("/{shift_id}/drawer-cash")
def edit_shift_drawer_cash(
    shift_id: int,
    body: schemas.ShiftDrawerCashRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access)
):
    """
    Directly edit/adjust cashier drawer balance for a shift (MANAGER / ADMIN / SUPER_ADMIN only).
    Computes delta and records appropriate cash movement so expected cash matches the requested amount.
    """
    if not _is_drawer_manager(current_user):
        # Checked before any read or write: a cashier can never adjust a drawer, their own or another's.
        raise HTTPException(status_code=403, detail="Only a manager or admin can edit a cashier drawer.")
    tenant_id = _get_user_tenant_id(db, current_user)
    
    # Locked like cashout_shift, so an edit and a cash-out of the same shift run one after the other and
    # the open-status check below sees the result of a cash-out that committed first.
    shift = db.query(models.Shift).filter(
        models.Shift.id == shift_id,
        models.Shift.tenant_id == tenant_id
    ).with_for_update().first()

    if not shift:
        raise HTTPException(status_code=404, detail="Shift record not found.")

    if shift.status != "open":
        raise HTTPException(
            status_code=400,
            detail="Only active open cashier shifts can have their drawer cash edited. Closed shifts are locked."
        )

    new_amount = body.amount  # validated by the schema: finite, >= 0, 2 decimal places

    reason = body.reason or "Cashier drawer edited by manager"

    from sqlalchemy import func
    cash_sales = db.query(
        func.coalesce(func.sum(models.Payment.amount), 0)
    ).join(models.Transaction).filter(
        models.Transaction.shift_id == shift.id,
        models.Payment.status == "completed",
        ~models.Transaction.status.in_(["cancelled", "rejected"]),
        cash_method_clause(models.Payment.payment_method)
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
    # ShiftCashMovement.reason is String(255): shorten the manager's text, never the adjustment note.
    note = f" (Adjusted from ₱{float(current_expected):.2f} to ₱{float(new_amount):.2f})"
    adjustment_reason = reason[:255 - len(note)] + note

    if delta > Decimal("0.0"):
        movement = models.ShiftCashMovement(
            tenant_id=tenant_id,
            shift_id=shift.id,
            user_id=current_user.id,
            type="PAID_IN",
            amount=delta,
            reason=adjustment_reason
        )
        db.add(movement)
    elif delta < Decimal("0.0"):
        movement = models.ShiftCashMovement(
            tenant_id=tenant_id,
            shift_id=shift.id,
            user_id=current_user.id,
            type="PAID_OUT",
            amount=abs(delta),
            reason=adjustment_reason
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


@router.post("/assign-cashier")
def assign_cashier_to_drawer(
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_pos_access)
):
    """
    Assign or switch a Cashier account in the Cash Drawer (Manager / Admin).
    If shift_id is provided, reassigns that open shift to the chosen cashier account;
    otherwise ensures an open shift exists for the chosen cashier account.
    """
    if not _is_drawer_manager(current_user):
        raise HTTPException(status_code=403, detail="Only a manager or admin can assign a cashier account to the cash drawer.")
    tenant_id = _get_user_tenant_id(db, current_user)

    user_id = body.get("user_id")
    shift_id = body.get("shift_id")
    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Please select a valid cashier account.")

    cashier_user = db.query(models.User).filter(
        models.User.id == user_id,
        models.User.tenant_id == tenant_id,
        models.User.role == models.UserRole.CASHIER
    ).first()
    if not cashier_user:
        raise HTTPException(status_code=404, detail="Cashier account not found in this branch.")

    target_shift = None
    if shift_id:
        try:
            sid = int(shift_id)
            target_shift = db.query(models.Shift).filter(
                models.Shift.id == sid,
                models.Shift.tenant_id == tenant_id,
                models.Shift.status == "open"
            ).first()
        except (TypeError, ValueError):
            target_shift = None

    if target_shift:
        target_shift.user_id = cashier_user.id
        db.commit()
        db.refresh(target_shift)
    else:
        existing_open = db.query(models.Shift).filter(
            models.Shift.tenant_id == tenant_id,
            models.Shift.user_id == cashier_user.id,
            models.Shift.status == "open"
        ).first()
        if existing_open:
            target_shift = existing_open
        else:
            target_shift = models.Shift(
                tenant_id=tenant_id,
                user_id=cashier_user.id,
                start_cash=Decimal("0.0"),
                status="open"
            )
            db.add(target_shift)
            db.commit()
            db.refresh(target_shift)

    from app.core.websocket import notify_realtime_event
    notify_realtime_event(tenant_id, "DRAWER_UPDATED", {"shift_id": target_shift.id, "user_id": cashier_user.id})

    c_name = f"{cashier_user.first_name or ''} {cashier_user.last_name or ''}".strip() or cashier_user.username
    return {
        "success": True,
        "message": f"Assigned cashier account @{cashier_user.username} ({c_name}) to Cash Drawer Shift #{target_shift.id}.",
        "shift_id": target_shift.id,
        "cashier_id": cashier_user.id,
        "cashier_username": cashier_user.username,
        "cashier_name": c_name
    }


