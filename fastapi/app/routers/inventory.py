"""
Inventory Router — Admin & Manager Module
==========================================
Tenant-scoped stock management for Branch Admins, Managers, and Inventory Officers.
Includes the Masterlist importer, inventory analytics, wastage logging and the stock-movement ledger.

Every quantity change goes through app/services/stock.py: row locks, Decimal arithmetic and a StockMovement row.
Items referenced by purchase orders, recipes or stock history are deactivated rather than deleted (H7).
"""
from decimal import Decimal
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core import audit
from app.core.dependencies import get_inventory_tenant_id, get_tenant_scope, require_permission
from app.seed import stable_code
from app.services import stock

router = APIRouter(tags=["Admin — Inventory"])

can_read_inventory = require_permission("inventory.read")
can_write_inventory = require_permission("inventory.write")

# Masterlist departments whose items are durable equipment rather than consumable stock (M5).
EQUIPMENT_DEPARTMENTS = {"Office Supplies and Equipments", "KITCHEN UTENSILS & EQUIPMENT", "FURNITURE & FIXTURES"}

# Complete Masterlist Data Dictionary categorized into 10 Department Modules
MASTERLIST_DATA: Dict[str, List[tuple]] = {
    "Kitchen": [
        ("Rice", "kg", 50, 10),
        ("Cooking oil", "L", 30, 5),
        ("Soy sauce", "L", 20, 4),
        ("Vinegar", "L", 20, 4),
        ("Salt", "kg", 15, 3),
        ("Iodized salt", "kg", 10, 2),
        ("Knorr", "packs", 25, 5),
        ("Crispy Fry", "packs", 30, 6),
        ("Knorr Creamy Mushroom", "packs", 20, 5),
        ("Sinigang Mix", "packs", 30, 5),
        ("Aji Shiro", "bottles", 15, 3),
        ("Gulaman", "packs", 20, 4),
        ("Baking soda", "boxes", 10, 2),
        ("Flour", "kg", 40, 8),
        ("Mayonaise", "jars", 15, 3),
        ("Ketchup", "bottles", 20, 4),
        ("Magic Sarap", "packs", 50, 10),
        ("Sesame Seeds", "kg", 5, 1),
        ("Tomato Paste", "cans", 25, 5),
        ("Cornbeef", "cans", 30, 6),
        ("Liquid Seasoning", "bottles", 20, 4),
        ("Fish Oil", "bottles", 15, 3),
        ("Spiracha Chili Sauce", "bottles", 15, 3),
        ("Pepper", "kg", 10, 2),
        ("Sugar", "kg", 30, 5),
        ("White Pepper Powder", "kg", 5, 1),
        ("Garlic", "kg", 20, 4),
        ("Onion", "kg", 25, 5),
        ("Ginger", "kg", 10, 2),
        ("Calamansi", "kg", 15, 3),
        ("Long green chili", "kg", 10, 2),
        ("Eggs", "trays", 20, 4),
        ("Pork", "kg", 35, 8),
        ("MilkFish", "kg", 20, 4),
        ("Chicken", "kg", 40, 8),
        ("Fried Garlic", "jars", 15, 3),
        ("Cheese Sauce", "bottles", 15, 3),
        ("Bread Crumbs", "packs", 20, 4),
        ("Corn", "cans", 25, 5),
        ("Cabbage", "kg", 20, 4),
        ("Condense", "cans", 30, 6),
        ("Century Tuna", "cans", 40, 8),
        ("Nacho Chips", "packs", 20, 4),
        ("Spaghetti pasta", "packs", 25, 5),
        ("Cheese Powder", "packs", 20, 4),
        ("Mama Sitas", "packs", 25, 5),
        ("Spiced Vinegar", "bottles", 20, 4),
        ("Molo/taochiam", "packs", 15, 3),
        ("Kropek", "packs", 20, 4),
        ("Sotanghon", "packs", 20, 4),
        ("Fries", "kg", 30, 6),
        ("Butter", "blocks", 20, 4),
        ("Ham", "packs", 25, 5),
        ("CDO Ulam Burger", "packs", 30, 6),
        ("Funtastyk Tocino", "packs", 25, 5),
        ("Longganisa", "packs", 25, 5),
        ("Lumpia", "packs", 30, 6),
        ("Nestle Cream", "cans", 30, 6),
        ("Carrots", "kg", 15, 3),
        ("Cabbages", "kg", 20, 4),
        ("Lettuce", "kg", 15, 3),
        ("Smoke Longganisa", "packs", 20, 4),
        ("Burger Buns", "packs", 30, 6)
    ],
    "Street Foods": [
        ("Fish balls", "packs", 30, 5),
        ("Squid balls", "packs", 30, 5),
        ("Kikiam", "packs", 30, 5),
        ("Tempura", "packs", 25, 5),
        ("Hotdog", "packs", 30, 6),
        ("Kropek", "packs", 20, 4),
        ("Cheese", "blocks", 15, 3),
        ("Lumpia Wrapper", "packs", 30, 6),
        ("Green Chili", "kg", 10, 2),
        ("Food Coloring", "bottles", 10, 2),
        ("Egg", "trays", 20, 4),
        ("Corn Starch", "kg", 20, 4),
        ("Flour", "kg", 30, 5),
        ("Fries", "kg", 25, 5),
        ("Barbecue Powder", "packs", 15, 3),
        ("Cheese Powder", "packs", 15, 3),
        ("Sour Cream Powder", "packs", 15, 3),
        ("Water", "gallons", 20, 4),
        ("Sugar", "kg", 20, 4),
        ("Red Chili", "kg", 10, 2),
        ("Ground Meat", "kg", 25, 5),
        ("Oil", "L", 25, 5)
    ],
    "Coffee Bar": [
        ("Coffee Powder", "kg", 20, 4),
        ("Caramel Syrup", "bottles", 15, 3),
        ("French Vanilla", "bottles", 15, 3),
        ("Salted Caramel", "bottles", 15, 3),
        ("Chocolate Syrup", "bottles", 15, 3),
        ("Vanilla Syrup", "bottles", 15, 3),
        ("Coconut Syrup", "bottles", 10, 2),
        ("Condense", "cans", 25, 5),
        ("Creamer", "kg", 25, 5),
        ("Whipped Cream (Baker’s Field)", "cans", 15, 3),
        ("Brown Sugar", "kg", 25, 5),
        ("Matcha Powder", "packs", 15, 3),
        ("Mango Powder", "packs", 15, 3),
        ("Choco Powder", "packs", 20, 4),
        ("Caramel Macchiato", "bottles", 12, 3),
        ("Coffee Crumble", "packs", 15, 3),
        ("Melon Powder", "packs", 15, 3),
        ("Buko Powder", "packs", 15, 3),
        ("Red Velvet", "packs", 15, 3),
        ("Taro", "packs", 15, 3),
        ("Watermelon", "packs", 12, 3),
        ("Cookies and Cream", "packs", 15, 3),
        ("Caramelize Sugar", "kg", 15, 3),
        ("Boba", "kg", 25, 5)
    ],
    "Beverages": [
        ("Bottled water", "bottles", 100, 20),
        ("Mt. Dew", "bottles", 48, 12),
        ("Coke 12oz", "bottles", 48, 12),
        ("Coke 1L", "bottles", 36, 8),
        ("Ginebra San Miguel (Round)", "bottles", 24, 6),
        ("Royal 12oz", "bottles", 48, 12),
        ("Sting", "bottles", 48, 12),
        ("Gold Eagle Beer", "bottles", 36, 8),
        ("Mule", "bottles", 36, 8),
        ("Pilsen", "bottles", 48, 12),
        ("San Mig Light", "bottles", 48, 12),
        ("San Mig Apple", "bottles", 48, 12),
        ("Red Horse (500)", "bottles", 48, 12),
        ("Red Horse 1L", "bottles", 36, 8),
        ("Red Horse (Stallion)", "bottles", 48, 12),
        ("Tanduay Light", "bottles", 24, 6),
        ("Tanduay Dark", "bottles", 24, 6),
        ("The Bar", "bottles", 24, 6),
        ("Soju", "bottles", 36, 8),
        ("GSM Blue", "bottles", 24, 6),
        ("CLVB 1L", "bottles", 24, 6),
        ("CLVB 1.5L", "bottles", 24, 6)
    ],
    "Packaging": [
        ("Plastic cups", "packs", 50, 10),
        ("Paper cups", "packs", 50, 10),
        ("Cup lids", "packs", 50, 10),
        ("Plastic bags", "packs", 40, 8),
        ("Paper bags", "packs", 40, 8),
        ("Food containers", "packs", 40, 8),
        ("Straw for milktea", "packs", 30, 6),
        ("Straw for Softdrinks", "packs", 30, 6),
        ("Straw for ice coffee", "packs", 30, 6),
        ("Tissue", "packs", 50, 10),
        ("Paper Food Box", "packs", 40, 8),
        ("Coffee Stirrer", "packs", 30, 6),
        ("Plastic Spoon", "packs", 50, 10),
        ("Plastic Fork", "packs", 50, 10),
        ("Chopsticks", "packs", 30, 6)
    ],
    "Cleaning Supplies": [
        ("Dishwashing liquid", "bottles", 20, 4),
        ("Bleach", "bottles", 15, 3),
        ("Disinfectant", "bottles", 15, 3),
        ("Hand soap", "bottles", 20, 4),
        ("Alcohol", "bottles", 25, 5),
        ("Sponges", "packs", 30, 6),
        ("Garbage bags", "rolls", 40, 8),
        ("Cleaning cloth", "packs", 25, 5),
        ("Mop", "pcs", 5, 2),
        ("Broom", "pcs", 6, 2),
        ("Dustpan", "pcs", 6, 2)
    ],
    "Office Supplies and Equipments": [
        ("Bond paper", "reams", 10, 2),
        ("Printer ink", "sets", 4, 1),
        ("Ballpens", "boxes", 8, 2),
        ("Permanent markers", "boxes", 6, 2),
        ("Highlighters", "boxes", 4, 1),
        ("Sticky Notes", "pads", 15, 3),
        ("Puncher", "pcs", 4, 1),
        ("Pins", "boxes", 6, 2),
        ("Paper Clips", "boxes", 8, 2),
        ("Binder Clips", "boxes", 8, 2),
        ("Stapler", "pcs", 5, 2),
        ("Staples", "boxes", 10, 2),
        ("Scissors", "pcs", 6, 2),
        ("Tape", "rolls", 15, 3),
        ("Folder", "packs", 10, 2),
        ("Plastic Envelopes", "packs", 10, 2),
        ("Envelopes", "boxes", 8, 2),
        ("Calculator", "pcs", 4, 1),
        ("Notebook", "pcs", 10, 2),
        ("Ruler", "pcs", 6, 2),
        ("White Board", "pcs", 2, 1),
        ("Cabinets", "units", 4, 1),
        ("Office Table", "units", 3, 1),
        ("Office Chairs", "units", 6, 2),
        ("Printer", "units", 2, 1),
        ("Desktop", "units", 2, 1),
        ("Laptop", "units", 2, 1),
        ("Laminator", "units", 1, 1),
        ("Aircon", "units", 2, 1),
        ("Paper Cutter", "units", 1, 1),
        ("Edge Trimmer", "units", 1, 1),
        ("Laminating film", "packs", 5, 1),
        ("File Organizer", "units", 4, 1),
        ("Bulletin Board", "units", 2, 1)
    ],
    "SAMGYUPSAL": [
        ("Pork Belly", "kg", 40, 10),
        ("Beef", "kg", 30, 8),
        ("Chicken", "kg", 30, 8),
        ("Marinated Meat", "kg", 35, 8),
        ("Lettuce", "kg", 20, 5),
        ("Kimchi", "kg", 25, 5),
        ("Radish", "kg", 15, 3),
        ("Pickled Papaya", "jars", 15, 3),
        ("Gochujang", "tubs", 15, 3),
        ("Salt & Pepper", "sets", 20, 4),
        ("Grill Pan", "pcs", 15, 3),
        ("Portable Stove", "pcs", 12, 3),
        ("Gas Canister", "cans", 40, 10),
        ("Tongs", "pcs", 25, 5),
        ("Meat Scissors", "pcs", 15, 3),
        ("Grill Plate", "pcs", 15, 3),
        ("Sauce Dishes", "sets", 50, 10),
        ("Small Side-Dish Plates", "sets", 50, 10),
        ("Disposable Gloves", "boxes", 20, 5),
        ("Food Trays", "pcs", 30, 6)
    ],
    "KITCHEN UTENSILS & EQUIPMENT": [
        ("Gas Stove", "units", 4, 1),
        ("Rice Cooker", "units", 3, 1),
        ("Frying Pan", "pcs", 6, 2),
        ("Wok", "pcs", 4, 1),
        ("Caldero / Cooking Pot", "pcs", 6, 2),
        ("Stock Pot", "pcs", 4, 1),
        ("Steamer", "pcs", 3, 1),
        ("Oven", "units", 1, 1),
        ("Microwave", "units", 2, 1),
        ("Blender", "units", 3, 1),
        ("Food Processor", "units", 2, 1),
        ("Refrigerator", "units", 2, 1),
        ("Freezer", "units", 2, 1),
        ("Chiller", "units", 2, 1),
        ("Cooking Spoon", "pcs", 10, 2),
        ("Ladle / Sandok", "pcs", 10, 2),
        ("Spatula", "pcs", 10, 2),
        ("Tongs", "pcs", 15, 3),
        ("Whisk", "pcs", 6, 2),
        ("Peeler", "pcs", 6, 2),
        ("Grater", "pcs", 6, 2),
        ("Strainer", "pcs", 6, 2),
        ("Can Opener", "pcs", 6, 2),
        ("Knife", "sets", 8, 2),
        ("Chopping Board", "pcs", 10, 2),
        ("Measuring Cup", "sets", 6, 2),
        ("Measuring Spoon", "sets", 6, 2),
        ("Mixing Bowl", "sets", 8, 2),
        ("Food Container", "sets", 20, 4),
        ("Colander", "pcs", 6, 2),
        ("Tray", "pcs", 15, 3),
        ("Serving Tray", "pcs", 15, 3),
        ("Food Tongs", "pcs", 15, 3),
        ("Kitchen Scissors", "pcs", 10, 2),
        ("Rolling Pin", "pcs", 4, 1)
    ],
    "FURNITURE & FIXTURES": [
        ("Dining Table", "units", 15, 2),
        ("Dining Chair", "units", 60, 10),
        ("Stool", "units", 20, 4),
        ("Folding Table", "units", 6, 2),
        ("Electric Fan", "units", 8, 2),
        ("Speaker", "units", 4, 1),
        ("TV", "units", 2, 1),
        ("Microphone", "units", 2, 1),
        ("Extensions", "pcs", 8, 2),
        ("Lights", "sets", 12, 2),
        ("Cabinet", "units", 4, 1),
        ("Storage Cabinet", "units", 4, 1),
        ("Shelving Rack", "units", 6, 1),
        ("Display Shelf", "units", 4, 1),
        ("Kitchen Rack", "units", 4, 1),
        ("Storage Rack", "units", 4, 1)
    ]
}


