from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List, Optional
from datetime import datetime
from decimal import Decimal

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import require_inventory_access, get_inventory_tenant_id

router = APIRouter(tags=["Purchase Orders"])

@router.get("/purchase-orders", response_model=List[schemas.PurchaseOrderResponse])
def get_purchase_orders(
    status: Optional[models.PurchaseOrderStatus] = Query(None, description="Filter by status"),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    query = db.query(models.PurchaseOrder).filter(models.PurchaseOrder.tenant_id == tenant_id)
    if status:
        query = query.filter(models.PurchaseOrder.status == status)
    
    return query.order_by(models.PurchaseOrder.created_at.desc()).all()

@router.get("/purchase-orders/{po_id}", response_model=schemas.PurchaseOrderResponse)
def get_purchase_order(
    po_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    po = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.id == po_id,
        models.PurchaseOrder.tenant_id == tenant_id
    ).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase Order not found")
    return po

@router.post("/purchase-orders", response_model=schemas.PurchaseOrderResponse, status_code=status.HTTP_201_CREATED)
def create_purchase_order(
    body: schemas.PurchaseOrderCreate,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    # Verify supplier
    supplier = db.query(models.Supplier).filter(
        models.Supplier.id == body.supplier_id,
        models.Supplier.tenant_id == tenant_id
    ).first()
    if not supplier:
        raise HTTPException(status_code=400, detail="Invalid supplier or supplier does not belong to your tenant.")

    # Generate PO Number
    year = datetime.now().year
    last_po = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.tenant_id == tenant_id,
        models.PurchaseOrder.po_number.like(f"PO-{year}-%")
    ).order_by(models.PurchaseOrder.id.desc()).first()

    if last_po:
        try:
            last_num = int(last_po.po_number.split("-")[-1])
            new_num = last_num + 1
        except ValueError:
            new_num = 1
    else:
        new_num = 1
    
    po_number = f"PO-{year}-{new_num:04d}"

    # Calculate Totals and Validate Items
    subtotal = Decimal("0.0")
    po_items = []
    
    for item_in in body.items:
        # Verify inventory item
        inv_item = db.query(models.InventoryItem).filter(
            models.InventoryItem.id == item_in.inventory_item_id,
            models.InventoryItem.tenant_id == tenant_id
        ).first()
        if not inv_item:
            raise HTTPException(status_code=400, detail=f"Invalid inventory item ID {item_in.inventory_item_id}.")
        
        total_cost = item_in.quantity * item_in.unit_cost
        subtotal += total_cost
        
        po_item = models.PurchaseOrderItem(
            inventory_item_id=item_in.inventory_item_id,
            quantity=item_in.quantity,
            unit_cost=item_in.unit_cost,
            total_cost=total_cost,
            notes=item_in.notes
        )
        po_items.append(po_item)

    po = models.PurchaseOrder(
        tenant_id=tenant_id,
        po_number=po_number,
        supplier_id=body.supplier_id,
        expected_delivery_date=body.expected_delivery_date,
        status=models.PurchaseOrderStatus.DRAFT,
        subtotal=subtotal,
        total_amount=subtotal,  # Adjust if you add tax/discount later
        notes=body.notes,
        created_by=current_user.id
    )
    po.items = po_items
    
    db.add(po)
    try:
        db.commit()
        db.refresh(po)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Error creating purchase order."
        )
    return po

@router.put("/purchase-orders/{po_id}", response_model=schemas.PurchaseOrderResponse)
def update_purchase_order(
    po_id: int,
    body: schemas.PurchaseOrderUpdate,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    po = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.id == po_id,
        models.PurchaseOrder.tenant_id == tenant_id
    ).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase Order not found")

    if po.status in [models.PurchaseOrderStatus.RECEIVED, models.PurchaseOrderStatus.CANCELLED]:
        raise HTTPException(status_code=400, detail="Cannot update a received or cancelled purchase order.")

    if body.expected_delivery_date is not None:
        po.expected_delivery_date = body.expected_delivery_date
    if body.notes is not None:
        po.notes = body.notes
    if body.status is not None:
        po.status = body.status

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
    po = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.id == po_id,
        models.PurchaseOrder.tenant_id == tenant_id
    ).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase Order not found")
        
    if po.status == models.PurchaseOrderStatus.RECEIVED:
        raise HTTPException(status_code=400, detail="Cannot delete a received purchase order.")

    db.delete(po)
    db.commit()
    return None

@router.post("/purchase-orders/{po_id}/receive", response_model=schemas.PurchaseOrderResponse)
def receive_purchase_order(
    po_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    """
    Receives a purchase order, updating inventory stock levels and changing status.
    Uses transaction to ensure all or nothing.
    """
    po = db.query(models.PurchaseOrder).filter(
        models.PurchaseOrder.id == po_id,
        models.PurchaseOrder.tenant_id == tenant_id
    ).first()
    
    if not po:
        raise HTTPException(status_code=404, detail="Purchase Order not found")
        
    if po.status == models.PurchaseOrderStatus.RECEIVED:
        raise HTTPException(status_code=400, detail="Purchase Order is already received.")

    if po.status == models.PurchaseOrderStatus.CANCELLED:
        raise HTTPException(status_code=400, detail="Cannot receive a cancelled purchase order.")

    # Process items and update stock
    try:
        for item in po.items:
            inv_item = db.query(models.InventoryItem).filter(
                models.InventoryItem.id == item.inventory_item_id,
                models.InventoryItem.tenant_id == tenant_id
            ).first()
            if not inv_item:
                raise ValueError(f"Inventory item {item.inventory_item_id} not found.")
            
            # Increase stock
            old_qty = float(inv_item.quantity)
            new_qty = float(inv_item.quantity) + float(item.quantity)
            inv_item.quantity = new_qty
            db.flush()
            
            # Log action
            log = models.ActivityLog(
                tenant_id=tenant_id,
                user_id=current_user.id,
                action="PO Received",
                performed_by=current_user.username,
                target_user=None,
                role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
                details=f"Stock received from PO {po.po_number}. Item '{inv_item.name}' adjusted from {old_qty:.2f} to {new_qty:.2f}."
            )
            db.add(log)

        # Update PO status
        po.status = models.PurchaseOrderStatus.RECEIVED
        po.received_date = datetime.now()
        
        db.commit()
        db.refresh(po)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to receive purchase order: {str(e)}")

    return po
