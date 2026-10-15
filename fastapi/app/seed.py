"""
Startup seeding (H3, H9).

* ensure_essentials(): always runs. Creates the default branch if there is none, and - only when
  INITIAL_SUPERADMIN_PASSWORD is provided - the first SUPER_ADMIN. Never creates known default credentials.
* seed_demo_data(): only when SEED_DEMO_DATA is enabled (on by default in development, off in production).
  Demo accounts are flagged must_change_password so they cannot be used until their password is changed.

Product and inventory SKUs are derived from a SHA-1 of the name, so they are identical on every run and every
machine (Python's built-in hash() is randomised per process and collided ~48% of the time). Every item is inserted
inside its own savepoint, so one bad row is reported instead of discarding the whole seed.
"""
import hashlib
import logging
import os
from decimal import Decimal

from sqlalchemy.orm import Session

import app.models as models
from app.core.config import PASSWORD_MIN_LENGTH
from app.core.security import get_password_hash

logger = logging.getLogger("pos_seed")

DEFAULT_TENANT_NAME = "Main Branch - Blessie FoodHub"

DEMO_USERS = [
    # username, role, password
    ("superadmin", models.UserRole.SUPER_ADMIN, "superadmin123"),
    ("admin", models.UserRole.ADMIN, "admin123"),
    ("manager", models.UserRole.MANAGER, "manager123"),
    ("cashier", models.UserRole.CASHIER, "cashier123"),
    ("inventory", models.UserRole.INVENTORY, "inventory123"),
    ("kitchen", models.UserRole.KITCHEN, "kitchen123"),
]


class SeedError(RuntimeError):
    pass


def stable_code(prefix: str, *parts: str, length: int = 8) -> str:
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:length].upper()
    return f"{prefix}-{digest}"


def ensure_essentials(db: Session) -> models.Tenant:
    tenant = db.query(models.Tenant).order_by(models.Tenant.id).first()
    if tenant is None:
        logger.info("Creating default branch '%s'", DEFAULT_TENANT_NAME)
        tenant = models.Tenant(name=DEFAULT_TENANT_NAME, subdomain_or_code="main-branch", is_active=True)
        db.add(tenant)
        db.commit()
        db.refresh(tenant)

    has_super_admin = db.query(models.User.id).filter(models.User.role == models.UserRole.SUPER_ADMIN).first()
    initial_password = os.getenv("INITIAL_SUPERADMIN_PASSWORD", "")
    if not has_super_admin and initial_password:
        if len(initial_password) < PASSWORD_MIN_LENGTH:
            raise SeedError(f"INITIAL_SUPERADMIN_PASSWORD must be at least {PASSWORD_MIN_LENGTH} characters.")
        username = (os.getenv("INITIAL_SUPERADMIN_USERNAME") or "superadmin").strip().lower()
        logger.info("Creating initial SUPER_ADMIN '%s' (password change required at first login)", username)
        db.add(models.User(
            username=username,
            password_hash=get_password_hash(initial_password),
            role=models.UserRole.SUPER_ADMIN,
            tenant_id=None,
            is_active=True,
            must_change_password=True,
        ))
        db.commit()
    elif not has_super_admin:
        logger.warning(
            "No SUPER_ADMIN account exists. Set INITIAL_SUPERADMIN_PASSWORD (and optionally INITIAL_SUPERADMIN_USERNAME) "
            "for one start-up to create it."
        )
    return tenant


def seed_demo_data(db: Session, tenant: models.Tenant) -> dict:
    from app.seed_data import POS_MENU_MASTERLIST, DEFAULT_SUPPLIERS

    report = {"users": 0, "categories": 0, "products": 0, "suppliers": 0, "failed": []}

    for username, role, password in DEMO_USERS:
        if role == models.UserRole.SUPER_ADMIN and db.query(models.User.id).filter(
            models.User.role == models.UserRole.SUPER_ADMIN
        ).first():
            continue
        if db.query(models.User.id).filter(models.User.username == username).first():
            continue
        db.add(models.User(
            username=username,
            email=f"{username}@inboxpos.com",
            password_hash=get_password_hash(password),
            role=role,
            tenant_id=None if role == models.UserRole.SUPER_ADMIN else tenant.id,
            is_active=True,
            must_change_password=True,
        ))
        report["users"] += 1
    db.commit()

    for cat_name, items in POS_MENU_MASTERLIST.items():
        category = db.query(models.Category).filter(
            models.Category.tenant_id == tenant.id, models.Category.name == cat_name
        ).first()
        if category is None:
            category = models.Category(tenant_id=tenant.id, name=cat_name, description=f"{cat_name} Menu")
            db.add(category)
            db.flush()
            report["categories"] += 1

        for item_name, price in items:
            exists = db.query(models.Product.id).filter(
                models.Product.tenant_id == tenant.id, models.Product.name == item_name
            ).first()
            if exists:
                continue
            try:
                with db.begin_nested():
                    db.add(models.Product(
                        tenant_id=tenant.id,
                        category_id=category.id,
                        name=item_name,
                        sku=stable_code("POS", item_name),
                        price=Decimal(str(price)),
                        cost=(Decimal(str(price)) * Decimal("0.55")).quantize(Decimal("0.01")),
                        is_active=True,
                    ))
                report["products"] += 1
            except Exception as exc:  # one bad row must not discard the rest
                report["failed"].append(f"product '{item_name}': {exc.__class__.__name__}")
    db.commit()

    for supplier in DEFAULT_SUPPLIERS:
        exists = db.query(models.Supplier.id).filter(
            models.Supplier.tenant_id == tenant.id, models.Supplier.supplier_name == supplier["name"]
        ).first()
        if exists:
            continue
        db.add(models.Supplier(
            tenant_id=tenant.id,
            supplier_name=supplier["name"],
            contact_number=supplier["contact"],
            category=supplier["category"],
            products_supplied=supplier["products"],
            status="Active",
        ))
        report["suppliers"] += 1
    db.commit()

    if report["failed"]:
        logger.error("Demo seed finished with %d failed item(s): %s", len(report["failed"]), report["failed"])
    else:
        logger.info("Demo seed: %s", {k: v for k, v in report.items() if k != "failed"})
    return report