def _masterlist_entries():
    """Each item name once (first department wins), so names repeated across departments no longer overwrite
    each other's category on every import (M5)."""
    seen = set()
    for department, rows in MASTERLIST_DATA.items():
        for name, unit, default_qty, min_qty in rows:
            key = name.strip().lower()
            if key in seen:
                continue
            seen.add(key)
            yield department, name.strip(), unit, default_qty, min_qty


@router.get(
    "/inventory",
    response_model=List[schemas.InventoryItemResponse],
    summary="List stock items for the calling user's tenant"
)
def list_inventory(
    low_stock_only: bool = Query(False, description="If true, return only consumables at or below min_stock"),
    category: Optional[str] = Query(None, max_length=100, description="Filter by masterlist department category"),
    search: Optional[str] = Query(None, max_length=100, description="Partial match on item name or SKU"),
    item_type: Optional[str] = Query(None, pattern="^(consumable|equipment)$"),
    include_inactive: bool = Query(False),
    limit: int = Query(500, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_inventory),
    tenant_id: int = Depends(get_tenant_scope),
):
    q = db.query(models.InventoryItem).filter(models.InventoryItem.tenant_id == tenant_id)
    if not include_inactive:
        q = q.filter(models.InventoryItem.is_active.is_(True))
    if item_type:
        q = q.filter(models.InventoryItem.item_type == item_type)
    if category and category.strip():
        q = q.filter(models.InventoryItem.category.ilike(f"%{category.strip()}%"))
    if search:
        term = f"%{search.strip()}%"
        q = q.filter(
            models.InventoryItem.name.ilike(term) |
            models.InventoryItem.sku.ilike(term) |
            models.InventoryItem.category.ilike(term)
        )
    if low_stock_only:
        q = q.filter(
            models.InventoryItem.item_type != models.InventoryItemType.EQUIPMENT.value,
            models.InventoryItem.quantity <= models.InventoryItem.min_stock,
        )

    return q.order_by(models.InventoryItem.category, models.InventoryItem.name).limit(limit).all()


