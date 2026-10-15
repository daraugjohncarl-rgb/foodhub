"""
Transactions & POS Router
=========================
POS checkout, payment processing, and transaction retrieval.

A sale is created in ONE database transaction: the sale row, its items, payments, recipe-based stock deductions,
the link to a customer QR order, and the audit entry are committed together or not at all (C7). Prices, tax and
totals are computed here; the client only sends product ids, quantities and how it paid.
"""
from collections import OrderedDict
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core import audit, config
from app.core.dependencies import require_permission, resolve_tenant_id
from app.core.permissions import has_permission
from app.core.timeutils import isoformat_utc
from app.services import stock

router = APIRouter(prefix="/transactions", tags=["POS — Transactions"])

CENT = Decimal("0.01")
TAX_RATE = Decimal(config.TAX_RATE)


def money(value) -> Optional[str]:
    """Exact decimal string ('125.50') for JSON; never a float."""
    if value is None:
        return None
    return str(Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP))


def serialize_transaction(tx: models.Transaction) -> dict:
    return {
        "id": tx.id,
        "client_tx_id": tx.client_tx_id,
        "tenant_id": tx.tenant_id,
        "shift_id": tx.shift_id,
        "user_id": tx.user_id,
        "cashier": tx.user.username if tx.user else "Staff",
        "total_amount": money(tx.total_amount),
        "tax_amount": money(tx.tax_amount),
        "discount_amount": money(tx.discount_amount),
        "net_amount": money(tx.net_amount),
        "amount_tendered": money(tx.amount_tendered),
        "change_amount": money(tx.change_amount),
        "status": tx.status,
        "fulfillment_status": tx.fulfillment_status,
        "order_type": tx.order_type,
        "table_number": tx.table_number,
        "customer_order_id": tx.customer_order_id,
        "created_at": isoformat_utc(tx.created_at),
        "items": [
            {
                "id": it.id,
                "product_id": it.product_id,
                "name": it.product.name if it.product else f"Item #{it.product_id}",
                "quantity": it.quantity,
                "unit_price": money(it.unit_price),
                "total_price": money(it.total_price),
            }
            for it in tx.items
        ],
        "payments": [
            {"id": p.id, "payment_method": p.payment_method, "amount": money(p.amount), "status": p.status}
            for p in tx.payments
        ],
    }


def _load_transaction(db: Session, tx_id: int) -> models.Transaction:
    return (
        db.query(models.Transaction)
        .options(
            joinedload(models.Transaction.items).joinedload(models.TransactionItem.product),
            joinedload(models.Transaction.payments),
            joinedload(models.Transaction.user),
        )
        .filter(models.Transaction.id == tx_id)
        .first()
    )


@router.get("", summary="List transactions for the user's tenant")
def list_transactions(
    response: Response,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to view"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("sales.read_own")),
):
    """
    Managers and admins see every sale of their branch; cashiers see only their own sales.
    The total number of matching sales is returned in the X-Total-Count header.
    """
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    q = db.query(models.Transaction).filter(models.Transaction.tenant_id == scope_tenant)
    if not has_permission(current_user.role, "sales.read_all"):
        q = q.filter(models.Transaction.user_id == current_user.id)

    response.headers["X-Total-Count"] = str(q.count())
    ids = [row.id for row in q.with_entities(models.Transaction.id)
           .order_by(models.Transaction.created_at.desc(), models.Transaction.id.desc())
           .offset(offset).limit(limit)]
    if not ids:
        return []
    rows = (
        db.query(models.Transaction)
        .options(
            joinedload(models.Transaction.items).joinedload(models.TransactionItem.product),
            joinedload(models.Transaction.payments),
            joinedload(models.Transaction.user),
        )
        .filter(models.Transaction.id.in_(ids))
        .all()
    )
    by_id = {tx.id: tx for tx in rows}
    return [serialize_transaction(by_id[i]) for i in ids]


