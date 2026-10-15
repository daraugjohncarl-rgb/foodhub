"""
Stock changes in one place (M4, M6, H6, M12).

Every change locks the inventory rows (SELECT ... FOR UPDATE, always in id order to avoid deadlocks), uses Decimal
arithmetic, and writes a StockMovement ledger row in the caller's transaction. Nothing here commits.
"""
from decimal import Decimal
from typing import Dict, Iterable, List, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

import app.models as models

TWO_PLACES = Decimal("0.01")


def lock_items(db: Session, tenant_id: int, item_ids: Iterable[int]) -> Dict[int, models.InventoryItem]:
    ids = sorted(set(item_ids))
    if not ids:
        return {}
    rows = (
        db.query(models.InventoryItem)
        .filter(models.InventoryItem.tenant_id == tenant_id, models.InventoryItem.id.in_(ids))
        .order_by(models.InventoryItem.id)
        .with_for_update()
        .all()
    )
    found = {row.id: row for row in rows}
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Inventory item(s) not found: {missing}")
    return found


def apply_movement(
    db: Session,
    item: models.InventoryItem,
    delta: Decimal,
    movement_type: models.StockMovementType,
    *,
    user: Optional[models.User],
    reason: Optional[str] = None,
    reference_type: Optional[str] = None,
    reference_id: Optional[int] = None,
    unit_cost: Optional[Decimal] = None,
    allow_negative: bool = False,
) -> models.StockMovement:
    """`item` must already be locked via lock_items()."""
    delta = Decimal(delta)
    new_quantity = (Decimal(item.quantity) + delta).quantize(TWO_PLACES)
    if new_quantity < 0 and not allow_negative:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Not enough stock of '{item.name}': {Decimal(item.quantity):.2f} {item.unit} available, "
                   f"{abs(delta):.2f} needed.",
        )
    item.quantity = new_quantity
    movement = models.StockMovement(
        tenant_id=item.tenant_id,
        inventory_item_id=item.id,
        movement_type=movement_type.value,
        quantity_delta=delta,
        quantity_after=new_quantity,
        unit_cost=unit_cost,
        reason=reason[:255] if reason else None,
        reference_type=reference_type,
        reference_id=reference_id,
        user_id=user.id if user else None,
    )
    db.add(movement)
    return movement


def recipe_requirements(db: Session, product_quantities: Dict[int, int]) -> Dict[int, Decimal]:
    """{inventory_item_id: total quantity needed} for the given {product_id: units sold}."""
    if not product_quantities:
        return {}
    needs: Dict[int, Decimal] = {}
    lines: List[models.ProductRecipe] = (
        db.query(models.ProductRecipe)
        .filter(models.ProductRecipe.product_id.in_(list(product_quantities)))
        .all()
    )
    for line in lines:
        needs[line.inventory_item_id] = needs.get(line.inventory_item_id, Decimal("0")) + (
            Decimal(line.quantity) * product_quantities[line.product_id]
        )
    return needs