@router.post(
    "/inventory",
    response_model=schemas.InventoryItemResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a new raw ingredient or stock item (tenant auto-scoped)"
)
def create_inventory_item(
    body: schemas.InventoryItemCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    exists = db.query(models.InventoryItem.id).filter(
        models.InventoryItem.tenant_id == tenant_id,
        func.lower(models.InventoryItem.name) == body.name.lower(),
    ).first()
    if exists:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An inventory item named '{body.name}' already exists in your tenant."
        )

    item = models.InventoryItem(
        tenant_id=tenant_id,
        name=body.name,
        category=body.category.strip() if body.category else "Kitchen",
        sku=body.sku.strip() if body.sku else stable_code("INV", str(tenant_id), body.name.lower()),
        quantity=Decimal("0"),
        unit=body.unit,
        min_stock=body.min_stock,
        item_type=body.item_type,
    )
    db.add(item)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An inventory item named '{body.name}' already exists in your tenant."
        )
    if body.quantity > 0:
        stock.apply_movement(db, item, body.quantity, models.StockMovementType.OPENING, user=current_user,
                             reason="Opening stock")
    audit.record(db, current_user, "Inventory Item Created", tenant_id=tenant_id, details=f"{item.name} ({item.sku})")
    db.commit()
    db.refresh(item)
    return item


