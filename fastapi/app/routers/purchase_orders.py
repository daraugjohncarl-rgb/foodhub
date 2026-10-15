"""
Purchase orders (H6).

State machine:
    Draft -> Pending -> Ordered -> Partially Received -> Received
    Draft / Pending / Ordered / Partially Received -> Cancelled
Received and Partially Received are reached only through POST /purchase-orders/{id}/receive, which adds the stock
in the same database transaction. Receiving locks the purchase order and the inventory rows, so two simultaneous
"receive" clicks cannot add the stock twice.
"""
import logging
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core import audit
from app.core.dependencies import require_inventory_access, get_inventory_tenant_id
from app.core.timeutils import business_today, utcnow
from app.services import stock

logger = logging.getLogger("pos_purchase_orders")

router = APIRouter(tags=["Purchase Orders"])

S = models.PurchaseOrderStatus
OPEN_STATUSES = {S.DRAFT, S.PENDING, S.ORDERED, S.PARTIALLY_RECEIVED}
RECEIVABLE_STATUSES = {S.ORDERED, S.PARTIALLY_RECEIVED}
MANUAL_TRANSITIONS = {
    S.DRAFT: {S.PENDING, S.ORDERED, S.CANCELLED},
    S.PENDING: {S.ORDERED, S.CANCELLED},
    S.ORDERED: {S.CANCELLED},
    S.PARTIALLY_RECEIVED: {S.CANCELLED},
    S.RECEIVED: set(),
    S.CANCELLED: set(),
}


def _get_po(db: Session, tenant_id: int, po_id: int, lock: bool = False) -> models.PurchaseOrder:
    q = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.id == po_id,
        models.PurchaseOrder.tenant_id == tenant_id
    )
    if lock:
        q = q.with_for_update()
    po = q.first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase Order not found")
    return po


@router.get("/purchase-orders", response_model=List[schemas.PurchaseOrderResponse])
def get_purchase_orders(
    po_status: Optional[models.PurchaseOrderStatus] = Query(None, alias="status", description="Filter by status"),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    query = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.tenant_id == tenant_id)
    if po_status:
        query = query.filter(models.PurchaseOrder.status == po_status)
    return query.order_by(models.PurchaseOrder.created_at.desc()).all()


