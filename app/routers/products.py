"""
Products & Categories Router — Admin Module
============================================
All endpoints require ADMIN or SUPER_ADMIN role.
tenant_id is always auto-scoped from the JWT — never accepted from the client body.
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query, UploadFile, File
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.exc import IntegrityError
from typing import List, Optional
from decimal import Decimal
import os
import uuid
import shutil

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import (
    require_admin,
    get_admin_tenant_id,
    require_manager_or_admin,
    get_manager_or_admin_tenant_id,
    get_current_user
)

router = APIRouter(tags=["Admin & Manager — Products & Categories"])


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
    current_user: models.User = Depends(require_manager_or_admin),
    tenant_id: int = Depends(get_manager_or_admin_tenant_id),
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
    current_user: models.User = Depends(require_manager_or_admin),
    tenant_id: int = Depends(get_manager_or_admin_tenant_id),
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
        cost=body.cost if body.cost is not None else Decimal("0.0"),
        is_active=body.is_active if body.is_active is not None else True,
        image_url=body.image_url,
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
    current_user: models.User = Depends(require_manager_or_admin),
    tenant_id: int = Depends(get_manager_or_admin_tenant_id),
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
    summary="Delete or deactivate a product"
)
def delete_product(
    product_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
    tenant_id: int = Depends(get_manager_or_admin_tenant_id),
):
    product = db.query(models.Product).filter(
        models.Product.id == product_id,
        models.Product.tenant_id == tenant_id
    ).first()
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found.")

    # Check if this product has existing sales transactions
    has_orders = db.query(models.TransactionItem).filter(models.TransactionItem.product_id == product_id).first()
    if has_orders:
        product.is_active = False
        db.commit()
        return {"status": "archived", "message": f"Product '{product.name}' has transaction records and has been deactivated/archived."}
    else:
        db.delete(product)
        db.commit()
        return {"status": "deleted", "message": f"Product '{product.name}' has been deleted permanently."}


@router.post(
    "/products/upload-image",
    summary="Upload a menu product image"
)
def upload_product_image(
    file: UploadFile = File(...),
    current_user: models.User = Depends(require_manager_or_admin),
):
    """
    Upload a picture for a menu product.
    Saves to /static/images/products and returns the static image URL.
    """
    ext = os.path.splitext(file.filename)[1].lower() if file.filename else ".jpg"
    if ext not in [".jpg", ".jpeg", ".png", ".webp", ".gif"]:
        raise HTTPException(status_code=400, detail="Only image files (.jpg, .jpeg, .png, .webp, .gif) are allowed.")

    unique_name = f"prod_{uuid.uuid4().hex[:12]}{ext}"

    # Target static directories to persist uploaded menu pictures
    # Resolves to c:\pos\fastapi\static\images\products and c:\pos\static\images\products
    current_dir = os.path.dirname(os.path.abspath(__file__))
    fastapi_static = os.path.join(os.path.dirname(os.path.dirname(current_dir)), "static", "images", "products")
    root_static = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(current_dir))), "static", "images", "products")

    dirs_to_save = [fastapi_static, root_static]
    primary_file = None

    for target_dir in dirs_to_save:
        try:
            os.makedirs(target_dir, exist_ok=True)
            dest_path = os.path.join(target_dir, unique_name)
            if primary_file is None:
                with open(dest_path, "wb") as buffer:
                    shutil.copyfileobj(file.file, buffer)
                primary_file = dest_path
            else:
                try:
                    shutil.copyfile(primary_file, dest_path)
                except Exception:
                    pass
        except Exception:
            pass

    return {"image_url": f"/static/images/products/{unique_name}"}