@router.post(
    "/inventory/import-masterlist",
    summary="1-Click Import Official Master List items into tenant inventory"
)
def import_masterlist(
    selected_category: Optional[str] = Query(None, description="Optional category filter to import"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """
    Adds the standard Masterlist items that are missing. Existing items are left exactly as they are (their
    category, unit and thresholds may have been customised), except that an unset unit or zero minimum is filled in.
    """
    if selected_category and selected_category not in MASTERLIST_DATA:
        raise HTTPException(status_code=422, detail=f"Unknown masterlist category '{selected_category}'.")

    existing_items: Dict[str, models.InventoryItem] = {
        item.name.strip().lower(): item
        for item in db.query(models.InventoryItem).filter(models.InventoryItem.tenant_id == tenant_id).all()
    }

    created_count = 0
    updated_count = 0
    unchanged_count = 0
    for department, name, unit, default_qty, min_qty in _masterlist_entries():
        if selected_category and department != selected_category:
            continue
        existing = existing_items.get(name.lower())
        if existing is not None:
            changed = False
            if not existing.unit:
                existing.unit = unit
                changed = True
            if Decimal(existing.min_stock) <= 0:
                existing.min_stock = Decimal(str(min_qty))
                changed = True
            updated_count += 1 if changed else 0
            unchanged_count += 0 if changed else 1
            continue

        item = models.InventoryItem(
            tenant_id=tenant_id,
            name=name,
            category=department,
            sku=stable_code(department[:3].upper(), department, name.lower(), length=6),
            quantity=Decimal("0"),
            unit=unit,
            min_stock=Decimal(str(min_qty)),
            item_type=(models.InventoryItemType.EQUIPMENT.value if department in EQUIPMENT_DEPARTMENTS
                       else models.InventoryItemType.CONSUMABLE.value),
        )
        db.add(item)
        db.flush()
        stock.apply_movement(db, item, Decimal(str(default_qty)), models.StockMovementType.OPENING,
                             user=current_user, reason="Masterlist import")
        existing_items[name.lower()] = item
        created_count += 1

    audit.record(db, current_user, "Master List Imported", tenant_id=tenant_id,
                 details=f"Imported Master List: {created_count} created, {updated_count} updated, "
                         f"{unchanged_count} unchanged.")
    db.commit()

    categories_imported = [selected_category] if selected_category else list(MASTERLIST_DATA.keys())
    return {
        "success": True,
        "message": f"Master list imported ({created_count} created, {updated_count} updated, {unchanged_count} unchanged).",
        "created_count": created_count,
        "updated_count": updated_count,
        "unchanged_count": unchanged_count,
        "categories_imported": categories_imported
    }


@router.get(
    "/inventory/analytics",
    summary="Automated Intelligent Inventory Analysis & Health Audit"
)
def get_inventory_analytics(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_inventory),
    tenant_id: int = Depends(get_tenant_scope),
):
    """
    Stock health of active consumables (equipment is excluded from low-stock alerts):
    health score, low/out-of-stock lists, per-category summary and prioritised restock list.
    """
    items = db.query(models.InventoryItem).filter(
        models.InventoryItem.tenant_id == tenant_id,
        models.InventoryItem.is_active.is_(True),
        models.InventoryItem.item_type != models.InventoryItemType.EQUIPMENT.value,
    ).all()

    total_items = len(items)
    out_of_stock = []
    low_stock = []
    healthy_stock = []
    category_summary: Dict[str, Dict[str, Any]] = {}

    for item in items:
        qty = Decimal(item.quantity)
        min_s = Decimal(item.min_stock)
        cat = item.category or "General Kitchen"

        if cat not in category_summary:
            category_summary[cat] = {"total_items": 0, "total_units": Decimal("0"), "low_stock": 0, "healthy": 0}

        category_summary[cat]["total_items"] += 1
        category_summary[cat]["total_units"] += qty

        item_dict = {
            "id": item.id,
            "name": item.name,
            "category": cat,
            "sku": item.sku,
            "quantity": str(qty),
            "unit": item.unit,
            "min_stock": str(min_s),
            "deficit": str(max(Decimal("0"), min_s - qty)),
        }

        if qty <= 0:
            out_of_stock.append(item_dict)
            category_summary[cat]["low_stock"] += 1
        elif qty <= min_s:
            low_stock.append(item_dict)
            category_summary[cat]["low_stock"] += 1
        else:
            healthy_stock.append(item_dict)
            category_summary[cat]["healthy"] += 1

    for summary in category_summary.values():
        summary["total_units"] = str(summary["total_units"])

    health_score = round((len(healthy_stock) / total_items * 100), 1) if total_items > 0 else 100.0
    urgent_restock = sorted(out_of_stock + low_stock, key=lambda x: Decimal(x["deficit"]), reverse=True)

    return {
        "total_items": total_items,
        "health_score": health_score,
        "healthy_count": len(healthy_stock),
        "low_stock_count": len(low_stock),
        "out_of_stock_count": len(out_of_stock),
        "urgent_restock": urgent_restock[:15],
        "category_summary": category_summary,
        "available_categories": list(MASTERLIST_DATA.keys())
    }


@router.put(
    "/inventory/{item_id}/stock",
    response_model=schemas.InventoryItemResponse,
    summary="Adjust stock quantity by a delta (positive = restock, negative = adjustment)"
)
def adjust_stock(
    item_id: int,
    body: schemas.InventoryStockAdjust,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    try:
        item = stock.lock_items(db, tenant_id, [item_id])[item_id]
    except HTTPException as exc:
        if exc.status_code == 404:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")
        raise
    old_qty = Decimal(item.quantity)
    try:
        stock.apply_movement(db, item, body.quantity_delta, models.StockMovementType.ADJUSTMENT,
                             user=current_user, reason=body.reason or "Manual Adjustment")
    except HTTPException:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Adjustment would result in negative stock ({old_qty + body.quantity_delta:.2f}). "
                   f"Current quantity: {old_qty:.2f}."
        )
    audit.record(db, current_user, "Stock Adjusted", tenant_id=tenant_id,
                 details=f"Item '{item.name}' stock adjusted from {old_qty:.2f} to {item.quantity:.2f} "
                         f"({body.reason or 'Manual Adjustment'})")
    db.commit()
    db.refresh(item)
    return item


def _references(db: Session, item: models.InventoryItem) -> List[str]:
    reasons = []
    if db.query(models.PurchaseOrderItem.id).filter(models.PurchaseOrderItem.inventory_item_id == item.id).first():
        reasons.append("purchase orders")
    if db.query(models.ProductRecipe.id).filter(models.ProductRecipe.inventory_item_id == item.id).first():
        reasons.append("product recipes")
    if db.query(models.StockMovement.id).filter(models.StockMovement.inventory_item_id == item.id).first():
        reasons.append("stock history")
    return reasons


@router.delete(
    "/inventory/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an unused inventory item (referenced items must be deactivated instead)"
)
def delete_inventory_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    references = _references(db, item)
    if references:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"'{item.name}' is used by {', '.join(references)} and cannot be deleted. Deactivate it instead.",
        )
    audit.record(db, current_user, "Inventory Item Deleted", tenant_id=tenant_id, details=item.name)
    db.delete(item)
    db.commit()
    return None


