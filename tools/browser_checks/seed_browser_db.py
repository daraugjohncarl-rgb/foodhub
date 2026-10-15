"""Builds the disposable browser-test database (pos_e2e_test) at the Alembic head with a small fixture set."""
import os
import sys
from decimal import Decimal

sys.dont_write_bytecode = True
APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "fastapi")
url = os.environ["DATABASE_URL"]
assert url.rstrip("/").endswith("_test"), url
sys.path.insert(0, APP)
os.chdir(APP)

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from app.db import engine, SessionLocal
import app.models as m
from app.core.security import get_password_hash

with engine.begin() as conn:
    conn.execute(text("DROP SCHEMA public CASCADE"))
    conn.execute(text("CREATE SCHEMA public"))
cfg = Config(os.path.join(APP, "alembic.ini"))
cfg.set_main_option("script_location", os.path.join(APP, "migrations"))
command.upgrade(cfg, "head")

db = SessionLocal()
t = m.Tenant(name="E2E Branch", subdomain_or_code="e2e")
db.add(t)
db.flush()
pw = get_password_hash("E2e-password-123")
users = {}
for name, role, tenant in [("sa", m.UserRole.SUPER_ADMIN, None), ("admin", m.UserRole.ADMIN, t.id),
                           ("cashier", m.UserRole.CASHIER, t.id), ("kitchen", m.UserRole.KITCHEN, t.id),
                           ("inv", m.UserRole.INVENTORY, t.id), ("manager", m.UserRole.MANAGER, t.id)]:
    users[name] = m.User(username=name, password_hash=pw, role=role, tenant_id=tenant)
    db.add(users[name])
cat = m.Category(tenant_id=t.id, name="Drinks <i>tag</i>")
db.add(cat)
db.flush()
db.add_all([
    m.Product(tenant_id=t.id, category_id=cat.id, name="Coke", sku="C1", price=Decimal("25"), cost=Decimal("10")),
    m.Product(tenant_id=t.id, category_id=cat.id, name="Tom's \"Special\" <b>Burger</b>", sku="X1", price=Decimal("95.50"), cost=Decimal("40")),
])
db.add(m.InventoryItem(tenant_id=t.id, name="Rice", unit="kg", quantity=Decimal("10"), min_stock=Decimal("2")))
db.add(m.Supplier(tenant_id=t.id, supplier_name="Supplier \"<svg onload=window.__xss=9>\"", status="Active"))
db.add(m.RestaurantTable(tenant_id=t.id, table_number="7"))
db.commit()
print("seeded tenant", t.id)
