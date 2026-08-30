"""
Products & Categories Router — Admin Module
============================================
All endpoints require ADMIN or SUPER_ADMIN role.
tenant_id is always auto-scoped from the JWT — never accepted from the client body.
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.exc import IntegrityError
from typing import List, Optional

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import require_admin, get_admin_tenant_id, get_current_user

router = APIRouter(tags=["Admin — Products & Categories"])


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
    current_user: models.User = Depends(get_current_user),
):
    q = db.query(models.Category)
    if current_user.tenant_id:
        q = q.filter(models.Category.tenant_id == current_user.tenant_id)
    return q.order_by(models.Category.name).all()


@router.post(
    "/categories",
    response_model=schemas.CategoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new product category (tenant auto-scoped)"
)
def create_category(
    body: schemas.CategoryCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin),
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
    search: Optional[str] = Query(None, description="Partial match on product name or SKU"),
    category_id: Optional[int] = Query(None, description="Filter by category"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    limit: int = Query(200, le=500),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    q = (
        db.query(models.Product)
        .options(joinedload(models.Product.category))
    )
    if current_user.tenant_id:
        q = q.filter(models.Product.tenant_id == current_user.tenant_id)
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


@router.post(
    "/products",
    response_model=schemas.AdminProductResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new product (tenant auto-scoped from JWT)"
)
def create_product(
    body: schemas.AdminProductCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin),
    tenant_id: int = Depends(get_admin_tenant_id),
):
    # Verify the category (if provided) belongs to the same tenant
    if body.category_id is not None:
        cat = db.query(models.Category).filter(
            models.Category.id == body.category_id,
            models.Category.tenant_id == tenant_id
        ).first()
        if not cat:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Category {body.category_id} not found in your tenant."
            )

    product = models.Product(
        tenant_id=tenant_id,
        category_id=body.category_id,
        name=body.name.strip(),
        sku=body.sku.strip(),
        barcode=body.barcode,
        price=body.price,
        cost=body.cost,
        is_active=body.is_active if body.is_active is not None else True,
    )
    db.add(product)
    try:
        db.commit()
        db.refresh(product)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A product with this name or SKU already exists in your tenant."
        )

    # Re-query with relationship loaded for response serialisation
    product = (
        db.query(models.Product)
        .options(joinedload(models.Product.category))
        .filter(models.Product.id == product.id)
        .first()
    )
    return product


@router.put(
    "/products/{product_id}",
    response_model=schemas.AdminProductResponse,
    summary="Partially update a product"
)
def update_product(
    product_id: int,
    body: schemas.AdminProductUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin),
    tenant_id: int = Depends(get_admin_tenant_id),
):
    product = db.query(models.Product).filter(
        models.Product.id == product_id,
        models.Product.tenant_id == tenant_id
    ).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found.")

    # Verify new category belongs to same tenant
    if body.category_id is not None:
        cat = db.query(models.Category).filter(
            models.Category.id == body.category_id,
            models.Category.tenant_id == tenant_id
        ).first()
        if not cat:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Category {body.category_id} not found in your tenant."
            )

    # Apply only provided fields
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(product, field, value)

    try:
        db.commit()
        db.refresh(product)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A product with this name or SKU already exists."
        )

    product = (
        db.query(models.Product)
        .options(joinedload(models.Product.category))
        .filter(models.Product.id == product.id)
        .first()
    )
    return product


@router.delete(
    "/products/{product_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Soft-delete a product (sets is_active = False)"
)
def deactivate_product(
    product_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin),
    tenant_id: int = Depends(get_admin_tenant_id),
):
    product = db.query(models.Product).filter(
        models.Product.id == product_id,
        models.Product.tenant_id == tenant_id
    ).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found.")
    product.is_active = False
    db.commit()
