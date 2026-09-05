from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func
from typing import List, Optional
from datetime import datetime

from app.db import get_db
import app.models as models
from app.core.dependencies import require_inventory_access, get_inventory_tenant_id
from pydantic import BaseModel, Field

router = APIRouter(tags=["Suppliers"])


# ─── Pydantic Schemas ────────────────────────────────────────────────────────

class SupplierCreate(BaseModel):
    supplier_name: str = Field(..., max_length=150)
    contact_number: Optional[str] = Field(None, max_length=50)
    category: Optional[str] = Field(None, max_length=100)
    contact_person: Optional[str] = Field(None, max_length=100)
    email: Optional[str] = Field(None, max_length=100)
    address: Optional[str] = None
    products_supplied: Optional[str] = Field(None, max_length=255)
    status: Optional[str] = Field("Active", max_length=50)
    notes: Optional[str] = None


class SupplierUpdate(BaseModel):
    supplier_name: Optional[str] = Field(None, max_length=150)
    contact_number: Optional[str] = Field(None, max_length=50)
    category: Optional[str] = Field(None, max_length=100)
    contact_person: Optional[str] = Field(None, max_length=100)
    email: Optional[str] = Field(None, max_length=100)
    address: Optional[str] = None
    products_supplied: Optional[str] = Field(None, max_length=255)
    status: Optional[str] = Field(None, max_length=50)
    notes: Optional[str] = None


class SupplierResponse(BaseModel):
    id: int
    tenant_id: int
    supplier_name: str
    contact_number: Optional[str]
    category: Optional[str]
    contact_person: Optional[str]
    email: Optional[str]
    address: Optional[str]
    products_supplied: Optional[str]
    status: str
    notes: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/suppliers", response_model=List[SupplierResponse])
def get_suppliers(
    supplier_status: Optional[str] = Query(None, alias="status"),
    category: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
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


@router.get("/suppliers/stats")
def get_supplier_stats(
    db: Session = Depends(get_db),
    tenant_id: int = Depends(get_inventory_tenant_id),
    current_user: models.User = Depends(require_inventory_access)
):
    active_count = db.query(models.Supplier).filter(
        models.Supplier.tenant_id == tenant_id,
        models.Supplier.status == "Active"
    ).count()

    category_counts = db.query(
        models.Supplier.category,
        func.count(models.Supplier.id)
    ).filter(
        models.Supplier.tenant_id == tenant_id,
        models.Supplier.category.isnot(None),
        models.Supplier.category != ""
    ).group_by(models.Supplier.category).all()

    categories = {row[0]: row[1] for row in category_counts}

    return {
        "active_suppliers": active_count,
        "categories": categories,
        "total_suppliers": db.query(models.Supplier).filter(
            models.Supplier.tenant_id == tenant_id
        ).count()
    }


@router.get("/suppliers/{supplier_id}", response_model=SupplierResponse)
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


@router.post("/suppliers", response_model=SupplierResponse, status_code=status.HTTP_201_CREATED)
def create_supplier(
    body: SupplierCreate,
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
            detail=f"A supplier named '{body.supplier_name}' already exists."
        )
    return supplier


@router.put("/suppliers/{supplier_id}", response_model=SupplierResponse)
def update_supplier(
    supplier_id: int,
    body: SupplierUpdate,
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
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(supplier, key, value)
    try:
        db.commit()
        db.refresh(supplier)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Update failed — duplicate supplier name.")
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
