"""
Recipe-based stock deduction for POS sales.

BUSINESS DECISION PENDING (docs/BUSINESS_DECISIONS.md #4): when stock should be deducted (order acceptance,
preparation or sale) has not been decided. The mechanism is therefore OFF unless INVENTORY_DEDUCTION=on_sale.

What is stock-tracked: only products that have `product_recipes` rows. Each recipe row says how much of an
inventory item one unit of the product uses. Products without a recipe are not tracked and are never
deducted; no quantities or recipes are invented.

When on_sale is enabled:
  * A sale deducts every recipe ingredient inside the sale's database transaction. Each deduction is a
    conditional UPDATE (`quantity >= needed`), so two concurrent sales cannot take the same stock twice and
    stock never goes negative; an insufficient item fails the whole sale (409) and nothing is written.
  * Each deducted item gets one SALE row in stock_movements referencing the sale ('pos_sale', tx.id). A
    partial unique index makes a second deduction for the same sale impossible.
  * Voiding the sale restores exactly what that sale deducted (REVERSAL rows, 'pos_sale_void', tx.id),
    at most once, even if the setting was switched off in between. Nothing is restored if nothing was taken.
  * Online orders are deducted only when their sale is recorded; kitchen acceptance never deducts, so an
    order cannot be deducted twice.
"""
import os
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.orm import Session

import app.models as models

REF_SALE = "pos_sale"
REF_SALE_VOID = "pos_sale_void"


def deduction_mode() -> str:
    mode = os.getenv("INVENTORY_DEDUCTION", "off").strip().lower()
    return mode if mode in ("off", "on_sale") else "off"


def _requirements(db: Session, tenant_id: int, lines) -> dict:
    """{inventory_item_id: total quantity needed} for [(product_id, qty)], from this tenant's recipes."""
    product_ids = {pid for pid, _ in lines if pid is not None}
    if not product_ids:
        return {}
    recipes = db.query(models.ProductRecipe).join(
        models.InventoryItem, models.InventoryItem.id == models.ProductRecipe.inventory_item_id
    ).filter(
        models.ProductRecipe.product_id.in_(product_ids),
        models.InventoryItem.tenant_id == tenant_id,
    ).all()
    per_product = {}
    for r in recipes:
        per_product.setdefault(r.product_id, []).append(r)
    needed = {}
    for pid, qty in lines:
        for r in per_product.get(pid, []):
            amount = Decimal(str(r.quantity)) * qty
            if amount > 0:
                needed[r.inventory_item_id] = needed.get(r.inventory_item_id, Decimal("0")) + amount
    return needed


def deduct_for_sale(db: Session, tx: models.Transaction, lines, user_id: int) -> int:
    """
    Deduct recipe stock for a sale that has been flushed (tx.id exists). Must run inside the sale's
    database transaction; raises 409 on insufficient stock so the caller rolls everything back.
    Returns the number of inventory items touched.
    """
    if deduction_mode() != "on_sale":
        return 0
    needed = _requirements(db, tx.tenant_id, lines)
    # Fixed order (by id) so concurrent sales lock inventory rows in the same sequence (no deadlock).
    for item_id in sorted(needed):
        amount = needed[item_id]
        updated = db.query(models.InventoryItem).filter(
            models.InventoryItem.id == item_id,
            models.InventoryItem.tenant_id == tx.tenant_id,
            models.InventoryItem.quantity >= amount,
        ).update({models.InventoryItem.quantity: models.InventoryItem.quantity - amount}, synchronize_session=False)
        if updated != 1:
            name = db.query(models.InventoryItem.name).filter(models.InventoryItem.id == item_id).scalar()
            raise HTTPException(status_code=409, detail=f"Not enough stock of '{name or 'an ingredient'}' for this sale.")
        after = db.query(models.InventoryItem.quantity).filter(models.InventoryItem.id == item_id).scalar()
        db.add(models.StockMovement(
            tenant_id=tx.tenant_id, inventory_item_id=item_id, movement_type="SALE",
            quantity_delta=-amount, quantity_after=after, reason=f"POS sale #{tx.id}"[:255],
            reference_type=REF_SALE, reference_id=tx.id, user_id=user_id,
        ))
    if needed:
        db.flush()
    return len(needed)


def restore_for_void(db: Session, tx: models.Transaction, user_id: int) -> int:
    """Give back exactly what this sale deducted, once. Runs inside the void's database transaction."""
    taken = db.query(models.StockMovement).filter(
        models.StockMovement.tenant_id == tx.tenant_id,
        models.StockMovement.reference_type == REF_SALE,
        models.StockMovement.reference_id == tx.id,
    ).order_by(models.StockMovement.inventory_item_id).all()
    if not taken:
        return 0
    already = {m.inventory_item_id for m in db.query(models.StockMovement.inventory_item_id).filter(
        models.StockMovement.tenant_id == tx.tenant_id,
        models.StockMovement.reference_type == REF_SALE_VOID,
        models.StockMovement.reference_id == tx.id,
    ).all()}
    restored = 0
    for m in taken:
        if m.inventory_item_id in already:
            continue
        amount = -Decimal(str(m.quantity_delta))
        db.query(models.InventoryItem).filter(
            models.InventoryItem.id == m.inventory_item_id,
            models.InventoryItem.tenant_id == tx.tenant_id,
        ).update({models.InventoryItem.quantity: models.InventoryItem.quantity + amount}, synchronize_session=False)
        after = db.query(models.InventoryItem.quantity).filter(models.InventoryItem.id == m.inventory_item_id).scalar()
        db.add(models.StockMovement(
            tenant_id=tx.tenant_id, inventory_item_id=m.inventory_item_id, movement_type="REVERSAL",
            quantity_delta=amount, quantity_after=after, reason=f"Void of POS sale #{tx.id}"[:255],
            reference_type=REF_SALE_VOID, reference_id=tx.id, user_id=user_id,
        ))
        restored += 1
    if restored:
        db.flush()
    return restored
