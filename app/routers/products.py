"""
Products & Categories Router — Admin Module
============================================
All endpoints require ADMIN or SUPER_ADMIN role.
tenant_id is always auto-scoped from the JWT — never accepted from the client body.
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query, UploadFile, File, Form
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.exc import IntegrityError
from typing import List, Optional
from decimal import Decimal
import os
import uuid
import shutil
import re

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


@router.put(
    "/categories/{category_id}",
    response_model=schemas.CategoryResponse,
    summary="Update an existing product category"
)
def update_category(
    category_id: int,
    body: schemas.CategoryUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
    tenant_id: int = Depends(get_manager_or_admin_tenant_id),
):
    category = db.query(models.Category).filter(
        models.Category.id == category_id,
        models.Category.tenant_id == tenant_id
    ).first()
    if not category:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Category not found."
        )

    if body.name is not None and body.name.strip():
        category.name = body.name.strip()
    if body.description is not None:
        category.description = body.description

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


@router.delete(
    "/categories/{category_id}",
    summary="Delete a product category"
)
def delete_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
    tenant_id: int = Depends(get_manager_or_admin_tenant_id),
):
    category = db.query(models.Category).filter(
        models.Category.id == category_id,
        models.Category.tenant_id == tenant_id
    ).first()
    if not category:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Category not found."
        )

    # Detach products from this category to prevent foreign key errors
    db.query(models.Product).filter(
        models.Product.category_id == category_id,
        models.Product.tenant_id == tenant_id
    ).update({"category_id": None})

    db.delete(category)
    db.commit()
    return {"status": "deleted", "message": f"Category '{category.name}' deleted successfully."}


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
    summary="Delete a product permanently"
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

    prod_name = product.name

    # Safely decouple sales transaction items so closed financial records remain intact
    try:
        db.query(models.TransactionItem).filter(
            models.TransactionItem.product_id == product_id
        ).update({"product_id": None}, synchronize_session=False)
    except Exception:
        pass

    # Decouple customer online order items
    try:
        db.query(models.CustomerOrderItem).filter(
            models.CustomerOrderItem.product_id == product_id
        ).update({"product_id": None}, synchronize_session=False)
    except Exception:
        pass

    # Clean recipes associated with this product
    try:
        db.query(models.ProductRecipe).filter(
            models.ProductRecipe.product_id == product_id
        ).delete(synchronize_session=False)
    except Exception:
        pass

    db.delete(product)
    db.commit()
    return {"status": "deleted", "message": f"Product '{prod_name}' has been deleted permanently."}


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


# ──────────────────────────────────────────────────────────────────────────────
# PRESET MENU CATALOG & BULK PRODUCT IMPORTERS
# ──────────────────────────────────────────────────────────────────────────────

PRESET_MENU_ITEMS = [
    {
        "name": "Burger Solo",
        "category_name": "Burgers & Sandwiches",
        "price": 50.00,
        "sku": "BS-01",
        "image_url": "/static/assets/images/burger solo.png"
    },
    {
        "name": "Burger with Fries",
        "category_name": "Burgers & Sandwiches",
        "price": 85.00,
        "sku": "BF-01",
        "image_url": "/static/assets/images/burger with fries.png"
    },
    {
        "name": "Tuna Sandwich",
        "category_name": "Burgers & Sandwiches",
        "price": 60.00,
        "sku": "TS-01",
        "image_url": "/static/assets/images/tuna sandwich.png"
    },
    {
        "name": "Spaghetti with Bread",
        "category_name": "Pasta & Noodles",
        "price": 95.00,
        "sku": "SB-01",
        "image_url": "/static/assets/images/spaghetti with bread.png"
    },
    {
        "name": "Spaghetti with Burger",
        "category_name": "Pasta & Noodles",
        "price": 120.00,
        "sku": "SB-02",
        "image_url": "/static/assets/images/spaghetti with burger.png"
    },
    {
        "name": "Carbonara with Bread",
        "category_name": "Pasta & Noodles",
        "price": 110.00,
        "sku": "CB-01",
        "image_url": "/static/assets/images/carbonara with bread.png"
    },
    {
        "name": "Pancit Canton",
        "category_name": "Pasta & Noodles",
        "price": 70.00,
        "sku": "PC-01",
        "image_url": "/static/assets/images/PANCIT CANTON.png"
    },
    {
        "name": "Pancit Canton with Toasted Bread",
        "category_name": "Pasta & Noodles",
        "price": 85.00,
        "sku": "PC-02",
        "image_url": "/static/assets/images/Pancit Canton with Toasted Bread.png"
    },
    {
        "name": "Sotanghon Guisado",
        "category_name": "Pasta & Noodles",
        "price": 90.00,
        "sku": "SG-01",
        "image_url": "/static/assets/images/sotanghon guisado.png"
    },
    {
        "name": "Arroz Caldo",
        "category_name": "Mains & Bowls",
        "price": 65.00,
        "sku": "AC-01",
        "image_url": "/static/assets/images/arrozcaldo.png"
    },
    {
        "name": "Molo Soup",
        "category_name": "Mains & Bowls",
        "price": 75.00,
        "sku": "ML-01",
        "image_url": "/static/assets/images/MOLO.png"
    },
    {
        "name": "Nachos",
        "category_name": "Snacks & Sides",
        "price": 80.00,
        "sku": "NC-01",
        "image_url": "/static/assets/images/nachos.png"
    },
    {
        "name": "Nachofries",
        "category_name": "Snacks & Sides",
        "price": 95.00,
        "sku": "NF-01",
        "image_url": "/static/assets/images/nachofries.png"
    },
    {
        "name": "Toasted Bread",
        "category_name": "Snacks & Sides",
        "price": 30.00,
        "sku": "TB-01",
        "image_url": "/static/assets/images/toasted bread.png"
    },
    {
        "name": "Caramel Macchiato",
        "category_name": "Coffee & Drinks",
        "price": 85.00,
        "sku": "CM-01",
        "image_url": "/static/assets/images/coffee/caramel macchiato.png"
    },
    {
        "name": "Coffee Jelly",
        "category_name": "Coffee & Drinks",
        "price": 85.00,
        "sku": "CJ-01",
        "image_url": "/static/assets/images/coffee/coffee jelly.png"
    },
    {
        "name": "Dirty Matcha",
        "category_name": "Coffee & Drinks",
        "price": 95.00,
        "sku": "DM-01",
        "image_url": "/static/assets/images/coffee/dirty matcha.png"
    },
    {
        "name": "French Vanilla",
        "category_name": "Coffee & Drinks",
        "price": 85.00,
        "sku": "FV-01",
        "image_url": "/static/assets/images/coffee/french vanill.png"
    },
    {
        "name": "Iced Americano",
        "category_name": "Coffee & Drinks",
        "price": 75.00,
        "sku": "IA-01",
        "image_url": "/static/assets/images/coffee/iced americano.png"
    },
    {
        "name": "Iced Coffee",
        "category_name": "Coffee & Drinks",
        "price": 75.00,
        "sku": "IC-01",
        "image_url": "/static/assets/images/coffee/iced coffe.png"
    },
    {
        "name": "Matcha Milk",
        "category_name": "Coffee & Drinks",
        "price": 90.00,
        "sku": "MM-01",
        "image_url": "/static/assets/images/coffee/matcha milk.png"
    },
    {
        "name": "Salted Caramel",
        "category_name": "Coffee & Drinks",
        "price": 85.00,
        "sku": "SC-01",
        "image_url": "/static/assets/images/coffee/salted caramel.png"
    },
    {
        "name": "Spanish Latte",
        "category_name": "Coffee & Drinks",
        "price": 90.00,
        "sku": "SL-01",
        "image_url": "/static/assets/images/coffee/spanish latte.png"
    },
    {
        "name": "Vietnamese Coffee",
        "category_name": "Coffee & Drinks",
        "price": 85.00,
        "sku": "VC-01",
        "image_url": "/static/assets/images/coffee/vietnamese coffee.png"
    }
]


def clean_product_name_from_filename(filename: str) -> str:
    base = os.path.splitext(filename)[0]
    # Remove leading numeric prefixes like "01 - " or "1. "
    base = re.sub(r"^\d+[\s\.\-_]+", "", base)
    # Replace underscores/hyphens with spaces
    base = re.sub(r"[_\-]+", " ", base)
    words = base.split()
    return " ".join(words).title()


@router.get(
    "/products/preset-library",
    summary="Get preset menu items with images"
)
def get_preset_library(
    current_user: models.User = Depends(require_manager_or_admin),
):
    """Returns the Blessie FoodHub catalog of preset items with existing image assets."""
    return PRESET_MENU_ITEMS


@router.post(
    "/products/import-batch",
    summary="Import multiple menu products with names, categories, and images"
)
def import_products_batch(
    body: schemas.ProductImportBatchRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
    tenant_id: int = Depends(get_manager_or_admin_tenant_id),
):
    created_count = 0
    updated_count = 0

    # Cache existing categories for current tenant
    cat_cache = {
        c.name.lower().strip(): c.id 
        for c in db.query(models.Category).filter(models.Category.tenant_id == tenant_id).all()
    }

    for item in body.items:
        clean_name = item.name.strip()
        if not clean_name:
            continue

        # Resolve or auto-create category by name
        category_id = item.category_id
        if not category_id and item.category_name and item.category_name.strip():
            cat_name = item.category_name.strip()
            cat_key = cat_name.lower()
            if cat_key in cat_cache:
                category_id = cat_cache[cat_key]
            else:
                new_cat = models.Category(tenant_id=tenant_id, name=cat_name)
                db.add(new_cat)
                db.flush()
                category_id = new_cat.id
                cat_cache[cat_key] = category_id

        # Generate SKU if not provided
        sku = (item.sku or "").strip()
        if not sku:
            words = [w[0].upper() for w in clean_name.split() if w]
            prefix = "".join(words[:3]) if words else "PRD"
            if len(prefix) < 2:
                prefix = clean_name[:3].upper()
            sku = f"{prefix}-{uuid.uuid4().hex[:4].upper()}"

        # Match existing product by exact SKU or exact Name
        existing = db.query(models.Product).filter(
            models.Product.tenant_id == tenant_id,
            (models.Product.name.ilike(clean_name)) | (models.Product.sku == sku)
        ).first()

        if existing:
            existing.name = clean_name
            if category_id:
                existing.category_id = category_id
            if item.price is not None:
                existing.price = item.price
            if item.cost is not None:
                existing.cost = item.cost
            if item.image_url:
                existing.image_url = item.image_url
            if item.is_active is not None:
                existing.is_active = item.is_active
            updated_count += 1
        else:
            new_prod = models.Product(
                tenant_id=tenant_id,
                category_id=category_id,
                name=clean_name,
                sku=sku,
                barcode=item.barcode,
                price=item.price,
                cost=item.cost if item.cost is not None else Decimal("0.0"),
                image_url=item.image_url,
                is_active=item.is_active if item.is_active is not None else True,
            )
            db.add(new_prod)
            created_count += 1

    db.commit()
    return {
        "status": "success",
        "created_count": created_count,
        "updated_count": updated_count,
        "total": created_count + updated_count,
        "message": f"Successfully imported {created_count} new and updated {updated_count} existing menu products."
    }


@router.post(
    "/products/import-images",
    summary="Import products by uploading image files (auto-naming from image filename)"
)
def import_products_from_images(
    files: List[UploadFile] = File(...),
    category_id: Optional[int] = Form(None),
    category_name: Optional[str] = Form(None),
    default_price: Decimal = Form(Decimal("99.0")),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manager_or_admin),
    tenant_id: int = Depends(get_manager_or_admin_tenant_id),
):
    current_dir = os.path.dirname(os.path.abspath(__file__))
    fastapi_static = os.path.join(os.path.dirname(os.path.dirname(current_dir)), "static", "images", "products")
    root_static = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(current_dir))), "static", "images", "products")

    for target_dir in [fastapi_static, root_static]:
        os.makedirs(target_dir, exist_ok=True)

    # Resolve category if category_name was provided
    target_category_id = category_id
    if not target_category_id and category_name and category_name.strip():
        c_name = category_name.strip()
        existing_cat = db.query(models.Category).filter(
            models.Category.tenant_id == tenant_id,
            models.Category.name.ilike(c_name)
        ).first()
        if existing_cat:
            target_category_id = existing_cat.id
        else:
            new_cat = models.Category(tenant_id=tenant_id, name=c_name)
            db.add(new_cat)
            db.flush()
            target_category_id = new_cat.id

    imported_items = []
    created_count = 0
    updated_count = 0

    for file in files:
        if not file.filename:
            continue
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in [".jpg", ".jpeg", ".png", ".webp", ".gif"]:
            continue

        derived_name = clean_product_name_from_filename(file.filename)
        if not derived_name:
            continue

        unique_name = f"prod_{uuid.uuid4().hex[:12]}{ext}"
        primary_file = None

        for target_dir in [fastapi_static, root_static]:
            try:
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

        image_url = f"/static/images/products/{unique_name}"

        # Generate SKU
        words = [w[0].upper() for w in derived_name.split() if w]
        prefix = "".join(words[:3]) if words else "PRD"
        if len(prefix) < 2:
            prefix = derived_name[:3].upper()
        sku = f"{prefix}-{uuid.uuid4().hex[:4].upper()}"

        existing = db.query(models.Product).filter(
            models.Product.tenant_id == tenant_id,
            models.Product.name.ilike(derived_name)
        ).first()

        if existing:
            existing.image_url = image_url
            if target_category_id:
                existing.category_id = target_category_id
            if default_price:
                existing.price = default_price
            existing.is_active = True
            updated_count += 1
            imported_items.append({"id": existing.id, "name": existing.name, "image_url": image_url, "action": "updated"})
        else:
            new_prod = models.Product(
                tenant_id=tenant_id,
                category_id=target_category_id,
                name=derived_name,
                sku=sku,
                price=default_price,
                cost=Decimal("0.0"),
                image_url=image_url,
                is_active=True
            )
            db.add(new_prod)
            created_count += 1
            imported_items.append({"name": derived_name, "image_url": image_url, "action": "created"})

    db.commit()
    return {
        "status": "success",
        "created_count": created_count,
        "updated_count": updated_count,
        "total": len(imported_items),
        "imported": imported_items,
        "message": f"Successfully processed {len(imported_items)} image products (Created: {created_count}, Updated: {updated_count})."
    }


