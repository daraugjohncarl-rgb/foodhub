"""
Products & Categories Router
============================
Reads are open to every staff role of the branch (the POS needs them); writes require ADMIN or SUPER_ADMIN.
tenant_id is always derived from the caller (SUPER_ADMIN may pass ?tenant_id=) — never from the request body.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core import audit
from app.core.dependencies import get_admin_tenant_id, get_tenant_scope, require_permission, resolve_tenant_id

router = APIRouter(tags=["Admin — Products & Categories"])

can_read_catalog = require_permission("catalog.read")
can_write_catalog = require_permission("catalog.write")


# ──────────────────────────────────────────────────────────────────────────────
# CATEGORIES
# ──────────────────────────────────────────────────────────────────────────────

@router.get(
    "/categories",
    response_model=List[schemas.CategoryResponse],
    summary="List all categories for the calling user's tenant"
)
def list_categories(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_catalog),
    tenant_id: int = Depends(get_tenant_scope),
):
    return db.query(models.Category).filter(models.Category.tenant_id == tenant_id).order_by(models.Category.name).all()


@router.post(
    "/categories",
    response_model=schemas.CategoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new product category (tenant auto-scoped)"
)
def create_category(
    body: schemas.CategoryCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_catalog),
    tenant_id: int = Depends(get_admin_tenant_id),
):
    category = models.Category(
        tenant_id=tenant_id,
        name=body.name.strip(),
        description=body.description,
    )
    db.add(category)
    try:
        db.commit()
        db.refresh(category)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Category '{body.name}' already exists for this tenant."
        )
    return category


# ──────────────────────────────────────────────────────────────────────────────
# PRODUCTS
# ──────────────────────────────────────────────────────────────────────────────

@router.get(
    "/products",
    response_model=List[schemas.AdminProductResponse],
    summary="List products for the calling user's tenant"
)
def list_products(
    search: Optional[str] = Query(None, max_length=100, description="Partial match on product name or SKU"),
    category_id: Optional[int] = Query(None, description="Filter by category"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_catalog),
    tenant_id: int = Depends(get_tenant_scope),
):
    q = (
        db.query(models.Product)
        .options(joinedload(models.Product.category))
        .filter(models.Product.tenant_id == tenant_id)
    )
    if search:
        term = f"%{search.strip()}%"
        q = q.filter(
            models.Product.name.ilike(term) | models.Product.sku.ilike(term)
        )
    if category_id is not None:
        q = q.filter(models.Product.category_id == category_id)
    if is_active is not None:
        q = q.filter(models.Product.is_active == is_active)
    return q.order_by(models.Product.name).limit(limit).all()


def _check_category(db: Session, tenant_id: int, category_id: Optional[int]) -> None:
    if category_id is None:
        return
    cat = db.query(models.Category.id).filter(
        models.Category.id == category_id,
        models.Category.tenant_id == tenant_id
    ).first()
    if not cat:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Category {category_id} not found in your tenant."
        )


def _duplicate_detail(db: Session, tenant_id: int, name: Optional[str], sku: Optional[str], exclude_id=None) -> Optional[str]:
    q = db.query(models.Product).filter(models.Product.tenant_id == tenant_id)
    if exclude_id is not None:
        q = q.filter(models.Product.id != exclude_id)
    if name and q.filter(models.Product.name == name).first():
        return f"A product named '{name}' already exists in your tenant."
    if sku and q.filter(models.Product.sku == sku).first():
        return f"A product with SKU '{sku}' already exists in your tenant."
    return None


def _load_product(db: Session, product_id: int) -> models.Product:
    return (
        db.query(models.Product)
        .options(joinedload(models.Product.category))
        .filter(models.Product.id == product_id)
        .first()
    )


@router.post(
    "/products",
    response_model=schemas.AdminProductResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new product (tenant auto-scoped from JWT)"
)
def create_product(
    body: schemas.AdminProductCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_catalog),
    tenant_id: int = Depends(get_admin_tenant_id),
):
    _check_category(db, tenant_id, body.category_id)
    name, sku = body.name.strip(), body.sku.strip()
    duplicate = _duplicate_detail(db, tenant_id, name, sku)
    if duplicate:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=duplicate)

    product = models.Product(
        tenant_id=tenant_id,
        category_id=body.category_id,
        name=name,
        sku=sku,
        barcode=body.barcode,
        price=body.price,
        cost=body.cost,
        is_active=body.is_active if body.is_active is not None else True,
        image_url=body.image_url,
    )
    db.add(product)
    audit.record(db, current_user, "Product Created", tenant_id=tenant_id, details=f"{name} ({sku})")
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="A product with this name or SKU already exists in your tenant.")
    return _load_product(db, product.id)


@router.put(
    "/products/{product_id}",
    response_model=schemas.AdminProductResponse,
    summary="Partially update a product"
)
def update_product(
    product_id: int,
    body: schemas.AdminProductUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_catalog),
    tenant_id: int = Depends(get_admin_tenant_id),
):
    product = db.query(models.Product).filter(
        models.Product.id == product_id,
        models.Product.tenant_id == tenant_id
    ).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found.")

    changes = body.model_dump(exclude_unset=True)
    _check_category(db, tenant_id, changes.get("category_id"))
    if "name" in changes:
        changes["name"] = changes["name"].strip()
    if "sku" in changes:
        changes["sku"] = changes["sku"].strip()
    duplicate = _duplicate_detail(db, tenant_id, changes.get("name"), changes.get("sku"), exclude_id=product.id)
    if duplicate:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=duplicate)

    for field, value in changes.items():
        setattr(product, field, value)
    audit.record(db, current_user, "Product Updated", tenant_id=tenant_id,
                 details=f"{product.name}: {', '.join(sorted(changes)) or 'no changes'}")
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="A product with this name or SKU already exists.")
    return _load_product(db, product.id)


@router.delete(
    "/products/{product_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Soft-delete a product (sets is_active = False)"
)
def deactivate_product(
    product_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_catalog),
    tenant_id: int = Depends(get_admin_tenant_id),
):
    product = db.query(models.Product).filter(
        models.Product.id == product_id,
        models.Product.tenant_id == tenant_id
    ).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found.")
    product.is_active = False
    audit.record(db, current_user, "Product Deactivated", tenant_id=tenant_id, details=product.name)
    db.commit()


# ──────────────────────────────────────────────────────────────────────────────
# RECIPES (M4): ingredients deducted from inventory for each unit sold
# ──────────────────────────────────────────────────────────────────────────────

def _recipe_payload(db: Session, product: models.Product):
    rows = (
        db.query(models.ProductRecipe, models.InventoryItem)
        .join(models.InventoryItem, models.InventoryItem.id == models.ProductRecipe.inventory_item_id)
        .filter(models.ProductRecipe.product_id == product.id)
        .order_by(models.InventoryItem.name)
        .all()
    )
    return [
        schemas.RecipeLineResponse(
            inventory_item_id=item.id, inventory_item_name=item.name, unit=item.unit, quantity=line.quantity,
        )
        for line, item in rows
    ]


@router.get("/products/{product_id}/recipe", response_model=List[schemas.RecipeLineResponse])
def get_recipe(
    product_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_catalog),
    tenant_id: int = Depends(get_tenant_scope),
):
    product = db.query(models.Product).filter(models.Product.id == product_id, models.Product.tenant_id == tenant_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found.")
    return _recipe_payload(db, product)


@router.put("/products/{product_id}/recipe", response_model=List[schemas.RecipeLineResponse])
def set_recipe(
    product_id: int,
    body: schemas.RecipeSet,
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("recipes.write")),
):
    scope_tenant = resolve_tenant_id(db, current_user, tenant_id)
    product = db.query(models.Product).filter(
        models.Product.id == product_id, models.Product.tenant_id == scope_tenant
    ).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found.")

    item_ids = [line.inventory_item_id for line in body.lines]
    if len(item_ids) != len(set(item_ids)):
        raise HTTPException(status_code=422, detail="Each inventory item may appear only once in a recipe.")
    if item_ids:
        found = {
            i.id for i in db.query(models.InventoryItem).filter(
                models.InventoryItem.tenant_id == scope_tenant,
                models.InventoryItem.id.in_(item_ids),
                models.InventoryItem.is_active.is_(True),
            )
        }
        missing = [i for i in item_ids if i not in found]
        if missing:
            raise HTTPException(status_code=404, detail=f"Inventory item(s) not found in this branch: {missing}")

    db.query(models.ProductRecipe).filter(models.ProductRecipe.product_id == product.id).delete(synchronize_session=False)
    for line in body.lines:
        db.add(models.ProductRecipe(product_id=product.id, inventory_item_id=line.inventory_item_id, quantity=line.quantity))
    audit.record(db, current_user, "Recipe Updated", tenant_id=scope_tenant,
                 details=f"{product.name}: {len(body.lines)} ingredient line(s)")
    db.commit()
    return _recipe_payload(db, product)