@router.put(
    "/inventory/{item_id}/status",
    response_model=schemas.InventoryItemResponse,
    summary="Activate or deactivate an inventory item"
)
def set_inventory_item_status(
    item_id: int,
    is_active: bool = Query(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id, models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")
    item.is_active = is_active
    audit.record(db, current_user, "Inventory Item " + ("Activated" if is_active else "Deactivated"),
                 tenant_id=tenant_id, details=item.name)
    db.commit()
    db.refresh(item)
    return item


# ──────────────────────────────────────────────────────────────────────────────
# WASTAGE (M12) and the stock-movement ledger (M6)
# ──────────────────────────────────────────────────────────────────────────────

def _wastage_view(movement: models.StockMovement, item: models.InventoryItem, user: Optional[models.User]):
    quantity = abs(Decimal(movement.quantity_delta)).quantize(Decimal("0.01"))
    cost = (Decimal(movement.unit_cost) * quantity).quantize(Decimal("0.01")) if movement.unit_cost is not None else None
    reason, _, _ = (movement.reason or "").partition(" | ")
    return schemas.WastageResponse(
        id=movement.id, inventory_item_id=item.id, item=item.name, unit=item.unit, quantity=quantity,
        reason=reason, estimated_cost=cost, logged_by=user.username if user else None, created_at=movement.created_at,
    )


@router.get("/inventory/wastage", response_model=List[schemas.WastageResponse])
def list_wastage(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_inventory),
    tenant_id: int = Depends(get_tenant_scope),
):
    rows = (
        db.query(models.StockMovement, models.InventoryItem, models.User)
        .join(models.InventoryItem, models.InventoryItem.id == models.StockMovement.inventory_item_id)
        .outerjoin(models.User, models.User.id == models.StockMovement.user_id)
        .filter(
            models.StockMovement.tenant_id == tenant_id,
            models.StockMovement.movement_type == models.StockMovementType.WASTAGE.value,
        )
        .order_by(models.StockMovement.created_at.desc(), models.StockMovement.id.desc())
        .limit(limit)
        .all()
    )
    return [_wastage_view(m, i, u) for m, i, u in rows]


@router.post("/inventory/wastage", response_model=schemas.WastageResponse, status_code=status.HTTP_201_CREATED)
def record_wastage(
    body: schemas.WastageCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """Records spoilage/wastage and deducts it from stock in the same transaction."""
    item = stock.lock_items(db, tenant_id, [body.inventory_item_id])[body.inventory_item_id]
    unit_cost = (body.estimated_cost / body.quantity).quantize(Decimal("0.01")) if body.estimated_cost is not None else None
    reason = body.reason + (f" | {body.notes.strip()}" if body.notes and body.notes.strip() else "")
    movement = stock.apply_movement(
        db, item, -body.quantity, models.StockMovementType.WASTAGE, user=current_user,
        reason=reason, unit_cost=unit_cost,
    )
    audit.record(db, current_user, "Wastage Recorded", tenant_id=tenant_id,
                 details=f"{body.quantity} {item.unit} of '{item.name}': {body.reason}")
    db.commit()
    db.refresh(movement)
    return _wastage_view(movement, item, current_user)


@router.get("/inventory/{item_id}/movements", response_model=List[schemas.StockMovementResponse])
def list_stock_movements(
    item_id: int,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_inventory),
    tenant_id: int = Depends(get_tenant_scope),
):
    item = db.query(models.InventoryItem.id).filter(
        models.InventoryItem.id == item_id, models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")
    return (
        db.query(models.StockMovement)
        .filter(models.StockMovement.inventory_item_id == item_id)
        .order_by(models.StockMovement.created_at.desc(), models.StockMovement.id.desc())
        .limit(limit)
        .all()
    )