def _same_sale(existing: models.Transaction, lines: "OrderedDict[int, int]") -> bool:
    existing_lines = sorted((it.product_id, it.quantity) for it in existing.items)
    return existing_lines == sorted(lines.items())


def _replay(db: Session, existing: models.Transaction, lines, response: Response) -> dict:
    if not _same_sale(existing, lines):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="client_tx_id was already used for a different sale.",
        )
    response.status_code = status.HTTP_200_OK
    payload = serialize_transaction(_load_transaction(db, existing.id))
    payload["message"] = "Transaction already recorded (idempotent retry)."
    payload["replayed"] = True
    return payload


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a new POS transaction")
def create_transaction(
    body: schemas.SaleCreate,
    response: Response,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("sales.create")),
):
    tenant_id = resolve_tenant_id(db, current_user, None)

    # Merge duplicate product lines (the same product scanned twice is one line).
    lines: "OrderedDict[int, int]" = OrderedDict()
    for item in body.items:
        lines[item.product_id] = lines.get(item.product_id, 0) + item.quantity
    if any(qty > config.POS_MAX_LINE_QUANTITY for qty in lines.values()):
        raise HTTPException(status_code=422, detail=f"Quantity per product is limited to {config.POS_MAX_LINE_QUANTITY}.")

    # Idempotent offline retries (C8): same tenant + client_tx_id returns the original sale.
    if body.client_tx_id:
        existing = db.query(models.Transaction).filter(
            models.Transaction.tenant_id == tenant_id,
            models.Transaction.client_tx_id == body.client_tx_id,
        ).first()
        if existing:
            return _replay(db, existing, lines, response)

    if body.discount_amount > 0 and not has_permission(current_user.role, "sales.discount"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Discounts require a manager or admin.")

    # An explicitly opened shift is required (M3).
    shift = (
        db.query(models.Shift)
        .filter(
            models.Shift.tenant_id == tenant_id,
            models.Shift.user_id == current_user.id,
            models.Shift.status == "open",
        )
        .order_by(models.Shift.id.desc())
        .first()
    )
    if shift is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No open shift. Start your shift (with your opening cash) before ringing up sales.",
            headers={"X-Shift-Required": "1"},
        )

    products = {
        p.id: p
        for p in db.query(models.Product).filter(
            models.Product.tenant_id == tenant_id, models.Product.id.in_(list(lines))
        )
    }
    subtotal = Decimal("0")
    tx_items = []
    for product_id, quantity in lines.items():
        product = products.get(product_id)
        if product is None:
            raise HTTPException(status_code=404, detail=f"Product ID {product_id} not found in this branch.")
        if not product.is_active:
            raise HTTPException(status_code=400, detail=f"Product '{product.name}' is currently unavailable.")
        unit_price = Decimal(product.price)
        line_total = (unit_price * quantity).quantize(CENT)
        subtotal += line_total
        tx_items.append(models.TransactionItem(
            product_id=product_id, quantity=quantity, unit_price=unit_price, total_price=line_total,
        ))

    discount = Decimal(body.discount_amount).quantize(CENT)
    if discount > subtotal:
        raise HTTPException(status_code=422, detail="Discount cannot exceed the order subtotal.")
    tax = ((subtotal - discount) * TAX_RATE).quantize(CENT, rounding=ROUND_HALF_UP)
    net = subtotal - discount + tax

    # Payment policy: the amount due must be fully covered; only cash may exceed it (the excess is change).
    if body.payments:
        cash = sum((p.amount for p in body.payments if p.payment_method == "CASH"), Decimal("0"))
        non_cash = sum((p.amount for p in body.payments if p.payment_method != "CASH"), Decimal("0"))
        tendered = cash + non_cash
        if non_cash > net:
            raise HTTPException(status_code=422, detail="Card/e-wallet payments cannot exceed the amount due.")
        if tendered < net:
            raise HTTPException(status_code=422, detail=f"Payment of {money(tendered)} is less than the amount due {money(net)}.")
        change = tendered - net
        payment_rows = []
        remaining_cash_due = net - non_cash
        for p in body.payments:
            applied = p.amount if p.payment_method != "CASH" else min(p.amount, max(remaining_cash_due, Decimal("0")))
            if p.payment_method == "CASH":
                remaining_cash_due -= applied
            if applied > 0:
                payment_rows.append(models.Payment(payment_method=p.payment_method, amount=applied, status="completed"))
    else:
        tendered = body.amount_tendered if body.amount_tendered is not None else net
        if body.payment_method == "CASH":
            if tendered < net:
                raise HTTPException(status_code=422, detail=f"Amount tendered {money(tendered)} is less than the amount due {money(net)}.")
        elif tendered != net:
            raise HTTPException(status_code=422, detail="Card/e-wallet payments must equal the amount due.")
        change = tendered - net
        payment_rows = [models.Payment(payment_method=body.payment_method, amount=net, status="completed")] if net > 0 else []

    # Customer QR order being rung up (M9): must belong to this branch and still be open.
    customer_order = None
    if body.customer_order_id:
        customer_order = (
            db.query(models.CustomerOrder)
            .filter(models.CustomerOrder.id == body.customer_order_id, models.CustomerOrder.tenant_id == tenant_id)
            .with_for_update()
            .first()
        )
        if customer_order is None:
            raise HTTPException(status_code=404, detail="Customer order not found.")
        if customer_order.status not in (models.CustomerOrderStatus.PENDING.value, models.CustomerOrderStatus.ACCEPTED.value):
            raise HTTPException(status_code=409, detail=f"Customer order is already {customer_order.status}.")

    tx = models.Transaction(
        tenant_id=tenant_id,
        shift_id=shift.id,
        user_id=current_user.id,
        client_tx_id=body.client_tx_id,
        total_amount=subtotal,
        tax_amount=tax,
        discount_amount=discount,
        net_amount=net,
        amount_tendered=tendered,
        change_amount=change,
        status=models.TransactionStatus.COMPLETED.value,
        fulfillment_status=models.FulfillmentStatus.PENDING.value,
        order_type=body.order_type or (customer_order.order_type if customer_order else None),
        table_number=body.table_number or (customer_order.table_number if customer_order else None),
        customer_order_id=customer_order.id if customer_order else None,
    )
    tx.items = tx_items
    tx.payments = payment_rows
    db.add(tx)

    try:
        db.flush()  # assigns tx.id; a concurrent duplicate client_tx_id fails here
        # Recipe-based ingredient deduction (M4). Products without a recipe deduct nothing.
        needs = stock.recipe_requirements(db, dict(lines))
        if needs:
            locked = stock.lock_items(db, tenant_id, needs.keys())
            for item_id in sorted(needs):
                stock.apply_movement(
                    db, locked[item_id], -needs[item_id], models.StockMovementType.SALE, user=current_user,
                    reason=f"Sale #{tx.id}", reference_type="transaction", reference_id=tx.id,
                )
        if customer_order is not None:
            customer_order.status = models.CustomerOrderStatus.COMPLETED.value
        audit.record(db, current_user, "POS Sale", tenant_id=tenant_id,
                     details=f"Transaction #{tx.id} processed for PHP {money(net)}")
        db.commit()
    except IntegrityError:
        db.rollback()
        if body.client_tx_id:
            existing = db.query(models.Transaction).filter(
                models.Transaction.tenant_id == tenant_id,
                models.Transaction.client_tx_id == body.client_tx_id,
            ).first()
            if existing:
                return _replay(db, existing, lines, response)
        raise
    except HTTPException:
        db.rollback()
        raise

    payload = serialize_transaction(_load_transaction(db, tx.id))
    payload["message"] = "Transaction created successfully."
    return payload
