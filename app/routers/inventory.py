"""
Inventory Router — Admin & Manager Module
==========================================
Tenant-scoped stock management for Branch Admins, Managers, and Inventory Officers.
Includes Masterlist Batch Importer and Automated Inventory Analytics.
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query, File, UploadFile, Form
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func
from typing import List, Optional, Dict, Any
from decimal import Decimal
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
import time
import io
import zipfile
import csv
import xml.etree.ElementTree as ET

from app.db import get_db
import app.models as models
import app.schemas as schemas
from app.core.dependencies import require_inventory_access, get_inventory_tenant_id, get_current_user, require_admin, require_admin_or_inventory


def parse_masterlist_file(file_bytes: bytes, filename: str) -> Dict[str, List[Dict[str, Any]]]:
    fn = filename.lower()
    departments: Dict[str, List[Dict[str, Any]]] = {}

    if fn.endswith('.docx'):
        try:
            with zipfile.ZipFile(io.BytesIO(file_bytes)) as z:
                # Checked before reading so a small "zip bomb" cannot expand into a huge document in memory.
                if z.getinfo('word/document.xml').file_size > MAX_DOCX_XML_BYTES:
                    raise ValueError("the document text is too large")
                xml_content = z.read('word/document.xml')
            root = ET.fromstring(xml_content)
            w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

            current_dept = "General"
            subheaders = {'cooking equipment', 'kitchen utensils', 'kitchen tools', 'storage', 'masterlist'}

            for p in root.iter(w + 'p'):
                texts = [node.text for node in p.iter(w + 't') if node.text]
                line = ''.join(texts).strip()
                if not line:
                    continue

                bolds = p.findall(f'.//{w}b')
                is_bold = len(bolds) > 0

                clean_line = line.replace(' (ok)', '').strip()
                if 'packaging' in clean_line.lower():
                    clean_line = 'Packaging'

                if clean_line.lower() == 'masterlist':
                    continue

                if is_bold:
                    if clean_line.lower() in subheaders:
                        continue
                    current_dept = clean_line
                    if current_dept not in departments:
                        departments[current_dept] = []
                else:
                    item_name = line.replace('Bakers', "Baker's").strip()
                    if item_name:
                        if current_dept not in departments:
                            departments[current_dept] = []
                        
                        dept_lower = current_dept.lower()
                        if 'beverage' in dept_lower or 'coffee' in dept_lower:
                            unit = "bottles" if any(k in item_name.lower() for k in ['water', 'coke', 'beer', 'syrup', 'soju']) else "kg" if any(k in item_name.lower() for k in ['powder', 'sugar', 'boba']) else "cans" if 'condense' in item_name.lower() or 'cream' in item_name.lower() else "units"
                        elif 'bill' in dept_lower:
                            unit = "bills"
                        elif 'salary' in dept_lower:
                            unit = "payouts"
                        elif 'utensil' in dept_lower or 'equipment' in dept_lower or 'furniture' in dept_lower:
                            unit = "sets" if any(k in item_name.lower() for k in ['knife', 'measuring', 'lights']) else "units"
                        elif 'office' in dept_lower:
                            unit = "boxes" if any(k in item_name.lower() for k in ['pen', 'clip', 'staple', 'marker']) else "reams" if 'paper' in item_name.lower() else "units"
                        else:
                            unit = "kg" if any(k in item_name.lower() for k in ['meat', 'pork', 'beef', 'chicken', 'rice', 'sugar', 'salt', 'flour', 'onion', 'garlic']) else "L" if 'oil' in item_name.lower() or 'sauce' in item_name.lower() or 'vinegar' in item_name.lower() else "packs"

                        departments[current_dept].append({
                            "name": item_name,
                            "unit": unit,
                            "min_stock": 5.0
                        })
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse Word document: {str(e)}")

    elif fn.endswith('.csv') or fn.endswith('.txt'):
        try:
            text = file_bytes.decode('utf-8', errors='ignore')
            lines = [l.strip() for l in text.splitlines() if l.strip()]
            header = None
            start_idx = 0
            if lines:
                first_cols = [c.strip().lower() for c in lines[0].split(',')]
                if any(col in ['name', 'item', 'item name', 'department', 'category'] for col in first_cols):
                    header = first_cols
                    start_idx = 1
            
            current_dept = "General"
            for i in range(start_idx, len(lines)):
                row = [c.strip() for c in lines[i].split(',')]
                if not row or not any(row):
                    continue
                if len(row) == 1 and ((row[0].startswith('[') and row[0].endswith(']')) or row[0].endswith(':')):
                    current_dept = row[0].strip('[]: ')
                    continue
                
                if header:
                    row_dict = {header[idx]: row[idx] for idx in range(min(len(header), len(row)))}
                    name = row_dict.get('item name') or row_dict.get('name') or row_dict.get('item') or row[0]
                    category = row_dict.get('department') or row_dict.get('category') or current_dept
                    unit = row_dict.get('unit') or "units"
                    try:
                        min_stock = float(row_dict.get('min_stock', 5.0) or 5.0)
                    except:
                        min_stock = 5.0
                else:
                    name = row[0]
                    category = row[1] if len(row) > 1 and row[1] else current_dept
                    unit = row[2] if len(row) > 2 and row[2] else "units"
                    try:
                        min_stock = float(row[3]) if len(row) > 3 and row[3] else 5.0
                    except:
                        min_stock = 5.0
                
                if not name:
                    continue
                if category not in departments:
                    departments[category] = []
                departments[category].append({
                    "name": name,
                    "unit": unit,
                    "min_stock": min_stock
                })
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse text/CSV file: {str(e)}")
    else:
        raise HTTPException(status_code=400, detail="Unsupported file format. Please upload a .docx, .csv, or .txt file.")

    return departments


MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024      # masterlist upload (.docx / .csv / .txt)
MAX_DOCX_XML_BYTES = 10 * 1024 * 1024        # uncompressed word/document.xml inside a .docx
IMPORT_FILE_EXTENSIONS = ('.docx', '.csv', '.txt')


async def read_masterlist_upload(file: UploadFile) -> bytes:
    """Read a masterlist upload in chunks, refusing a missing/unsupported name (400), more than 5 MB (413) or an empty file (400)."""
    if not file.filename or not file.filename.lower().endswith(IMPORT_FILE_EXTENSIONS):
        raise HTTPException(status_code=400, detail="Unsupported file format. Please upload a .docx, .csv, or .txt file.")
    chunks, total = [], 0
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_IMPORT_FILE_BYTES:
            raise HTTPException(status_code=413, detail="The file is too large (max 5 MB).")
        chunks.append(chunk)
    if not chunks:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    return b"".join(chunks)


router = APIRouter(tags=["Admin — Inventory"])

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
    "Monthly Bills": [
        ("Electricity", "bills", 1, 1),
        ("Water", "bills", 1, 1),
        ("Internet", "bills", 1, 1),
        ("Rent", "bills", 1, 1),
        ("Phone/load", "bills", 1, 1)
    ],
    "Employee Salary": [
        ("Weekly Payroll", "payouts", 1, 1),
        ("15th and 30th Payroll", "payouts", 1, 1)
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


@router.get(
    "/inventory",
    response_model=List[schemas.InventoryItemResponse],
    summary="List all stock items for the calling user's tenant"
)
def list_inventory(
    low_stock_only: bool = Query(False, description="If true, return only items at or below min_stock"),
    category: Optional[str] = Query(None, description="Filter by masterlist department category"),
    search: Optional[str] = Query(None, description="Partial match on item name or SKU"),
    limit: int = Query(500, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
):
    q = db.query(models.InventoryItem)
    if current_user.tenant_id:
        q = q.filter(models.InventoryItem.tenant_id == current_user.tenant_id)
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
        q = q.filter(models.InventoryItem.quantity <= models.InventoryItem.min_stock)

    items = q.order_by(models.InventoryItem.category, models.InventoryItem.name).limit(limit).all()

    # Determine current calendar date in Asia/Manila for Daily Inventory Input System
    manila_tz = ZoneInfo("Asia/Manila")
    today_manila = datetime.now(manila_tz).date()
    next_date_str = (today_manila + timedelta(days=1)).strftime("%B %d, %Y 12:00 AM")

    # Fetch all daily inventory submissions for today within caller's tenant
    daily_q = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.inventory_date == today_manila
    )
    if current_user.tenant_id:
        daily_q = daily_q.filter(models.DailyInventoryRecord.tenant_id == current_user.tenant_id)
    daily_records = daily_q.all()
    daily_map = {r.inventory_item_id: r for r in daily_records}

    # Fetch previous records (prior to today) to provide previous stock history
    prev_q = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.inventory_date < today_manila
    )
    if current_user.tenant_id:
        prev_q = prev_q.filter(models.DailyInventoryRecord.tenant_id == current_user.tenant_id)
    prev_records = prev_q.order_by(models.DailyInventoryRecord.inventory_date.desc(), models.DailyInventoryRecord.submitted_at.desc()).all()
    prev_map = {}
    for r in prev_records:
        if r.inventory_item_id not in prev_map:
            prev_map[r.inventory_item_id] = r

    for it in items:
        rec = daily_map.get(it.id)
        prev_rec = prev_map.get(it.id)

        if prev_rec:
            it.previous_stock = Decimal(str(prev_rec.current_stock))
            it.previous_stock_date = str(prev_rec.inventory_date)
            it.has_previous_stock = True
        else:
            it.previous_stock = None
            it.previous_stock_date = None
            it.has_previous_stock = False

        is_locked = bool(getattr(it, "stock_entry_locked", False))
        if rec:
            it.daily_input_submitted_at = rec.submitted_at
            it.daily_input_submitted_by = rec.submitter.username if rec.submitter else "Staff"
            it.daily_input_date = str(rec.inventory_date)
        else:
            it.daily_input_submitted_at = None
            it.daily_input_submitted_by = None
            it.daily_input_date = str(today_manila)

        if is_locked:
            it.daily_input_status = "Stock Entry Locked"
            it.daily_input_submitted = True
            it.next_available_input_date = None
        else:
            it.daily_input_status = "Pending Stock Entry"
            it.daily_input_submitted = False
            it.next_available_input_date = None

    return items


@router.post(
    "/inventory",
    response_model=schemas.InventoryItemResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a new raw ingredient or stock item (tenant auto-scoped)"
)
def create_inventory_item(
    body: schemas.InventoryItemCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    item = models.InventoryItem(
        tenant_id=tenant_id,
        name=body.name.strip(),
        category=body.category.strip() if body.category else "Kitchen",
        sku=body.sku.strip() if (body.sku and body.sku.strip()) else None,
        quantity=body.quantity,
        unit=(body.unit.strip() if body.unit and body.unit.strip() else "pcs"),
        min_stock=body.min_stock,
        unit_price=Decimal(str(body.unit_price or 0.0)),
    )
    db.add(item)
    try:
        db.commit()
        db.refresh(item)
        try:
            from app.core.websocket import notify_realtime_event
            notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
                "action": "created",
                "item_id": item.id,
                "name": item.name,
                "quantity": float(item.quantity)
            })
        except Exception:
            pass
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An inventory item named '{body.name}' already exists in your tenant."
        )
    return item


@router.post(
    "/inventory/import-masterlist",
    summary="1-Click Import Official Master List items into tenant inventory"
)
def import_masterlist(
    selected_category: Optional[str] = Query(None, description="Optional category filter to import"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """
    Imports standard Masterlist items (Kitchen, Street Foods, Coffee Bar, Beverages, Packaging, etc.).
    Preserves existing items while updating category metadata or initializing default quantities.
    """
    categories_to_import = [selected_category] if selected_category and selected_category in MASTERLIST_DATA else list(MASTERLIST_DATA.keys())
    
    # Load existing items into lookup dict
    existing_items: Dict[str, models.InventoryItem] = {
        item.name.strip().lower(): item 
        for item in db.query(models.InventoryItem).filter(models.InventoryItem.tenant_id == tenant_id).all()
    }
    
    created_count = 0
    updated_count = 0

    for cat in categories_to_import:
        for name, unit, default_qty, min_qty in MASTERLIST_DATA[cat]:
            key = name.strip().lower()

            if key in existing_items:
                existing = existing_items[key]
                existing.category = cat
                if not existing.unit:
                    existing.unit = unit
                if existing.min_stock <= 0:
                    existing.min_stock = Decimal(str(min_qty))
                updated_count += 1
            else:
                sku_code = f"{cat[:3].upper()}-{abs(hash(name)) % 10000:04d}"
                # If importing from master list, do NOT add arbitrary stock; only import item name and metadata
                new_item = models.InventoryItem(
                    tenant_id=tenant_id,
                    name=name.strip(),
                    category=cat,
                    sku=sku_code,
                    quantity=Decimal("0.0"),
                    unit=unit,
                    min_stock=Decimal(str(min_qty))
                )
                db.add(new_item)
                existing_items[key] = new_item
                created_count += 1

    db.commit()

    # Log action in activity logs
    log = models.ActivityLog(
        tenant_id=tenant_id,
        user_id=current_user.id,
        action="Master List Imported",
        performed_by=current_user.username,
        role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=f"Imported Master List: {created_count} items created, {updated_count} updated."
    )
    db.add(log)
    db.commit()

    return {
        "success": True,
        "message": f"Successfully imported master list items ({created_count} created with 0 initial stock, {updated_count} synced).",
        "created_count": created_count,
        "updated_count": updated_count,
        "categories_imported": categories_to_import
    }


@router.post(
    "/inventory/import-custom",
    summary="Import custom master list of items (CSV or array)"
)
def import_custom_items(
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    items = body.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items provided to import")

    existing_items: Dict[str, models.InventoryItem] = {
        item.name.strip().lower(): item 
        for item in db.query(models.InventoryItem).filter(models.InventoryItem.tenant_id == tenant_id).all()
    }

    created_count = 0
    updated_count = 0

    for it in items:
        name = str(it.get("name", "")).strip()
        if not name:
            continue
        key = name.lower()
        category = str(it.get("category", "Kitchen")).strip() or "Kitchen"
        unit = str(it.get("unit", "units")).strip() or "units"
        
        # If no current stock is provided or empty in import list, DO NOT add stock! Default to 0.0
        raw_qty = it.get("quantity")
        if raw_qty is None or str(raw_qty).strip() == "":
            quantity = Decimal("0.0")
        else:
            try:
                quantity = Decimal(str(raw_qty))
            except:
                quantity = Decimal("0.0")

        try:
            min_stock = Decimal(str(it.get("min_stock", 0.0) or 0.0))
        except:
            min_stock = Decimal("0.0")

        if key in existing_items:
            existing = existing_items[key]
            existing.category = category
            if unit and not existing.unit:
                existing.unit = unit
            # Only update stock if explicitly provided in import file
            if raw_qty is not None and str(raw_qty).strip() != "":
                existing.quantity = quantity
            updated_count += 1
        else:
            sku_code = f"{category[:3].upper()}-{abs(hash(name)) % 10000:04d}"
            new_item = models.InventoryItem(
                tenant_id=tenant_id,
                name=name,
                category=category,
                sku=sku_code,
                quantity=quantity,
                unit=unit,
                min_stock=min_stock
            )
            db.add(new_item)
            existing_items[key] = new_item
            created_count += 1

    db.commit()
    return {
        "success": True,
        "message": f"Successfully imported {created_count} items ({updated_count} existing synced).",
        "created_count": created_count,
        "updated_count": updated_count
    }


@router.post(
    "/inventory/parse-file",
    summary="Parse an uploaded masterlist file (.docx, .csv, .txt) and return preview of departments and items"
)
async def parse_inventory_file(
    file: UploadFile = File(...),
    current_user: models.User = Depends(require_inventory_access),
):
    content = await read_masterlist_upload(file)
    
    depts = parse_masterlist_file(content, file.filename)
    total_items = sum(len(items) for items in depts.values())
    return {
        "success": True,
        "filename": file.filename,
        "total_items": total_items,
        "departments": depts
    }


@router.post(
    "/inventory/import-file",
    summary="Import items from an uploaded masterlist file directly into database (0 initial stock)"
)
async def import_inventory_file(
    file: UploadFile = File(...),
    department: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    content = await read_masterlist_upload(file)
    
    depts = parse_masterlist_file(content, file.filename)
    if not depts:
        raise HTTPException(status_code=400, detail="No departments or items could be found in the uploaded file.")
    
    # Filter by specific department if requested by user
    if department and department.strip() and department.strip().upper() != "ALL":
        target_dept = department.strip()
        matched_key = next((k for k in depts.keys() if k.lower() == target_dept.lower()), None)
        if not matched_key:
            raise HTTPException(status_code=404, detail=f"Department '{target_dept}' not found in the uploaded file.")
        depts_to_import = {matched_key: depts[matched_key]}
    else:
        depts_to_import = depts

    existing_items: Dict[str, models.InventoryItem] = {
        item.name.strip().lower(): item 
        for item in db.query(models.InventoryItem).filter(models.InventoryItem.tenant_id == tenant_id).all()
    }

    created_count = 0
    updated_count = 0

    for cat, items in depts_to_import.items():
        for it in items:
            name = str(it.get("name", "")).strip()
            if not name:
                continue
            key = name.lower()
            unit = str(it.get("unit", "units")).strip() or "units"
            min_stock = Decimal(str(it.get("min_stock", 5.0) or 5.0))

            if key in existing_items:
                existing = existing_items[key]
                existing.category = cat
                if not existing.unit:
                    existing.unit = unit
                if existing.min_stock <= 0:
                    existing.min_stock = min_stock
                updated_count += 1
            else:
                sku_code = f"{cat[:3].upper()}-{abs(hash(name)) % 10000:04d}"
                new_item = models.InventoryItem(
                    tenant_id=tenant_id,
                    name=name,
                    category=cat,
                    sku=sku_code,
                    quantity=Decimal("0.0"),  # Zero initial stock rule
                    unit=unit,
                    min_stock=min_stock,
                    unit_price=Decimal("0.0")
                )
                db.add(new_item)
                existing_items[key] = new_item
                created_count += 1

    db.commit()

    # Log action in activity logs
    log = models.ActivityLog(
        tenant_id=tenant_id,
        user_id=current_user.id,
        action="File Master List Imported",
        performed_by=current_user.username,
        role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=f"Imported file '{file.filename}': {created_count} items created with 0 stock in DB, {updated_count} synced."
    )
    db.add(log)
    db.commit()

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
            "action": "imported",
            "created_count": created_count,
            "updated_count": updated_count
        })
    except Exception:
        pass

    return {
        "success": True,
        "message": f"Successfully imported {created_count} items from '{file.filename}' directly into database with 0 initial stock ({updated_count} synced).",
        "created_count": created_count,
        "updated_count": updated_count,
        "departments_imported": list(depts_to_import.keys())
    }


@router.post(
    "/inventory/bulk-delete",
    summary="Bulk delete multiple inventory items",
    response_model=schemas.BulkDeleteInventoryResponse
)
def bulk_delete_inventory(
    payload: schemas.BulkDeleteInventoryRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    if not payload.item_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No inventory item IDs specified for deletion."
        )

    from sqlalchemy import text

    # Remove duplicates while preserving order
    unique_ids = list(dict.fromkeys(payload.item_ids))

    # Fetch existing items for this tenant
    items = db.query(models.InventoryItem).filter(
        models.InventoryItem.id.in_(unique_ids),
        models.InventoryItem.tenant_id == tenant_id
    ).all()

    found_map = {item.id: item for item in items}
    deleted_ids = []
    failed_ids = []
    errors = []

    for item_id in unique_ids:
        if item_id not in found_map:
            failed_ids.append(item_id)
            errors.append({"id": item_id, "reason": "Item not found or unauthorized."})
            continue

        item = found_map[item_id]
        item_name = item.name

        try:
            # Clean up foreign key references in child tables
            db.execute(text("DELETE FROM purchase_order_items WHERE inventory_item_id = :item_id"), {"item_id": item_id})
            db.execute(text("DELETE FROM product_recipes WHERE inventory_item_id = :item_id"), {"item_id": item_id})
            db.flush()

            db.delete(item)
            db.flush()
            deleted_ids.append(item_id)
        except Exception as ex:
            failed_ids.append(item_id)
            errors.append({"id": item_id, "name": item_name, "reason": str(ex)})

    # Commit all successful deletions in this batch
    if deleted_ids:
        db.commit()
        try:
            from app.core.websocket import notify_realtime_event
            notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
                "action": "bulk_deleted",
                "deleted_ids": deleted_ids,
                "count": len(deleted_ids)
            })
        except Exception:
            pass
    else:
        db.rollback()

    if not deleted_ids and failed_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to delete items: {'; '.join(e.get('reason', '') for e in errors)}"
        )

    msg = f"Successfully deleted {len(deleted_ids)} inventory item(s)."
    if failed_ids:
        msg += f" {len(failed_ids)} item(s) could not be deleted."

    return {
        "success": True,
        "deleted_ids": deleted_ids,
        "failed_ids": failed_ids,
        "deleted_count": len(deleted_ids),
        "message": msg,
        "errors": errors
    }


@router.delete(
    "/inventory/{item_id}",
    summary="Delete an inventory item"
)
def delete_inventory_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    from sqlalchemy import text
    try:
        db.execute(text("DELETE FROM purchase_order_items WHERE inventory_item_id = :item_id"), {"item_id": item_id})
        db.execute(text("DELETE FROM product_recipes WHERE inventory_item_id = :item_id"), {"item_id": item_id})
        db.flush()
    except Exception:
        pass

    item_name = item.name
    deleted_id = item.id
    db.delete(item)
    db.commit()

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
            "action": "deleted",
            "item_id": deleted_id,
            "name": item_name
        })
    except Exception:
        pass

    return {"success": True, "message": f"Inventory item '{item_name}' deleted successfully."}


@router.get(
    "/inventory/analytics",
    summary="Automated Intelligent Inventory Analysis & Health Audit"
)
def get_inventory_analytics(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """
    Computes automated inventory metrics:
    - Overall stock health score percentage
    - Total items, low stock warnings, out of stock alerts
    - Category-wise distribution and shortages
    - Prioritized restock recommendations
    """
    items = db.query(models.InventoryItem).filter(
        models.InventoryItem.tenant_id == tenant_id
    ).all()

    total_items = len(items)
    out_of_stock = []
    low_stock = []
    healthy_stock = []
    category_summary: Dict[str, Dict[str, Any]] = {}

    for item in items:
        qty = float(item.quantity)
        min_s = float(item.min_stock)
        cat = item.category or "General Kitchen"

        if cat not in category_summary:
            category_summary[cat] = {"total_items": 0, "total_units": 0.0, "low_stock": 0, "healthy": 0}

        category_summary[cat]["total_items"] += 1
        category_summary[cat]["total_units"] += qty

        item_dict = {
            "id": item.id,
            "name": item.name,
            "category": cat,
            "sku": item.sku,
            "quantity": qty,
            "unit": item.unit,
            "min_stock": min_s,
            "deficit": max(0.0, min_s - qty)
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

    # Compute Health Score Percentage (0-100%)
    health_score = round((len(healthy_stock) / total_items * 100), 1) if total_items > 0 else 100.0

    # Sort urgent restock list by highest deficit
    urgent_restock = sorted(out_of_stock + low_stock, key=lambda x: x["deficit"], reverse=True)
    total_valuation = sum(float(item.quantity) * float(item.unit_price or 0.0) for item in items)

    return {
        "total_items": total_items,
        "health_score": health_score,
        "healthy_count": len(healthy_stock),
        "low_stock_count": len(low_stock),
        "out_of_stock_count": len(out_of_stock),
        "total_valuation": round(total_valuation, 2),
        "urgent_restock": urgent_restock[:15],
        "category_summary": category_summary,
        "available_categories": list(MASTERLIST_DATA.keys())
    }


@router.get(
    "/inventory/overall-history",
    summary="Get overall previous stock history for all items (excludes current new update, only shows previous stock)"
)
def get_overall_inventory_history(
    limit_per_item: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """
    Returns overall list of items with their previous stock updates.
    Strictly excludes the latest/current new update stock.
    Items that have never had a stock update are excluded.
    """
    import re

    items = db.query(models.InventoryItem).filter(models.InventoryItem.tenant_id == tenant_id).all()
    item_map = {it.id: it for it in items}
    item_name_map = {it.name.strip().lower(): it for it in items}

    # 1. Fetch DailyInventoryRecord
    records = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.tenant_id == tenant_id
    ).order_by(models.DailyInventoryRecord.inventory_date.desc(), models.DailyInventoryRecord.submitted_at.desc()).all()

    daily_by_item: Dict[int, list] = {}
    for r in records:
        daily_by_item.setdefault(r.inventory_item_id, []).append(r)

    # 2. Fetch ActivityLog stock adjustments
    stock_logs = db.query(models.ActivityLog).filter(
        models.ActivityLog.tenant_id == tenant_id,
        models.ActivityLog.action.like("%Stock%")
    ).order_by(models.ActivityLog.created_at.desc()).all()

    log_pattern = re.compile(r"Item '(.*?)' stock adjusted from ([\d\.]+) to ([\d\.]+)")
    logs_by_item: Dict[int, list] = {}
    for l in stock_logs:
        m = log_pattern.search(l.details or "")
        if m:
            name, old_q, new_q = m.groups()
            matched_it = item_name_map.get(name.strip().lower())
            if matched_it:
                logs_by_item.setdefault(matched_it.id, []).append({
                    "old_stock": float(old_q),
                    "new_stock": float(new_q),
                    "timestamp": l.created_at,
                    "submitted_by": l.performed_by or "Staff",
                    "details": l.details
                })

    # 3. Fetch StockMovement rows
    movements = db.query(models.StockMovement).filter(
        models.StockMovement.tenant_id == tenant_id
    ).order_by(models.StockMovement.created_at.desc()).all()

    movements_by_item: Dict[int, list] = {}
    for m in movements:
        movements_by_item.setdefault(m.inventory_item_id, []).append(m)

    results = []
    for item_id, it in item_map.items():
        daily_list = daily_by_item.get(item_id, [])
        log_list = logs_by_item.get(item_id, [])
        mov_list = movements_by_item.get(item_id, [])

        # If item has NEVER had any stock update/adjustment, it must NOT appear in history
        # "if not update the stock of inventory not see in the history of inventory"
        if not daily_list and not log_list and not mov_list:
            continue

        # If it only has 1 daily record and no logs/movements, check if that daily record is just initial/new without updates
        if len(daily_list) <= 1 and not log_list and not mov_list:
            continue

        previous_stock_val = None
        previous_unit_price = float(it.unit_price or 0.0)
        previous_date = None
        previous_submitted_at = None
        previous_submitted_by = "Staff"
        all_previous_records = []

        # Case A: Activity logs or Stock movements are present (captures exact inline/modal stock adjustments)
        if log_list:
            # log_list[0] is the most recent update. Its old_stock is the PREVIOUS stock before this new update!
            # The new update stock (new_stock) is EXCLUDED.
            previous_stock_val = log_list[0]["old_stock"]
            previous_submitted_at = log_list[0]["timestamp"].isoformat() if log_list[0]["timestamp"] else None
            previous_date = str(log_list[0]["timestamp"].date()) if log_list[0]["timestamp"] else None
            previous_submitted_by = log_list[0]["submitted_by"]

            # Subsequent logs show older previous stock levels
            for entry in log_list[:limit_per_item]:
                all_previous_records.append({
                    "id": f"log-{entry['timestamp']}",
                    "previous_stock": entry["old_stock"],
                    "unit_price": previous_unit_price,
                    "inventory_date": str(entry["timestamp"].date()) if entry["timestamp"] else None,
                    "submitted_at": entry["timestamp"].isoformat() if entry["timestamp"] else None,
                    "submitted_by_username": entry["submitted_by"]
                })
        elif mov_list:
            # mov_list[0] is the newest movement. Its previous stock is quantity_after - quantity_delta
            newest_mov = mov_list[0]
            previous_stock_val = float(newest_mov.quantity_after) - float(newest_mov.quantity_delta)
            previous_submitted_at = newest_mov.created_at.isoformat() if newest_mov.created_at else None
            previous_date = str(newest_mov.created_at.date()) if newest_mov.created_at else None
            previous_submitted_by = "Staff"
            for mov in mov_list[:limit_per_item]:
                all_previous_records.append({
                    "id": mov.id,
                    "previous_stock": float(mov.quantity_after) - float(mov.quantity_delta),
                    "unit_price": float(mov.unit_cost or previous_unit_price),
                    "inventory_date": str(mov.created_at.date()) if mov.created_at else None,
                    "submitted_at": mov.created_at.isoformat() if mov.created_at else None,
                    "submitted_by_username": "Staff"
                })
        elif len(daily_list) > 1:
            # daily_list[0] is the current / new update stock -> EXCLUDED
            # daily_list[1] is the last updated previous stock
            prev_latest = daily_list[1]
            previous_stock_val = float(prev_latest.current_stock)
            previous_unit_price = float(prev_latest.unit_price)
            previous_date = str(prev_latest.inventory_date)
            previous_submitted_at = prev_latest.submitted_at.isoformat() if prev_latest.submitted_at else None
            previous_submitted_by = prev_latest.submitter.username if prev_latest.submitter else "Staff"
            for r in daily_list[1:1 + limit_per_item]:
                all_previous_records.append({
                    "id": r.id,
                    "previous_stock": float(r.current_stock),
                    "unit_price": float(r.unit_price),
                    "inventory_date": str(r.inventory_date),
                    "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
                    "submitted_by_username": r.submitter.username if r.submitter else "Staff"
                })

        if previous_stock_val is not None:
            results.append({
                "item_id": it.id,
                "item_name": it.name,
                "category": it.category or "Kitchen",
                "sku": it.sku,
                "unit": it.unit or "units",
                "previous_stock": previous_stock_val,
                "previous_unit_price": previous_unit_price,
                "previous_date": previous_date,
                "previous_submitted_at": previous_submitted_at,
                "previous_submitted_by": previous_submitted_by,
                "total_previous_updates": len(all_previous_records),
                "all_previous_records": all_previous_records
            })

    results.sort(key=lambda x: x["item_name"].lower())
    return results


@router.put(
    "/inventory/{item_id}/stock",
    response_model=schemas.InventoryItemResponse,
    summary="Adjust stock quantity by a delta (positive = restock, negative = adjustment)"
)
def adjust_stock(
    item_id: int,
    body: schemas.InventoryStockAdjust,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    # Role permissions for stock vs price updates:
    # Inventory account can adjust stock quantity and update Price per Unit.
    # Manager account is not permitted to adjust stock quantity directly here.
    if current_user.role == models.UserRole.MANAGER:
        if float(body.quantity_delta) != 0:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the Inventory account can adjust stock quantity."
            )

    manila_tz = ZoneInfo("Asia/Manila")
    now_manila = datetime.now(manila_tz)
    today_manila = now_manila.date()

    # Rule: Once Inventory saves stock for an item, it stays locked until Admin grants permission to add stock again.
    if float(body.quantity_delta) != 0 and current_user.role == models.UserRole.INVENTORY:
        if getattr(item, "stock_entry_locked", False):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Stock for '{item.name}' has already been saved. Please ask an Admin for permission to add stock again."
            )

    if body.unit_price is not None and float(body.unit_price) >= 0:
        item.unit_price = Decimal(str(body.unit_price))
        daily_rec = db.query(models.DailyInventoryRecord).filter(
            models.DailyInventoryRecord.tenant_id == tenant_id,
            models.DailyInventoryRecord.inventory_item_id == item_id,
            models.DailyInventoryRecord.inventory_date == today_manila
        ).first()
        if daily_rec:
            daily_rec.unit_price = Decimal(str(body.unit_price))

    if float(body.quantity_delta) == 0:
        db.commit()
        db.refresh(item)
        return item

    new_qty = float(item.quantity) + float(body.quantity_delta)
    if new_qty < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Adjustment would result in negative stock ({new_qty:.2f}). "
                   f"Current quantity: {float(item.quantity):.2f}."
        )

    old_qty = float(item.quantity)
    item.quantity = Decimal(str(new_qty))
    # Price per unit is NOT updated by Manager or Admin (only Inventory account can update price)
    if current_user.role not in (models.UserRole.MANAGER, models.UserRole.ADMIN):
        if body.unit_price is not None and float(body.unit_price) >= 0:
            item.unit_price = Decimal(str(body.unit_price))

    # Lock stock entry for Inventory account until Admin grants permission again
    if current_user.role == models.UserRole.INVENTORY:
        item.stock_entry_locked = True

    # Sync daily inventory record for today's active stock (upsert to allow re-entry when Admin unlocks)
    daily_rec = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.tenant_id == tenant_id,
        models.DailyInventoryRecord.inventory_item_id == item_id,
        models.DailyInventoryRecord.inventory_date == today_manila
    ).first()
    if daily_rec:
        daily_rec.unit_price = item.unit_price
        daily_rec.current_stock = item.quantity
        daily_rec.submitted_by = current_user.id
        daily_rec.submitted_at = now_manila
    else:
        daily_rec = models.DailyInventoryRecord(
            tenant_id=tenant_id,
            inventory_item_id=item_id,
            unit_price=item.unit_price,
            current_stock=item.quantity,
            submitted_by=current_user.id,
            submitted_at=now_manila,
            inventory_date=today_manila
        )
        db.add(daily_rec)

    # Record in immutable InventoryHistory audit trail so it appears in Daily Inventory History & Audit Trail
    try:
        hist_entry = models.InventoryHistory(
            tenant_id=tenant_id,
            inventory_item_id=item.id,
            item_name=item.name,
            category=item.category or "Kitchen",
            unit=item.unit or "",
            previous_stock=Decimal(str(old_qty)),
            recorded_stock=item.quantity,
            difference=Decimal(str(new_qty - old_qty)),
            inventory_date=today_manila,
            recorded_at=now_manila,
            submitted_by=current_user.id,
            submitted_by_name=current_user.username,
            submitted_by_role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
            action_type="DAILY_SUBMISSION",
            notes=body.reason or "Daily Total Stock Update"
        )
        db.add(hist_entry)
    except Exception:
        pass

    db.flush()

    # Record StockMovement ledger entry
    try:
        movement = models.StockMovement(
            tenant_id=tenant_id,
            inventory_item_id=item_id,
            movement_type="ADJUSTMENT",
            quantity_delta=Decimal(str(body.quantity_delta)),
            quantity_after=item.quantity,
            unit_cost=item.unit_price,
            reason=body.reason or "Stock Adjustment",
            user_id=current_user.id
        )
        db.add(movement)
    except Exception:
        pass

    # Log the stock movement
    log = models.ActivityLog(
        tenant_id=tenant_id,
        user_id=current_user.id,
        action="Stock Adjusted",
        performed_by=current_user.username,
        target_user=None,
        role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=f"Item '{item.name}' stock adjusted from {old_qty:.2f} to {new_qty:.2f} ({body.reason or 'Manual Adjustment'})"
    )
    db.add(log)
    db.commit()
    db.refresh(item)

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
            "action": "adjusted",
            "item_id": item.id,
            "name": item.name,
            "quantity": float(item.quantity),
            "delta": float(body.quantity_delta)
        })
    except Exception:
        pass

    return item


# ============================================================================
# DAILY INVENTORY HISTORY & AUDIT TRAIL — ADMIN / OWNER ONLY
# ============================================================================

def _seed_initial_history_if_empty(db: Session, tenant_id: int):
    """
    Automatic backfill: If inventory_history is empty, populate from existing
    daily_inventory_records and inventory items so the audit trail is immediately populated.
    """
    hist_count = db.query(models.InventoryHistory).filter(models.InventoryHistory.tenant_id == tenant_id).count()
    if hist_count > 0:
        return

    manila_tz = ZoneInfo("Asia/Manila")
    now_manila = datetime.now(manila_tz)
    today_manila = now_manila.date()

    # 1. Backfill from daily inventory records
    daily_recs = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.tenant_id == tenant_id
    ).all()

    for dr in daily_recs:
        item = db.query(models.InventoryItem).filter(models.InventoryItem.id == dr.inventory_item_id).first()
        sub_user = db.query(models.User).filter(models.User.id == dr.submitted_by).first() if dr.submitted_by else None
        sub_name = f"{sub_user.first_name or ''} {sub_user.last_name or ''}".strip() or (sub_user.username if sub_user else "System")
        sub_role = str(sub_user.role.value if hasattr(sub_user.role, 'value') else sub_user.role).replace("_", " ").title() if sub_user else "Inventory Staff"
        
        rec_time = dr.submitted_at if dr.submitted_at else now_manila

        h = models.InventoryHistory(
            tenant_id=tenant_id,
            inventory_item_id=dr.inventory_item_id,
            item_name=item.name if item else f"Item #{dr.inventory_item_id}",
            category=(item.category if item else "Kitchen") or "Kitchen",
            unit=(item.unit if item else "units") or "units",
            previous_stock=Decimal("0.000"),
            recorded_stock=Decimal(str(dr.current_stock or 0)),
            difference=Decimal(str(dr.current_stock or 0)),
            inventory_date=dr.inventory_date or today_manila,
            recorded_at=rec_time,
            submitted_by=dr.submitted_by,
            submitted_by_name=sub_name,
            submitted_by_role=sub_role,
            action_type="DAILY_SUBMISSION",
            notes=f"Daily record backfill (₱{float(dr.unit_price or 0):.2f}/unit)"
        )
        db.add(h)

    # 2. If no daily records, populate current stock as initial baseline
    if not daily_recs:
        items = db.query(models.InventoryItem).filter(models.InventoryItem.tenant_id == tenant_id).all()
        for item in items:
            h = models.InventoryHistory(
                tenant_id=tenant_id,
                inventory_item_id=item.id,
                item_name=item.name,
                category=item.category or "Kitchen",
                unit=item.unit or "units",
                previous_stock=Decimal("0.000"),
                recorded_stock=Decimal(str(item.quantity or 0)),
                difference=Decimal(str(item.quantity or 0)),
                inventory_date=today_manila,
                recorded_at=now_manila,
                submitted_by=None,
                submitted_by_name="System Initializer",
                submitted_by_role="System Admin",
                action_type="INITIAL_RECORD",
                notes="Initial inventory catalog baseline"
            )
            db.add(h)

    try:
        db.commit()
    except Exception:
        db.rollback()


def _format_history_item(h: models.InventoryHistory) -> Dict[str, Any]:
    manila_tz = ZoneInfo("Asia/Manila")
    dt = h.recorded_at
    if dt and dt.tzinfo is None:
        # naive dt from DB represents Manila time
        dt = dt.replace(tzinfo=manila_tz)
    elif dt:
        dt = dt.astimezone(manila_tz)

    time_str = dt.strftime("%I:%M:%S %p") if dt else "12:00:00 AM"
    date_str = dt.strftime("%B %d, %Y") if dt else str(h.inventory_date)

    diff_val = float(h.difference or 0)
    diff_prefix = "+" if diff_val > 0 else ""
    diff_formatted = f"{diff_prefix}{diff_val:.2f}"

    return {
        "id": h.id,
        "tenant_id": h.tenant_id,
        "inventory_item_id": h.inventory_item_id,
        "item_name": h.item_name,
        "category": h.category or "Kitchen",
        "unit": "",
        "previous_stock": float(h.previous_stock or 0),
        "recorded_stock": float(h.recorded_stock or 0),
        "difference": diff_val,
        "difference_display": diff_formatted,
        "inventory_date": str(h.inventory_date),
        "recorded_at": h.recorded_at.isoformat() if h.recorded_at else None,
        "submitted_by": h.submitted_by,
        "submitted_by_name": h.submitted_by_name or "Staff",
        "submitted_by_role": h.submitted_by_role or "Inventory Staff",
        "action_type": h.action_type or "DAILY_SUBMISSION",
        "notes": h.notes,
        "time_display": time_str,
        "date_display": date_str
    }


@router.get(
    "/inventory/audit-history",
    summary="Daily Inventory History & Audit Trail (Admin / Owner Only)"
)
def get_inventory_audit_history(
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    specific_date: Optional[date] = None,
    category: Optional[str] = None,
    item_id: Optional[int] = None,
    submitted_by: Optional[int] = None,
    role: Optional[str] = None,
    search: Optional[str] = None,
    sort: Optional[str] = Query("newest", pattern="^(newest|oldest|highest_diff|lowest_diff)$"),
    page: int = Query(1, ge=1),
    limit: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin_or_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """
    Comprehensive Daily Inventory History & Audit Trail.
    Strictly restricted to Admin and Super Admin accounts.
    Allows filtering by date range, specific date, category, item, submitter, role, and search.
    Provides automated daily summary metrics.
    """
    _seed_initial_history_if_empty(db, tenant_id)

    query = db.query(models.InventoryHistory).filter(
        models.InventoryHistory.tenant_id == tenant_id
    )

    manila_tz = ZoneInfo("Asia/Manila")
    today_manila = datetime.now(manila_tz).date()

    # Filter by specific date or date range
    if specific_date:
        query = query.filter(models.InventoryHistory.inventory_date == specific_date)
    else:
        if start_date:
            query = query.filter(models.InventoryHistory.inventory_date >= start_date)
        if end_date:
            query = query.filter(models.InventoryHistory.inventory_date <= end_date)

    if category and category.strip().upper() != "ALL":
        query = query.filter(models.InventoryHistory.category == category.strip())

    if item_id:
        query = query.filter(models.InventoryHistory.inventory_item_id == item_id)

    if submitted_by:
        query = query.filter(models.InventoryHistory.submitted_by == submitted_by)

    if role and role.strip().upper() != "ALL":
        query = query.filter(models.InventoryHistory.submitted_by_role.ilike(f"%{role.strip()}%"))

    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(models.InventoryHistory.item_name.ilike(term))

    # Apply sorting
    if sort == "oldest":
        query = query.order_by(models.InventoryHistory.recorded_at.asc(), models.InventoryHistory.id.asc())
    elif sort == "highest_diff":
        query = query.order_by(models.InventoryHistory.difference.desc(), models.InventoryHistory.recorded_at.desc())
    elif sort == "lowest_diff":
        query = query.order_by(models.InventoryHistory.difference.asc(), models.InventoryHistory.recorded_at.desc())
    else:  # newest
        query = query.order_by(models.InventoryHistory.recorded_at.desc(), models.InventoryHistory.id.desc())

    total = query.count()
    total_pages = max(1, (total + limit - 1) // limit)
    offset = (page - 1) * limit
    records = query.offset(offset).limit(limit).all()

    # Calculate summary KPIs for today
    today_records = db.query(models.InventoryHistory).filter(
        models.InventoryHistory.tenant_id == tenant_id,
        models.InventoryHistory.inventory_date == today_manila
    ).all()

    total_recorded_today = len(today_records)
    today_cats = set(r.category for r in today_records if r.category)
    total_categories_today = len(today_cats)
    stock_increases_today = sum(1 for r in today_records if (r.difference or 0) > 0)
    stock_decreases_today = sum(1 for r in today_records if (r.difference or 0) < 0)

    # Available categories and submitters for frontend filter dropdowns
    all_categories = [c[0] for c in db.query(models.InventoryHistory.category).filter(
        models.InventoryHistory.tenant_id == tenant_id
    ).distinct().all() if c[0]]

    submitters_raw = db.query(
        models.InventoryHistory.submitted_by,
        models.InventoryHistory.submitted_by_name,
        models.InventoryHistory.submitted_by_role
    ).filter(
        models.InventoryHistory.tenant_id == tenant_id,
        models.InventoryHistory.submitted_by.isnot(None)
    ).distinct().all()

    submitters_list = [
        {"id": s[0], "name": s[1], "role": s[2]} for s in submitters_raw
    ]

    items_list = [
        {"id": it.id, "name": it.name, "category": it.category}
        for it in db.query(models.InventoryItem).filter(models.InventoryItem.tenant_id == tenant_id).order_by(models.InventoryItem.name).all()
    ]

    return {
        "items": [_format_history_item(r) for r in records],
        "total": total,
        "page": page,
        "limit": limit,
        "total_pages": total_pages,
        "summary": {
            "total_recorded_today": total_recorded_today,
            "total_categories_today": total_categories_today,
            "stock_increases_today": stock_increases_today,
            "stock_decreases_today": stock_decreases_today
        },
        "filters": {
            "categories": sorted(all_categories),
            "submitters": submitters_list,
            "items": items_list,
            "today_date": str(today_manila)
        }
    }


@router.get(
    "/inventory/audit-history/item/{item_id}",
    summary="Item-specific History Details & Trend Analysis (Admin / Owner Only)"
)
def get_item_inventory_history(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin_or_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """
    Returns full chronological audit timeline and historical trend data for an individual inventory item.
    """
    _seed_initial_history_if_empty(db, tenant_id)

    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()

    records = db.query(models.InventoryHistory).filter(
        models.InventoryHistory.tenant_id == tenant_id,
        models.InventoryHistory.inventory_item_id == item_id
    ).order_by(models.InventoryHistory.recorded_at.desc()).all()

    history_formatted = [_format_history_item(r) for r in records]

    # Trend line data points in chronological order
    trend_points = [
        {
            "date": r["date_display"],
            "short_date": r["inventory_date"],
            "time": r["time_display"],
            "stock": r["recorded_stock"],
            "diff": r["difference"],
            "submitter": r["submitted_by_name"]
        }
        for r in reversed(history_formatted)
    ]

    return {
        "item": {
            "id": item.id if item else item_id,
            "name": item.name if item else (history_formatted[0]["item_name"] if history_formatted else "Item"),
            "category": item.category if item else (history_formatted[0]["category"] if history_formatted else "Kitchen"),
            "unit": "",
            "current_stock": float(item.quantity) if item else (history_formatted[0]["recorded_stock"] if history_formatted else 0.0),
            "min_stock": float(item.min_stock) if item else 0.0,
            "unit_price": float(item.unit_price) if item else 0.0,
            "sku": item.sku if item else None
        },
        "history": history_formatted,
        "trend": trend_points,
        "total_records": len(history_formatted)
    }


@router.get(
    "/inventory/audit-history/export",
    summary="Export Daily Inventory History Report (CSV / Excel)"
)
def export_inventory_audit_history(
    format: str = Query("csv", pattern="^(csv|excel)$"),
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    specific_date: Optional[date] = None,
    category: Optional[str] = None,
    item_id: Optional[int] = None,
    submitted_by: Optional[int] = None,
    role: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin_or_inventory),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """
    Exports filtered inventory history as CSV/Excel compatible file with UTF-8 BOM.
    """
    from fastapi.responses import StreamingResponse

    _seed_initial_history_if_empty(db, tenant_id)

    query = db.query(models.InventoryHistory).filter(
        models.InventoryHistory.tenant_id == tenant_id
    )

    if specific_date:
        query = query.filter(models.InventoryHistory.inventory_date == specific_date)
    else:
        if start_date:
            query = query.filter(models.InventoryHistory.inventory_date >= start_date)
        if end_date:
            query = query.filter(models.InventoryHistory.inventory_date <= end_date)

    if category and category.strip().upper() != "ALL":
        query = query.filter(models.InventoryHistory.category == category.strip())

    if item_id:
        query = query.filter(models.InventoryHistory.inventory_item_id == item_id)

    if submitted_by:
        query = query.filter(models.InventoryHistory.submitted_by == submitted_by)

    if role and role.strip().upper() != "ALL":
        query = query.filter(models.InventoryHistory.submitted_by_role.ilike(f"%{role.strip()}%"))

    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(models.InventoryHistory.item_name.ilike(term))

    records = query.order_by(models.InventoryHistory.recorded_at.desc()).all()

    output = io.StringIO()
    # Write UTF-8 BOM for Microsoft Excel compatibility
    output.write("\\ufeff")
    writer = csv.writer(output)
    writer.writerow([
        "Date",
        "Time (PST)",
        "Item Name",
        "Category",
        "Current Stock",
        "New Total Stock",
        "Submitted By",
        "Role",
        "Action Type",
        "Notes"
    ])

    for r in records:
        item_data = _format_history_item(r)
        writer.writerow([
            item_data["date_display"],
            item_data["time_display"],
            item_data["item_name"],
            item_data["category"],
            f"{item_data['previous_stock']:.2f}",
            f"{item_data['recorded_stock']:.2f}",
            item_data["submitted_by_name"],
            item_data["submitted_by_role"],
            item_data["action_type"],
            item_data["notes"] or ""
        ])

    output.seek(0)
    filename = f"inventory_history_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.get(
    "/inventory/{item_id}",
    response_model=schemas.InventoryItemResponse,
    summary="Get a single inventory item by ID"
)
def get_inventory_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    manila_tz = ZoneInfo("Asia/Manila")
    today_manila = datetime.now(manila_tz).date()
    rec = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.tenant_id == tenant_id,
        models.DailyInventoryRecord.inventory_item_id == item_id,
        models.DailyInventoryRecord.inventory_date == today_manila
    ).first()

    # Check for previous daily stock record prior to today
    prev_rec = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.tenant_id == tenant_id,
        models.DailyInventoryRecord.inventory_item_id == item_id,
        models.DailyInventoryRecord.inventory_date < today_manila
    ).order_by(models.DailyInventoryRecord.inventory_date.desc(), models.DailyInventoryRecord.submitted_at.desc()).first()

    if prev_rec:
        item.previous_stock = Decimal(str(prev_rec.current_stock))
        item.previous_stock_date = str(prev_rec.inventory_date)
        item.has_previous_stock = True
    else:
        item.previous_stock = None
        item.previous_stock_date = None
        item.has_previous_stock = False

    is_locked = bool(getattr(item, "stock_entry_locked", False))
    if rec:
        item.daily_input_submitted_at = rec.submitted_at
        item.daily_input_submitted_by = rec.submitter.username if rec.submitter else "Staff"
        item.daily_input_date = str(rec.inventory_date)
    else:
        item.daily_input_submitted_at = None
        item.daily_input_submitted_by = None
        item.daily_input_date = str(today_manila)

    if is_locked:
        item.daily_input_status = "Stock Entry Locked"
        item.daily_input_submitted = True
        item.next_available_input_date = None
    else:
        item.daily_input_status = "Pending Stock Entry"
        item.daily_input_submitted = False
        item.next_available_input_date = None

    return item


@router.put(
    "/inventory/{item_id}",
    response_model=schemas.InventoryItemResponse,
    summary="Update an existing inventory item"
)
def update_inventory_item(
    item_id: int,
    body: schemas.InventoryItemUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    # In Edit Item Modal, Current Stock, Min Stock, and Unit Price are hidden.
    # Inventory, Manager, and Admin accounts can edit item metadata (Name, Category, Product Codes / SKU).
    if current_user.role in (models.UserRole.ADMIN, models.UserRole.MANAGER, models.UserRole.INVENTORY):
        body.unit_price = None
        # Inventory staff stock adjustments are done through New Total Stock (Save Stock)
        if current_user.role == models.UserRole.INVENTORY:
            body.quantity = None

    if body.name is not None:
        name_clean = body.name.strip()
        if not name_clean:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Item name cannot be empty.")
        # Check unique constraint within same tenant
        existing = db.query(models.InventoryItem).filter(
            models.InventoryItem.tenant_id == tenant_id,
            models.InventoryItem.name == name_clean,
            models.InventoryItem.id != item_id
        ).first()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"An inventory item named '{name_clean}' already exists in your catalog."
            )
        item.name = name_clean

    if body.category is not None:
        item.category = body.category.strip() if body.category.strip() else "Kitchen"

    if body.sku is not None:
        item.sku = body.sku.strip() if body.sku.strip() else None

    if body.quantity is not None:
        if body.quantity < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Stock quantity cannot be negative.")
        item.quantity = body.quantity

    if body.unit is not None and body.unit.strip():
        item.unit = body.unit.strip()

    if body.min_stock is not None:
        if body.min_stock < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Minimum stock threshold cannot be negative.")
        item.min_stock = body.min_stock

    if body.unit_price is not None:
        if body.unit_price < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unit price cannot be negative.")
        item.unit_price = body.unit_price

    try:
        db.commit()
        db.refresh(item)
        try:
            from app.core.websocket import notify_realtime_event
            notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
                "action": "updated",
                "item_id": item.id,
                "name": item.name,
                "quantity": float(item.quantity)
            })
        except Exception:
            pass
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Failed to update item: database constraint violation."
        )

    return item


@router.post(
    "/inventory/{item_id}/daily-input",
    summary="Submit one-time daily inventory input (Unit Price and Current Stock)"
)
def submit_daily_inventory_input(
    item_id: int,
    body: schemas.DailyInventoryInputCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """
    One-Time Daily Inventory Input System.
    Inventory officers and managers can submit Unit Price and Current Stock once per item per calendar day (Asia/Manila).
    Once submitted, the values become locked for the remainder of the Philippine calendar day until 12:00 AM midnight.
    Admins are not restricted by this rule.
    """
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    if body.unit_price < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unit price cannot be negative.")
    if body.current_stock < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current stock cannot be negative.")

    manila_tz = ZoneInfo("Asia/Manila")
    now_manila = datetime.now(manila_tz)
    today_manila = now_manila.date()

    # Role-based restriction: Once INVENTORY submits stock for an item, it stays locked until Admin grants permission again
    if current_user.role == models.UserRole.INVENTORY and getattr(item, "stock_entry_locked", False):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Stock for this item has already been saved. Please ask an Admin for permission to add stock again."
        )

    old_qty = float(item.quantity)
    if current_user.role == models.UserRole.INVENTORY:
        new_qty = float(item.quantity)
        new_price = Decimal(str(body.unit_price))
    elif current_user.role in (models.UserRole.MANAGER, models.UserRole.ADMIN):
        new_qty = float(body.current_stock)
        new_price = item.unit_price
    else:
        new_qty = float(body.current_stock)
        new_price = Decimal(str(body.unit_price))

    item.quantity = Decimal(str(new_qty))
    item.unit_price = new_price
    if current_user.role == models.UserRole.INVENTORY:
        item.stock_entry_locked = True
    db.flush()

    daily_record = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.tenant_id == tenant_id,
        models.DailyInventoryRecord.inventory_item_id == item.id,
        models.DailyInventoryRecord.inventory_date == today_manila
    ).first()
    if daily_record:
        daily_record.unit_price = new_price
        daily_record.current_stock = Decimal(str(new_qty))
        daily_record.submitted_by = current_user.id
        daily_record.submitted_at = now_manila
    else:
        daily_record = models.DailyInventoryRecord(
            tenant_id=tenant_id,
            inventory_item_id=item.id,
            unit_price=new_price,
            current_stock=Decimal(str(new_qty)),
            submitted_by=current_user.id,
            submitted_at=now_manila,
            inventory_date=today_manila,
        )
        db.add(daily_record)

    # Automatically record immutable Daily Inventory Audit History
    try:
        submitter_display = f"{current_user.first_name or ''} {current_user.last_name or ''}".strip() or current_user.username
        role_display = str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role).replace("_", " ").title()
        stock_difference = Decimal(str(new_qty)) - Decimal(str(old_qty))

        audit_entry = models.InventoryHistory(
            tenant_id=tenant_id,
            inventory_item_id=item.id,
            item_name=item.name,
            category=item.category or "Kitchen",
            unit=item.unit or "units",
            previous_stock=Decimal(str(old_qty)),
            recorded_stock=Decimal(str(new_qty)),
            difference=stock_difference,
            inventory_date=today_manila,
            recorded_at=now_manila,
            submitted_by=current_user.id,
            submitted_by_name=submitter_display,
            submitted_by_role=role_display,
            action_type="DAILY_SUBMISSION",
            notes=f"One-Time Daily Input (Unit Price: ₱{float(new_price):.2f})"
        )
        db.add(audit_entry)
    except Exception as e:
        pass

    log = models.ActivityLog(
        tenant_id=tenant_id,
        user_id=current_user.id,
        action="Daily Inventory Submitted",
        performed_by=current_user.username,
        target_user=None,
        role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=f"One-Time Daily Input for '{item.name}': stock={new_qty:.2f} {item.unit}, price=₱{float(new_price):.2f}"
    )
    db.add(log)

    try:
        db.commit()
        db.refresh(daily_record)
        db.refresh(item)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Daily inventory input has already been completed for this item today. You can submit a new entry starting at 12:00 AM tomorrow."
        )

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
            "action": "daily_input_submitted",
            "item_id": item.id,
            "name": item.name,
            "quantity": float(item.quantity),
            "unit_price": float(item.unit_price),
            "inventory_date": str(today_manila)
        })
    except Exception:
        pass

    next_date_str = (today_manila + timedelta(days=1)).strftime("%B %d, %Y 12:00 AM")

    return {
        "message": "Daily inventory input successfully submitted. Unit Price and Current Stock are now locked until 12:00 AM tomorrow.",
        "item_id": item.id,
        "name": item.name,
        "unit_price": float(item.unit_price),
        "current_stock": float(item.quantity),
        "submitted_at": daily_record.submitted_at.isoformat(),
        "submitted_by": current_user.username,
        "inventory_date": str(today_manila),
        "next_available_input_date": next_date_str,
        "status": "Daily Input Completed"
    }


@router.get(
    "/inventory/{item_id}/daily-history",
    summary="Get daily inventory input history for an item (shows previous updates, not current active stock)"
)
def get_daily_inventory_history(
    item_id: int,
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    records = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.tenant_id == tenant_id,
        models.DailyInventoryRecord.inventory_item_id == item_id
    ).order_by(models.DailyInventoryRecord.inventory_date.desc(), models.DailyInventoryRecord.submitted_at.desc()).limit(limit).all()

    # The user requested:
    # "can you add the history of previous history stock not the current but the history of inventory can only see the previous update not the new update but the previous updated if not update the stock of inventory not see in the history of inventory like this"
    # History must show previous updates (records prior to current active stock).
    # If the item only has the current entry or no updates, previous history is empty!
    previous_records = records[1:] if len(records) > 1 else []

    return [
        {
            "id": r.id,
            "tenant_id": r.tenant_id,
            "inventory_item_id": r.inventory_item_id,
            "unit_price": float(r.unit_price),
            "current_stock": float(r.current_stock),
            "previous_stock": float(r.current_stock),
            "submitted_by": r.submitted_by,
            "submitted_by_username": r.submitter.username if r.submitter else "Staff",
            "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
            "inventory_date": str(r.inventory_date)
        }
        for r in previous_records
    ]


@router.put(
    "/inventory/{item_id}/price",
    summary="Update unit price of inventory item (Inventory account only)"
)
def update_inventory_price(
    item_id: int,
    body: schemas.InventoryPriceUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    # Rule: Manager and Admin accounts can only update inventory stock.
    # ONLY the Inventory account can update Price per Unit.
    if current_user.role in (models.UserRole.MANAGER, models.UserRole.ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Manager and Admin accounts can only update inventory stock. Only the Inventory account can update Price per Unit."
        )

    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    if body.unit_price < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unit price cannot be negative.")

    old_price = float(item.unit_price)
    new_price = float(body.unit_price)
    item.unit_price = body.unit_price

    # If daily record exists for today, update its unit price as well
    manila_tz = ZoneInfo("Asia/Manila")
    today_manila = datetime.now(manila_tz).date()
    daily_rec = db.query(models.DailyInventoryRecord).filter(
        models.DailyInventoryRecord.tenant_id == tenant_id,
        models.DailyInventoryRecord.inventory_item_id == item_id,
        models.DailyInventoryRecord.inventory_date == today_manila
    ).first()
    if daily_rec:
        daily_rec.unit_price = body.unit_price

    # Log the price update activity
    log = models.ActivityLog(
        tenant_id=tenant_id,
        user_id=current_user.id,
        action="Unit Price Updated",
        performed_by=current_user.username,
        target_user=None,
        role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=f"Item '{item.name}' unit price updated from ₱{old_price:.2f} to ₱{new_price:.2f}"
    )
    db.add(log)
    db.commit()
    db.refresh(item)

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
            "action": "price_updated",
            "item_id": item.id,
            "name": item.name,
            "unit_price": float(item.unit_price)
        })
    except Exception:
        pass

    return {
        "message": f"Unit price for '{item.name}' updated successfully to ₱{new_price:.2f}",
        "item_id": item.id,
        "name": item.name,
        "unit_price": float(item.unit_price),
        "current_stock": float(item.quantity)
    }


@router.post(
    "/inventory/{item_id}/allow-stock",
    summary="Admin permission to allow Inventory to add stock again for an item"
)
def allow_inventory_stock_entry(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """Unlocks stock entry for an inventory item so Inventory staff can save stock again."""
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    item.stock_entry_locked = False
    log = models.ActivityLog(
        tenant_id=tenant_id,
        user_id=current_user.id,
        action="Inventory Stock Unlocked",
        performed_by=current_user.username,
        target_user=None,
        role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=f"Admin '{current_user.username}' granted permission to add stock again for '{item.name}'."
    )
    db.add(log)
    db.commit()
    db.refresh(item)

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
            "action": "stock_unlocked",
            "item_id": item.id,
            "name": item.name
        })
    except Exception:
        pass

    return {
        "id": item.id,
        "name": item.name,
        "stock_entry_locked": False,
        "message": f"Permission granted: Inventory can now add stock again for '{item.name}'."
    }


@router.post(
    "/inventory/allow-stock-all",
    summary="Admin permission to allow Inventory to add stock again for all locked items"
)
def allow_all_inventory_stock_entry(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_admin),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    """Unlocks stock entry for all locked inventory items in the tenant so Inventory staff can save stock again."""
    locked_items = db.query(models.InventoryItem).filter(
        models.InventoryItem.tenant_id == tenant_id,
        models.InventoryItem.stock_entry_locked == True
    ).all()

    count = len(locked_items)
    for item in locked_items:
        item.stock_entry_locked = False

    log = models.ActivityLog(
        tenant_id=tenant_id,
        user_id=current_user.id,
        action="Inventory All Stock Unlocked",
        performed_by=current_user.username,
        target_user=None,
        role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=f"Admin '{current_user.username}' granted permission to add stock again for all locked items ({count} unlocked)."
    )
    db.add(log)
    db.commit()

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
            "action": "stock_unlocked_all",
            "unlocked_count": count
        })
    except Exception:
        pass

    return {
        "unlocked_count": count,
        "message": f"Permission granted: {count} item(s) unlocked for Inventory stock entry."
    }


from pydantic import BaseModel


class WastageCreateRequest(BaseModel):
    quantity: float
    reason: str
    cost: Optional[float] = None


@router.get(
    "/inventory/wastage/list",
    summary="List wastage & spoilage records from stock movements"
)
def list_wastage_records(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    rows = (
        db.query(models.StockMovement, models.InventoryItem, models.User)
        .join(models.InventoryItem, models.StockMovement.inventory_item_id == models.InventoryItem.id)
        .outerjoin(models.User, models.StockMovement.user_id == models.User.id)
        .filter(
            models.StockMovement.tenant_id == tenant_id,
            models.StockMovement.movement_type == "WASTAGE",
        )
        .order_by(models.StockMovement.created_at.desc(), models.StockMovement.id.desc())
        .limit(limit)
        .all()
    )

    manila_tz = ZoneInfo("Asia/Manila")
    results = []
    for mv, item, usr in rows:
        qty_lost = abs(float(mv.quantity_delta))
        unit_cost = float(mv.unit_cost if mv.unit_cost is not None else (item.unit_price or 0))
        dt = mv.created_at
        if dt is not None:
            dt_ph = dt.replace(tzinfo=manila_tz) if dt.tzinfo is None else dt.astimezone(manila_tz)
            ts_str = dt_ph.strftime("%b %d, %Y %I:%M %p")
        else:
            ts_str = "—"
        results.append({
            "id": mv.id,
            "inventory_item_id": item.id,
            "item": item.name,
            "unit": item.unit or "pcs",
            "qty_num": qty_lost,
            "qty": f"{qty_lost:g} {item.unit or 'pcs'}",
            "reason": mv.reason or "Wastage",
            "cost": round(qty_lost * unit_cost, 2),
            "logged_by": usr.username if usr else "Staff",
            "date": ts_str,
        })
    return results


@router.post(
    "/inventory/{item_id}/wastage",
    summary="Record wastage/spoilage and deduct directly from inventory stock"
)
def record_inventory_wastage(
    item_id: int,
    body: WastageCreateRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_inventory_access),
    tenant_id: int = Depends(get_inventory_tenant_id),
):
    item = db.query(models.InventoryItem).filter(
        models.InventoryItem.id == item_id,
        models.InventoryItem.tenant_id == tenant_id
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory item not found.")

    qty_lost = float(body.quantity or 0)
    if qty_lost <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Wastage quantity must be greater than 0.")

    old_qty = float(item.quantity or 0)
    if qty_lost > old_qty:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot record {qty_lost:g} {item.unit or 'pcs'} wastage: only {old_qty:g} {item.unit or 'pcs'} currently in stock."
        )

    new_qty = round(old_qty - qty_lost, 3)
    item.quantity = Decimal(str(new_qty))

    unit_price = float(item.unit_price or 0)
    unit_cost = round(float(body.cost) / qty_lost, 2) if (body.cost is not None and float(body.cost) >= 0) else unit_price
    total_cost = round(float(body.cost), 2) if (body.cost is not None and float(body.cost) >= 0) else round(qty_lost * unit_price, 2)
    reason_clean = (body.reason or "Wastage / Spoilage").strip()[:255]

    manila_tz = ZoneInfo("Asia/Manila")
    now_manila = datetime.now(manila_tz)

    movement = models.StockMovement(
        tenant_id=tenant_id,
        inventory_item_id=item.id,
        movement_type="WASTAGE",
        quantity_delta=Decimal(str(-qty_lost)),
        quantity_after=item.quantity,
        unit_cost=Decimal(str(unit_cost)),
        reason=reason_clean,
        user_id=current_user.id,
    )
    db.add(movement)

    try:
        hist_entry = models.InventoryHistory(
            tenant_id=tenant_id,
            inventory_item_id=item.id,
            item_name=item.name,
            category=item.category or "Kitchen",
            unit=item.unit or "pcs",
            previous_stock=Decimal(str(old_qty)),
            recorded_stock=item.quantity,
            difference=Decimal(str(-qty_lost)),
            inventory_date=now_manila.date(),
            recorded_at=now_manila.replace(tzinfo=None),
            submitted_by=current_user.id,
            submitted_by_name=current_user.username,
            submitted_by_role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
            action_type="WASTAGE",
            notes=f"Wastage ({reason_clean}): -{qty_lost:g} {item.unit or 'pcs'}",
        )
        db.add(hist_entry)
    except Exception:
        pass

    log = models.ActivityLog(
        tenant_id=tenant_id,
        user_id=current_user.id,
        action="Wastage Recorded",
        performed_by=current_user.username,
        target_user=None,
        role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
        details=f"Recorded wastage for '{item.name}': -{qty_lost:g} {item.unit or 'pcs'} ({reason_clean}). Stock: {old_qty:g} -> {new_qty:g}",
    )
    db.add(log)
    db.commit()
    db.refresh(item)
    db.refresh(movement)

    try:
        from app.core.websocket import notify_realtime_event
        notify_realtime_event(tenant_id, "INVENTORY_UPDATED", {
            "action": "wastage_recorded",
            "item_id": item.id,
            "name": item.name,
            "quantity": float(item.quantity),
        })
    except Exception:
        pass

    return {
        "id": movement.id,
        "inventory_item_id": item.id,
        "item": item.name,
        "unit": item.unit or "pcs",
        "qty": f"{qty_lost:g} {item.unit or 'pcs'}",
        "reason": reason_clean,
        "cost": total_cost,
        "new_quantity": float(item.quantity),
        "logged_by": current_user.username,
        "date": now_manila.strftime("%b %d, %Y %I:%M %p"),
    }
