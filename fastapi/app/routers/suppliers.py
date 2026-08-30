from fastapi import APIRouter, Depends, HTTPException, status, Query
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session
# pyrefly: ignore [missing-import]
from sqlalchemy.exc import IntegrityError
from typing import List, Optional

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import require_inventory_access, get_inventory_tenant_id

router = APIRouter(tags=["Suppliers"])

@router.get("/suppliers", response_model=List[schemas.SupplierResponse])
def get_suppliers(
    supplier_status: Optional[str] = Query(None, alias="status", description="Filter by status"),
    category: Optional[str] = Query(None, description="Filter by category"),
    search: Optional[str] = Query(None, description="Search by name"),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    query = db.query(models.Supplier).filter(models.Supplier.tenant_id == tenant_id)
    if supplier_status:
        query = query.filter(models.Supplier.status == supplier_status)
    if category:
        query = query.filter(models.Supplier.category == category)
    if search:
        query = query.filter(models.Supplier.supplier_name.ilike(f"%{search}%"))
    
    return query.order_by(models.Supplier.supplier_name).all()

@router.get("/suppliers/{supplier_id}", response_model=schemas.SupplierResponse)
def get_supplier(
    supplier_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    supplier = db.query(models.Supplier).filter(
        models.Supplier.id == supplier_id,
        models.Supplier.tenant_id == tenant_id
    ).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")
    return supplier

@router.post("/suppliers", response_model=schemas.SupplierResponse, status_code=status.HTTP_201_CREATED)
def create_supplier(
    body: schemas.SupplierCreate,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    supplier = models.Supplier(
        tenant_id=tenant_id,
        supplier_name=body.supplier_name,
        contact_number=body.contact_number,
        category=body.category,
        contact_person=body.contact_person,
        email=body.email,
        address=body.address,
        products_supplied=body.products_supplied,
        status=body.status,
        notes=body.notes
    )
    db.add(supplier)
    try:
        db.commit()
        db.refresh(supplier)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A supplier with name '{body.supplier_name}' already exists in your tenant."
        )
    return supplier

@router.put("/suppliers/{supplier_id}", response_model=schemas.SupplierResponse)
def update_supplier(
    supplier_id: int,
    body: schemas.SupplierUpdate,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    supplier = db.query(models.Supplier).filter(
        models.Supplier.id == supplier_id,
        models.Supplier.tenant_id == tenant_id
    ).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(supplier, key, value)

    try:
        db.commit()
        db.refresh(supplier)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Supplier update failed due to constraint violation (likely a duplicate name)."
        )
    return supplier

@router.delete("/suppliers/{supplier_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_supplier(
    supplier_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    supplier = db.query(models.Supplier).filter(
        models.Supplier.id == supplier_id,
        models.Supplier.tenant_id == tenant_id
    ).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    db.delete(supplier)
    db.commit()
    return None
