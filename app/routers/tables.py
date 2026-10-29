from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.db import get_db
import app.models as models
from app.core.dependencies import require_pos_access, require_manager_or_admin, resolve_tenant_id

router = APIRouter(prefix="/tables", tags=["Restaurant Tables"])

@router.get("", summary="Get all tables for the current tenant")
def get_tables(db: Session = Depends(get_db), current_user: models.User = Depends(require_pos_access)):
    tenant_id = resolve_tenant_id(current_user, db)
        
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
def create_table(body: dict, db: Session = Depends(get_db), current_user: models.User = Depends(require_manager_or_admin)):
    # Role check (Admin, Super Admin, Manager)
    allowed = {models.UserRole.ADMIN, models.UserRole.SUPER_ADMIN, models.UserRole.MANAGER, "ADMIN", "SUPER_ADMIN", "MANAGER", "admin", "manager"}
    if getattr(current_user, "role", None) not in allowed:
        raise HTTPException(status_code=403, detail="Not authorized to manage tables")
        
    tenant_id = resolve_tenant_id(current_user, db)
        
    table_number = body.get("table_number")
    if not table_number:
        raise HTTPException(status_code=400, detail="Table number is required")
    from app.routers.customer_orders import TABLE_LABEL_RE
    if not TABLE_LABEL_RE.match(str(table_number).strip()):
        raise HTTPException(status_code=400, detail="Table number may only contain letters, numbers, spaces, '.', '#', '-' and '_'.")
    table_number = str(table_number).strip()
        
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
def delete_table(table_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(require_manager_or_admin)):
    allowed = {models.UserRole.ADMIN, models.UserRole.SUPER_ADMIN, models.UserRole.MANAGER, "ADMIN", "SUPER_ADMIN", "MANAGER", "admin", "manager"}
    if getattr(current_user, "role", None) not in allowed:
        raise HTTPException(status_code=403, detail="Not authorized to manage tables")
        
    tenant_id = resolve_tenant_id(current_user, db)
        
    table = db.query(models.RestaurantTable).filter(
        models.RestaurantTable.tenant_id == tenant_id,
        models.RestaurantTable.id == table_id
    ).first()
    
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
        
    db.delete(table)
    db.commit()
    
    return {"message": "Table deleted successfully"}
