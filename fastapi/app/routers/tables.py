from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.db import get_db
import app.models as models
from app.core.dependencies import get_current_user

router = APIRouter(prefix="/tables", tags=["Restaurant Tables"])

@router.get("", summary="Get all tables for the current tenant")
def get_tables(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    tenant_id = current_user.tenant_id
    if not tenant_id:
        # Fallback to first available tenant or 1
        first_tenant = db.query(models.Tenant).first()
        tenant_id = first_tenant.id if first_tenant else 1
        
    tables = db.query(models.RestaurantTable).filter(models.RestaurantTable.tenant_id == tenant_id).order_by(models.RestaurantTable.id.asc()).all()
    
    return [
        {
            "id": t.id,
            "table_number": t.table_number,
            "status": t.status
        }
        for t in tables
    ]

@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a new table")
def create_table(body: dict, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # Basic role check
    role = getattr(current_user, "role", None)
    if role and str(role) not in ["UserRole.ADMIN", "UserRole.MANAGER", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized to manage tables")
        
    tenant_id = current_user.tenant_id
    if not tenant_id:
        first_tenant = db.query(models.Tenant).first()
        tenant_id = first_tenant.id if first_tenant else 1
        
    table_number = body.get("table_number")
    if not table_number:
        raise HTTPException(status_code=400, detail="Table number is required")
        
    # Check if exists
    existing = db.query(models.RestaurantTable).filter(
        models.RestaurantTable.tenant_id == tenant_id,
        models.RestaurantTable.table_number == str(table_number)
    ).first()
    
    if existing:
        raise HTTPException(status_code=400, detail="Table number already exists")
        
    new_table = models.RestaurantTable(
        tenant_id=tenant_id,
        table_number=str(table_number),
        status="active"
    )
    db.add(new_table)
    db.commit()
    db.refresh(new_table)
    
    return {
        "message": "Table created successfully",
        "id": new_table.id,
        "table_number": new_table.table_number
    }

@router.delete("/{table_id}", summary="Delete a table")
def delete_table(table_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    role = getattr(current_user, "role", None)
    if role and str(role) not in ["UserRole.ADMIN", "UserRole.MANAGER", "admin", "manager"]:
        raise HTTPException(status_code=403, detail="Not authorized to manage tables")
        
    tenant_id = current_user.tenant_id
    if not tenant_id:
        first_tenant = db.query(models.Tenant).first()
        tenant_id = first_tenant.id if first_tenant else 1
        
    table = db.query(models.RestaurantTable).filter(
        models.RestaurantTable.tenant_id == tenant_id,
        models.RestaurantTable.id == table_id
    ).first()
    
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
        
    db.delete(table)
    db.commit()
    
    return {"message": "Table deleted successfully"}
