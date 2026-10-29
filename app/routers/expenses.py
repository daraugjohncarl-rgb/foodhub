"""
Operating Expenses Router
=========================
Handles business expense tracking (Rent, Utilities, Salaries, Supplies, Maintenance, etc.).
Allows Admin and Manager to record, approve, void, and review operational business expenses.
Separates operating expenses from inventory purchase receipts and internal cash transfers.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from datetime import datetime, time, timedelta
from decimal import Decimal

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import require_manager_or_admin, resolve_tenant_id

router = APIRouter(prefix="/expenses", tags=["Operating Expenses"])


def _require_admin_or_manager(current_user: models.User) -> None:
    role_str = str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role).upper()
    if role_str not in ["ADMIN", "MANAGER", "SUPER_ADMIN"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access restricted to Admin or Manager only."
        )


def _get_tenant_id(db: Session, current_user: models.User) -> int:
    return resolve_tenant_id(current_user, db)


@router.get("", response_model=List[schemas.ExpenseResponse], summary="List operational business expenses")
def list_expenses(
    period: Optional[str] = Query(None, description="today, yesterday, this_week, this_month, this_year, all, custom"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    _require_admin_or_manager(current_user)
    tenant_id = _get_tenant_id(db, current_user)

    q = db.query(models.Expense).options(
        joinedload(models.Expense.user)
    ).filter(models.Expense.tenant_id == tenant_id)

    if category:
        q = q.filter(models.Expense.category.ilike(f"%{category.strip()}%"))

    if status_filter:
        q = q.filter(models.Expense.status == status_filter.strip().lower())

    # Date range filters using half-open intervals
    now = datetime.now()
    today = now.date()

    if period == "today":
        start_dt = datetime.combine(today, time.min)
        end_dt = start_dt + timedelta(days=1)
        q = q.filter(models.Expense.expense_date >= start_dt, models.Expense.expense_date < end_dt)
    elif period == "yesterday":
        start_dt = datetime.combine(today - timedelta(days=1), time.min)
        end_dt = datetime.combine(today, time.min)
        q = q.filter(models.Expense.expense_date >= start_dt, models.Expense.expense_date < end_dt)
    elif period == "this_week":
        start_week = today - timedelta(days=today.weekday())
        start_dt = datetime.combine(start_week, time.min)
        end_dt = datetime.combine(today + timedelta(days=1), time.min)
        q = q.filter(models.Expense.expense_date >= start_dt, models.Expense.expense_date < end_dt)
    elif period == "this_month":
        start_dt = datetime(today.year, today.month, 1, 0, 0, 0)
        next_month = today.month + 1 if today.month < 12 else 1
        next_year = today.year if today.month < 12 else today.year + 1
        end_dt = datetime(next_year, next_month, 1, 0, 0, 0)
        q = q.filter(models.Expense.expense_date >= start_dt, models.Expense.expense_date < end_dt)
    elif period == "this_year":
        start_dt = datetime(today.year, 1, 1, 0, 0, 0)
        end_dt = datetime(today.year + 1, 1, 1, 0, 0, 0)
        q = q.filter(models.Expense.expense_date >= start_dt, models.Expense.expense_date < end_dt)
    elif start_date:
        try:
            s_dt = datetime.fromisoformat(start_date.strip().replace("Z", "+00:00")).replace(tzinfo=None)
            if end_date:
                e_dt = datetime.fromisoformat(end_date.strip().replace("Z", "+00:00")).replace(tzinfo=None)
                # If only date provided, include through end of day
                if e_dt.time() == time.min:
                    e_dt = e_dt + timedelta(days=1)
            else:
                e_dt = s_dt + timedelta(days=1)
            q = q.filter(models.Expense.expense_date >= s_dt, models.Expense.expense_date < e_dt)
        except Exception:
            pass

    expenses = q.order_by(models.Expense.expense_date.desc(), models.Expense.id.desc()).offset(offset).limit(limit).all()

    result = []
    for exp in expenses:
        result.append(schemas.ExpenseResponse(
            id=exp.id,
            tenant_id=exp.tenant_id,
            category=exp.category,
            description=exp.description,
            amount=float(exp.amount),
            payment_method=exp.payment_method,
            status=exp.status,
            reference_no=exp.reference_no,
            expense_date=exp.expense_date,
            recorded_by=exp.recorded_by,
            recorded_by_username=exp.user.username if exp.user else None,
            created_at=exp.created_at
        ))
    return result


@router.post("", response_model=schemas.ExpenseResponse, status_code=status.HTTP_201_CREATED, summary="Record a business expense")
def create_expense(
    body: schemas.ExpenseCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    _require_admin_or_manager(current_user)
    tenant_id = _get_tenant_id(db, current_user)

    expense_date = body.expense_date or datetime.now()

    exp = models.Expense(
        tenant_id=tenant_id,
        category=body.category.strip(),
        description=body.description.strip(),
        amount=body.amount,
        payment_method=body.payment_method.strip(),
        status=body.status,
        reference_no=body.reference_no.strip() if body.reference_no else None,
        expense_date=expense_date,
        recorded_by=current_user.id
    )
    db.add(exp)
    db.commit()
    db.refresh(exp)

    # Activity log
    try:
        log = models.ActivityLog(
            tenant_id=tenant_id,
            user_id=current_user.id,
            action="Expense Recorded",
            performed_by=current_user.username,
            role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
            details=f"Expense #{exp.id} [{exp.category}] recorded for ₱{float(exp.amount):,.2f}: {exp.description}"
        )
        db.add(log)
        db.commit()
    except Exception:
        pass

    return schemas.ExpenseResponse(
        id=exp.id,
        tenant_id=exp.tenant_id,
        category=exp.category,
        description=exp.description,
        amount=float(exp.amount),
        payment_method=exp.payment_method,
        status=exp.status,
        reference_no=exp.reference_no,
        expense_date=exp.expense_date,
        recorded_by=exp.recorded_by,
        recorded_by_username=current_user.username,
        created_at=exp.created_at
    )


@router.put("/{expense_id}", response_model=schemas.ExpenseResponse, summary="Update expense record")
def update_expense(
    expense_id: int,
    body: schemas.ExpenseUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    _require_admin_or_manager(current_user)
    tenant_id = _get_tenant_id(db, current_user)

    exp = db.query(models.Expense).filter(
        models.Expense.id == expense_id,
        models.Expense.tenant_id == tenant_id
    ).first()

    if not exp:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Expense not found.")

    if body.category is not None:
        exp.category = body.category.strip()
    if body.description is not None:
        exp.description = body.description.strip()
    if body.amount is not None:
        exp.amount = body.amount
    if body.payment_method is not None:
        exp.payment_method = body.payment_method.strip()
    if body.status is not None:
        exp.status = body.status
    if body.reference_no is not None:
        exp.reference_no = body.reference_no.strip() or None
    if body.expense_date is not None:
        exp.expense_date = body.expense_date

    db.commit()
    db.refresh(exp)

    return schemas.ExpenseResponse(
        id=exp.id,
        tenant_id=exp.tenant_id,
        category=exp.category,
        description=exp.description,
        amount=float(exp.amount),
        payment_method=exp.payment_method,
        status=exp.status,
        reference_no=exp.reference_no,
        expense_date=exp.expense_date,
        recorded_by=exp.recorded_by,
        recorded_by_username=exp.user.username if exp.user else None,
        created_at=exp.created_at
    )


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete or void expense")
def delete_expense(
    expense_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
):
    _require_admin_or_manager(current_user)
    tenant_id = _get_tenant_id(db, current_user)

    exp = db.query(models.Expense).filter(
        models.Expense.id == expense_id,
        models.Expense.tenant_id == tenant_id
    ).first()

    if not exp:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Expense not found.")

    db.delete(exp)
    db.commit()
    return None
