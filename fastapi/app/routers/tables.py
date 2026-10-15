"""
Restaurant tables and their QR codes (M10, H11).

Deactivating a table keeps its printed QR code meaningful: customers scanning it are told the table is not taking
orders. Deleting is only possible for tables that never received an order; otherwise deactivate it.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core import audit
from app.core.dependencies import require_permission, resolve_tenant_id

router = APIRouter(prefix="/tables", tags=["Restaurant Tables"])


def _serialize(t: models.RestaurantTable) -> dict:
    return {"id": t.id, "tenant_id": t.tenant_id, "table_number": t.table_number, "status": t.status}


@router.get("", summary="Get all tables for the current tenant")
def get_tables(
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to view"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("tables.read")),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    tables = (
        db.query(models.RestaurantTable)
        .filter(models.RestaurantTable.tenant_id == scope_tenant)
        .order_by(models.RestaurantTable.id.asc())
        .all()
    )
    return [_serialize(t) for t in tables]


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a new table")
def create_table(
    body: schemas.TableCreate,
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("tables.write")),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    existing = db.query(models.RestaurantTable.id).filter(
        models.RestaurantTable.tenant_id == scope_tenant,
        models.RestaurantTable.table_number == body.table_number,
    ).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Table number already exists")

    new_table = models.RestaurantTable(tenant_id=scope_tenant, table_number=body.table_number, status="active")
    db.add(new_table)
    audit.record(db, current_user, "Table Created", tenant_id=scope_tenant, details=f"Table {body.table_number}")
    try:
        db.commit()
    except IntegrityError:   # concurrent create of the same number
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Table number already exists")
    db.refresh(new_table)

    return {
        "message": "Table created successfully",
        "id": new_table.id,
        "tenant_id": new_table.tenant_id,
        "table_number": new_table.table_number,
        "status": new_table.status,
    }


@router.put("/{table_id}", summary="Activate or deactivate a table")
def update_table(
    table_id: int,
    body: schemas.TableUpdate,
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("tables.write")),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    table = db.query(models.RestaurantTable).filter(
        models.RestaurantTable.tenant_id == scope_tenant, models.RestaurantTable.id == table_id
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    table.status = body.status
    audit.record(db, current_user, "Table Updated", tenant_id=scope_tenant,
                 details=f"Table {table.table_number} -> {body.status}")
    db.commit()
    return _serialize(table)


@router.delete("/{table_id}", summary="Delete a table")
def delete_table(
    table_id: int,
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("tables.write")),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    table = db.query(models.RestaurantTable).filter(
        models.RestaurantTable.tenant_id == scope_tenant,
        models.RestaurantTable.id == table_id
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    used = db.query(models.CustomerOrder.id).filter(
        models.CustomerOrder.tenant_id == scope_tenant,
        models.CustomerOrder.table_number == table.table_number,
    ).first()
    if used:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This table has order history. Deactivate it instead of deleting it.",
        )

    audit.record(db, current_user, "Table Deleted", tenant_id=scope_tenant, details=f"Table {table.table_number}")
    db.delete(table)
    db.commit()
    return {"message": "Table deleted successfully"}