@router.get("/purchase-orders/{po_id}", response_model=schemas.PurchaseOrderResponse)
def get_purchase_order(
    po_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    return _get_po(db, tenant_id, po_id)


@router.post("/purchase-orders", response_model=schemas.PurchaseOrderResponse, status_code=status.HTTP_201_CREATED)
def create_purchase_order(
    body: schemas.PurchaseOrderCreate,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    supplier = db.query(models.Supplier).filter(
        models.Supplier.id == body.supplier_id,
        models.Supplier.tenant_id == tenant_id
    ).first()
    if not supplier:
        raise HTTPException(status_code=400, detail="Invalid supplier or supplier does not belong to your tenant.")
    if (supplier.status or "Active").lower() != "active":
        raise HTTPException(status_code=409, detail=f"Supplier '{supplier.supplier_name}' is inactive.")

    item_ids = [i.inventory_item_id for i in body.items]
    if len(item_ids) != len(set(item_ids)):
        raise HTTPException(status_code=422, detail="Each inventory item may appear only once per purchase order.")
    inventory = {
        i.id: i for i in db.query(models.InventoryItem).filter(
            models.InventoryItem.tenant_id == tenant_id, models.InventoryItem.id.in_(item_ids)
        )
    }

    subtotal = Decimal("0")
    po_items = []
    for item_in in body.items:
        inv_item = inventory.get(item_in.inventory_item_id)
        if inv_item is None or not inv_item.is_active:
            raise HTTPException(status_code=400, detail=f"Invalid inventory item ID {item_in.inventory_item_id}.")
        total_cost = (item_in.quantity * item_in.unit_cost).quantize(Decimal("0.01"))
        subtotal += total_cost
        po_items.append(models.PurchaseOrderItem(
            inventory_item_id=item_in.inventory_item_id,
            quantity_ordered=item_in.quantity,
            quantity_received=Decimal("0"),
            unit_cost=item_in.unit_cost,
            total_cost=total_cost,
        ))

    # PO numbers: lock the tenant row so concurrent creates in one branch are numbered one after another.
    db.query(models.Tenant).filter(models.Tenant.id == tenant_id).with_for_update().first()
    year = business_today().year
    last_po = db.query(models.PurchaseOrder.po_number).filter(
        models.PurchaseOrder.tenant_id == tenant_id,
        models.PurchaseOrder.po_number.like(f"PO-{year}-%")
    ).order_by(models.PurchaseOrder.id.desc()).first()
    try:
        new_num = int(last_po[0].split("-")[-1]) + 1 if last_po else 1
    except ValueError:
        new_num = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.tenant_id == tenant_id).count() + 1

    po = models.PurchaseOrder(
        tenant_id=tenant_id,
        po_number=f"PO-{year}-{new_num:04d}",
        supplier_id=body.supplier_id,
        expected_delivery_date=body.expected_delivery_date,
        status=S.DRAFT,
        subtotal=subtotal,
        total_amount=subtotal,
        notes=body.notes,
        created_by=current_user.id
    )
    po.items = po_items
    db.add(po)
    try:
        db.flush()
        audit.record(db, current_user, "PO Created", tenant_id=tenant_id,
                     details=f"{po.po_number} for {supplier.supplier_name}, total {subtotal:.2f}")
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Could not number the purchase order. Please retry.")
    db.refresh(po)
    return po


@router.put("/purchase-orders/{po_id}", response_model=schemas.PurchaseOrderResponse)
def update_purchase_order(
    po_id: int,
    body: schemas.PurchaseOrderUpdate,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    po = _get_po(db, tenant_id, po_id, lock=True)
    if po.status in (S.RECEIVED, S.CANCELLED):
        raise HTTPException(status_code=400, detail="Cannot update a received or cancelled purchase order.")

    if body.status is not None and body.status != po.status:
        if body.status in (S.RECEIVED, S.PARTIALLY_RECEIVED):
            raise HTTPException(
                status_code=409,
                detail="Use 'Receive' to mark a purchase order as received; it also adds the stock.",
            )
        if body.status not in MANUAL_TRANSITIONS[po.status]:
            raise HTTPException(status_code=409, detail=f"Cannot change a {po.status.value} order to {body.status.value}.")
        audit.record(db, current_user, "PO Status Changed", tenant_id=tenant_id,
                     details=f"{po.po_number}: {po.status.value} -> {body.status.value}")
        po.status = body.status

    if body.expected_delivery_date is not None:
        po.expected_delivery_date = body.expected_delivery_date
    if body.notes is not None:
        po.notes = body.notes

    db.commit()
    db.refresh(po)
    return po


@router.delete("/purchase-orders/{po_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_purchase_order(
    po_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    """Only Draft or Pending orders can be deleted; anything sent to a supplier must be cancelled instead."""
    po = _get_po(db, tenant_id, po_id, lock=True)
    if po.status not in (S.DRAFT, S.PENDING):
        raise HTTPException(status_code=409, detail=f"A {po.status.value} purchase order cannot be deleted; cancel it instead.")

    audit.record(db, current_user, "PO Deleted", tenant_id=tenant_id, details=po.po_number)
    db.delete(po)
    db.commit()
    return None


@router.post("/purchase-orders/{po_id}/receive", response_model=schemas.PurchaseOrderResponse)
def receive_purchase_order(
    po_id: int,
    body: Optional[schemas.PurchaseOrderReceive] = Body(None),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    """
    Receives an Ordered (or Partially Received) purchase order. Without a body everything still outstanding is
    received; with `lines` only those quantities are received (partial delivery). Stock, the received quantities,
    the stock ledger and the status are updated atomically.
    """
    po = _get_po(db, tenant_id, po_id, lock=True)
    if po.status == S.RECEIVED:
        raise HTTPException(status_code=400, detail="Purchase Order is already received.")
    if po.status == S.CANCELLED:
        raise HTTPException(status_code=400, detail="Cannot receive a cancelled purchase order.")
    if po.status not in RECEIVABLE_STATUSES:
        raise HTTPException(status_code=409, detail="Mark the purchase order as Ordered before receiving it.")

    lines = {line.id: line for line in po.items}
    if body and body.lines:
        requested = {}
        for line in body.lines:
            if line.item_id not in lines:
                raise HTTPException(status_code=404, detail=f"Line {line.item_id} is not part of {po.po_number}.")
            requested[line.item_id] = requested.get(line.item_id, Decimal("0")) + line.quantity
    else:
        requested = {
            line_id: Decimal(line.quantity_ordered) - Decimal(line.quantity_received or 0)
            for line_id, line in lines.items()
        }

    for line_id, qty in requested.items():
        outstanding = Decimal(lines[line_id].quantity_ordered) - Decimal(lines[line_id].quantity_received or 0)
        if qty > outstanding:
            raise HTTPException(status_code=422, detail=f"Line {line_id}: only {outstanding:.2f} still outstanding.")

    to_receive = {line_id: qty for line_id, qty in requested.items() if qty > 0}
    if not to_receive:
        raise HTTPException(status_code=400, detail="Nothing left to receive on this purchase order.")

    locked = stock.lock_items(db, tenant_id, [lines[line_id].inventory_item_id for line_id in to_receive])
    for line_id, qty in to_receive.items():
        line = lines[line_id]
        stock.apply_movement(
            db, locked[line.inventory_item_id], qty, models.StockMovementType.RECEIPT, user=current_user,
            reason=f"Received on {po.po_number}", reference_type="purchase_order", reference_id=po.id,
            unit_cost=line.unit_cost,
        )
        line.quantity_received = Decimal(line.quantity_received or 0) + qty

    fully_received = all(
        Decimal(line.quantity_received or 0) >= Decimal(line.quantity_ordered) for line in po.items
    )
    po.status = S.RECEIVED if fully_received else S.PARTIALLY_RECEIVED
    if fully_received:
        po.received_date = utcnow()
    audit.record(db, current_user, "PO Received", tenant_id=tenant_id,
                 details=f"{po.po_number}: {len(to_receive)} line(s) received, status {po.status.value}")
    db.commit()
    db.refresh(po)
    return po
