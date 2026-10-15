"""
Builds a disposable database shaped like the evidenced production lineage, WITHOUT importing any dump:
  * tables created by the ORIGINAL code (git HEAD models, create_all)
  * changes made later by the pre-Alembic scripts: FK names fk_customer_orders_tenant_id /
    fk_customer_order_items_product_id, extra enum value userrole 'CUSTOMER'
  * database server timezone Asia/Singapore (UTC+8, like this PC's PostgreSQL), so now() defaults are local time
  * rows written through all three legacy clocks: DB now(), Python datetime.now() (local), Python utcnow()
Writes the true UTC instant of every row to a JSON file so the migrated values can be checked.
Usage: python rehearsal_reallike.py <url> <out.json> [snapshot]
  snapshot: build the 2026-09-05 dump shape instead (no restaurant_tables, no customer_orders.tenant_id,
            no customer_order_items.product_id) to prove the pre-flight refuses it.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal

sys.dont_write_bytecode = True
url, out = sys.argv[1], sys.argv[2]
snapshot = len(sys.argv) > 3 and sys.argv[3] == "snapshot"
assert url.rstrip("/").endswith("_test"), url

LEGACY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "legacy", "fastapi")
sys.path.insert(0, LEGACY)
os.environ["DATABASE_URL"] = url
from sqlalchemy import create_engine, text  # noqa: E402

admin = create_engine(url, isolation_level="AUTOCOMMIT")
dbname = url.rsplit("/", 1)[1]
with admin.connect() as c:
    c.execute(text(f'ALTER DATABASE "{dbname}" SET timezone TO \'Asia/Singapore\''))
admin.dispose()

from app.db import engine, Base, SessionLocal  # noqa: E402  (legacy code)
import app.models as m  # noqa: E402
assert "legacy" in m.__file__

Base.metadata.create_all(engine)
with engine.begin() as c:
    assert c.execute(text("SHOW timezone")).scalar() == "Asia/Singapore"
    if snapshot:
        c.execute(text("DROP TABLE restaurant_tables"))
        c.execute(text("ALTER TABLE customer_order_items DROP COLUMN product_id"))
        c.execute(text("ALTER TABLE customer_orders DROP COLUMN tenant_id"))
    else:
        c.execute(text("ALTER TABLE customer_orders RENAME CONSTRAINT customer_orders_tenant_id_fkey TO fk_customer_orders_tenant_id"))
        c.execute(text("ALTER TABLE customer_order_items RENAME CONSTRAINT customer_order_items_product_id_fkey TO fk_customer_order_items_product_id"))
with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as c:
    c.execute(text("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'CUSTOMER'"))

truth = {}
db = SessionLocal()
t = m.Tenant(name="Main", subdomain_or_code="main"); db.add(t); db.flush()
u = m.User(username="cashier", password_hash="x", role=m.UserRole.CASHIER, tenant_id=t.id); db.add(u); db.flush()
cat = m.Category(tenant_id=t.id, name="Drinks"); db.add(cat); db.flush()
p = m.Product(tenant_id=t.id, category_id=cat.id, name="Coke", sku="C1", price=Decimal("25"), cost=Decimal("10")); db.add(p); db.flush()
db.commit()
before = datetime.now(timezone.utc)
sh = m.Shift(tenant_id=t.id, user_id=u.id, start_cash=0, status="open"); db.add(sh); db.commit()
tx = m.Transaction(tenant_id=t.id, shift_id=sh.id, user_id=u.id, client_tx_id="r1", total_amount=25, net_amount=25, status="pending")
db.add(tx); db.commit()
sh.end_time = datetime.utcnow(); sh.status = "closed"           # legacy shifts.py
inv = m.InventoryItem(tenant_id=t.id, name="Rice", unit="kg", quantity=10, min_stock=2); db.add(inv); db.flush()
sup = m.Supplier(tenant_id=t.id, supplier_name="S1"); db.add(sup); db.flush()
po = m.PurchaseOrder(tenant_id=t.id, po_number="PO-1", supplier_id=sup.id, subtotal=5, total_amount=5,
                     expected_delivery_date=datetime(2026, 10, 20, tzinfo=timezone.utc))   # what the UI sends
db.add(po); db.flush()
po.received_date = datetime.now()                                 # legacy purchase_orders.py (OS local time)
if not snapshot:
    co = m.CustomerOrder(order_number="CUST-1", customer_name="Juan", order_type="Dine In", tenant_id=t.id, total_amount=25)
    db.add(co)
db.commit()
after = datetime.now(timezone.utc)
truth = {
    "window_start": before.isoformat(), "window_end": after.isoformat(),
    "shift_id": sh.id, "tx_id": tx.id, "po_id": po.id,
    "expected_delivery_utc": "2026-10-20T00:00:00+00:00",
    "os_offset_hours": time.localtime().tm_gmtoff / 3600,
}
json.dump(truth, open(out, "w"))
print("built", "snapshot-shape" if snapshot else "real-like", "db; OS offset", truth["os_offset_hours"])
