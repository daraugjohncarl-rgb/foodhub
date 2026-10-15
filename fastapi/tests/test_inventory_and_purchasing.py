"""Inventory, wastage, stock ledger, purchase orders, suppliers, catalogue, tables and seeding
(H3, H4, H5, H6, H7, M5, M6, M7, M8, M10, M12)."""
import threading
from decimal import Decimal

import pytest

import app.models as m
from conftest import PASSWORD


@pytest.fixture
def inv(login):
    return login("inventory")


# ── H5 / M6: inventory create & adjust ───────────────────────────────────────

def test_create_without_sku_is_deterministic_and_records_opening_stock(client, world, inv, db):
    r = client.post("/api/v1/inventory", headers=inv, json={"name": "Garlic", "unit": "kg", "quantity": "3.5"})
    assert r.status_code == 201, r.text
    sku = r.json()["sku"]
    assert sku.startswith("INV-")
    from app.seed import stable_code
    assert sku == stable_code("INV", str(world.t1.id), "garlic")
    movement = db.query(m.StockMovement).one()
    assert movement.movement_type == "OPENING" and movement.quantity_after == Decimal("3.500")
    assert client.post("/api/v1/inventory", headers=inv, json={"name": "garlic", "unit": "kg"}).status_code == 409


def test_adjust_stock_is_decimal_and_logged(client, world, inv, db):
    r = client.put(f"/api/v1/inventory/{world.rice.id}/stock", headers=inv, json={"quantity_delta": "-0.10", "reason": "count"})
    assert r.status_code == 200 and r.json()["quantity"] == "9.90"
    assert client.put(f"/api/v1/inventory/{world.rice.id}/stock", headers=inv, json={"quantity_delta": "-50"}).status_code == 400
    assert client.put(f"/api/v1/inventory/{world.rice.id}/stock", headers=inv, json={"quantity_delta": "0"}).status_code == 422
    assert db.query(m.StockMovement).filter_by(movement_type="ADJUSTMENT").count() == 1


def test_concurrent_adjustments_do_not_lose_updates(world):
    from fastapi.testclient import TestClient
    from app.main import app

    rice_id = world.rice.id
    with TestClient(app, raise_server_exceptions=False) as c:
        token = c.post("/api/v1/auth/login", data={"username": "inventory", "password": PASSWORD}).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        barrier = threading.Barrier(5)
        codes = []

        def worker():
            barrier.wait()
            codes.append(c.put(f"/api/v1/inventory/{rice_id}/stock", headers=headers, json={"quantity_delta": "1"}).status_code)

        threads = [threading.Thread(target=worker) for _ in range(5)]
        [t.start() for t in threads]
        [t.join() for t in threads]
    assert codes == [200] * 5
    from app.db import SessionLocal
    s = SessionLocal()
    try:
        assert s.get(m.InventoryItem, rice_id).quantity == Decimal("15.00")
    finally:
        s.close()


# ── M12: wastage persists and deducts stock ─────────────────────────────────

def test_wastage_is_persisted_tenant_scoped_and_deducts_stock(client, world, inv, login, db):
    r = client.post("/api/v1/inventory/wastage", headers=inv, json={
        "inventory_item_id": world.rice.id, "quantity": "2", "reason": "Expired shelf-life", "estimated_cost": "120"})
    assert r.status_code == 201, r.text
    assert r.json()["estimated_cost"] == "120.00" and r.json()["logged_by"] == "inventory"
    db.expire_all()
    assert db.get(m.InventoryItem, world.rice.id).quantity == Decimal("8.00")
    listed = client.get("/api/v1/inventory/wastage", headers=inv).json()
    assert len(listed) == 1 and listed[0]["item"] == "Rice"
    assert client.get("/api/v1/inventory/wastage", headers=login("inventory2")).json() == []
    bad = client.post("/api/v1/inventory/wastage", headers=inv, json={
        "inventory_item_id": world.rice.id, "quantity": "-1", "reason": "Expired shelf-life"})
    assert bad.status_code == 422
    too_much = client.post("/api/v1/inventory/wastage", headers=inv, json={
        "inventory_item_id": world.rice.id, "quantity": "100", "reason": "Expired shelf-life"})
    assert too_much.status_code == 409
    other = client.post("/api/v1/inventory/wastage", headers=login("inventory2"), json={
        "inventory_item_id": world.rice.id, "quantity": "1", "reason": "Expired shelf-life"})
    assert other.status_code == 404


# ── M5: masterlist import ────────────────────────────────────────────────────

def test_masterlist_import_dedupes_and_preserves_manual_changes(client, world, inv, db):
    first = client.post("/api/v1/inventory/import-masterlist", headers=inv).json()
    from app.routers.inventory import MASTERLIST_DATA
    unique_names = {n.strip().lower() for rows in MASTERLIST_DATA.values() for n, *_ in rows}
    assert first["created_count"] == len(unique_names) - 1        # 'Rice' already existed
    flour = db.query(m.InventoryItem).filter_by(tenant_id=world.t1.id, name="Flour").one()
    assert flour.category == "Kitchen"                            # first department wins, no overwrite
    flour.category = "Bakery"
    db.commit()
    second = client.post("/api/v1/inventory/import-masterlist", headers=inv).json()
    assert second["created_count"] == 0
    db.expire_all()
    assert db.query(m.InventoryItem).filter_by(tenant_id=world.t1.id, name="Flour").one().category == "Bakery"
    laptop = db.query(m.InventoryItem).filter_by(tenant_id=world.t1.id, name="Laptop").one()
    assert laptop.item_type == "equipment"
    skus = [i.sku for i in db.query(m.InventoryItem).filter_by(tenant_id=world.t1.id)]
    assert len(skus) == len(set(skus))
    low = client.get("/api/v1/inventory?low_stock_only=true&limit=1000", headers=inv).json()
    assert all(item["item_type"] == "consumable" for item in low)


# ── H7: deletion safety ──────────────────────────────────────────────────────

def _make_po(client, world, inv, qty="10"):
    r = client.post("/api/v1/purchase-orders", headers=inv, json={
        "supplier_id": world.supplier.id, "items": [{"inventory_item_id": world.rice.id, "quantity": qty, "unit_cost": "5"}]})
    assert r.status_code == 201, r.text
    return r.json()


def test_referenced_inventory_item_and_supplier_cannot_be_deleted(client, world, inv, db):
    po = _make_po(client, world, inv)
    r = client.delete(f"/api/v1/inventory/{world.rice.id}", headers=inv)
    assert r.status_code == 409 and "Deactivate" in r.json()["detail"]
    assert db.query(m.PurchaseOrderItem).count() == 1
    r = client.put(f"/api/v1/inventory/{world.rice.id}/status?is_active=false", headers=inv)
    assert r.status_code == 200 and r.json()["is_active"] is False
    assert world.rice.id not in [i["id"] for i in client.get("/api/v1/inventory", headers=inv).json()]
    assert client.delete(f"/api/v1/suppliers/{world.supplier.id}", headers=inv).status_code == 409
    assert client.get(f"/api/v1/purchase-orders/{po['id']}", headers=inv).json()["total_amount"] == "50.00"


def test_unreferenced_records_can_be_deleted(client, world, inv):
    r = client.post("/api/v1/inventory", headers=inv, json={"name": "Temp", "unit": "pcs"})
    assert client.delete(f"/api/v1/inventory/{r.json()['id']}", headers=inv).status_code == 204
    s = client.post("/api/v1/suppliers", headers=inv, json={"supplier_name": "Unused"}).json()
    assert client.delete(f"/api/v1/suppliers/{s['id']}", headers=inv).status_code == 204


# ── H6: purchase-order state machine ────────────────────────────────────────

def test_po_cannot_be_marked_received_without_receiving(client, world, inv):
    po = _make_po(client, world, inv)
    r = client.put(f"/api/v1/purchase-orders/{po['id']}", headers=inv, json={"status": "Received"})
    assert r.status_code == 409
    assert client.post(f"/api/v1/purchase-orders/{po['id']}/receive", headers=inv).status_code == 409   # still Draft


def test_po_full_flow_with_partial_receipt(client, world, inv, db):
    po = _make_po(client, world, inv, qty="10")
    line_id = po["items"][0]["id"]
    assert client.put(f"/api/v1/purchase-orders/{po['id']}", headers=inv, json={"status": "Ordered"}).status_code == 200
    r = client.post(f"/api/v1/purchase-orders/{po['id']}/receive", headers=inv, json={"lines": [{"item_id": line_id, "quantity": "4"}]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "Partially Received" and r.json()["items"][0]["quantity_received"] == "4.00"
    db.expire_all()
    assert db.get(m.InventoryItem, world.rice.id).quantity == Decimal("14.00")
    over = client.post(f"/api/v1/purchase-orders/{po['id']}/receive", headers=inv, json={"lines": [{"item_id": line_id, "quantity": "7"}]})
    assert over.status_code == 422
    r = client.post(f"/api/v1/purchase-orders/{po['id']}/receive", headers=inv)
    assert r.status_code == 200 and r.json()["status"] == "Received" and r.json()["received_date"]
    db.expire_all()
    assert db.get(m.InventoryItem, world.rice.id).quantity == Decimal("20.00")
    assert client.post(f"/api/v1/purchase-orders/{po['id']}/receive", headers=inv).status_code == 400
    assert client.put(f"/api/v1/purchase-orders/{po['id']}", headers=inv, json={"status": "Cancelled"}).status_code == 400
    receipts = db.query(m.StockMovement).filter_by(movement_type="RECEIPT").all()
    assert sorted(r.quantity_delta for r in receipts) == [Decimal("4.000"), Decimal("6.000")]


def test_invalid_transitions_and_deletes(client, world, inv):
    po = _make_po(client, world, inv)
    assert client.put(f"/api/v1/purchase-orders/{po['id']}", headers=inv, json={"status": "Ordered"}).status_code == 200
    assert client.put(f"/api/v1/purchase-orders/{po['id']}", headers=inv, json={"status": "Draft"}).status_code == 409
    assert client.delete(f"/api/v1/purchase-orders/{po['id']}", headers=inv).status_code == 409
    assert client.put(f"/api/v1/purchase-orders/{po['id']}", headers=inv, json={"status": "Cancelled"}).status_code == 200
    assert client.post(f"/api/v1/purchase-orders/{po['id']}/receive", headers=inv).status_code == 400


def test_concurrent_receive_adds_stock_once(world, db):
    from fastapi.testclient import TestClient
    from app.main import app

    rice_id, supplier_id = world.rice.id, world.supplier.id
    with TestClient(app, raise_server_exceptions=False) as c:
        token = c.post("/api/v1/auth/login", data={"username": "inventory", "password": PASSWORD}).json()["access_token"]
        h = {"Authorization": f"Bearer {token}"}
        po = c.post("/api/v1/purchase-orders", headers=h, json={
            "supplier_id": supplier_id, "items": [{"inventory_item_id": rice_id, "quantity": "10", "unit_cost": "5"}]}).json()
        c.put(f"/api/v1/purchase-orders/{po['id']}", headers=h, json={"status": "Ordered"})
        barrier = threading.Barrier(4)
        codes = []

        def worker():
            barrier.wait()
            codes.append(c.post(f"/api/v1/purchase-orders/{po['id']}/receive", headers=h).status_code)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        [t.start() for t in threads]
        [t.join() for t in threads]
    assert sorted(codes) == [200, 400, 400, 400], codes
    db.expire_all()
    assert db.get(m.InventoryItem, rice_id).quantity == Decimal("20.00")


def test_po_numbers_are_sequential_per_branch(client, world, inv):
    numbers = [_make_po(client, world, inv)["po_number"] for _ in range(3)]
    assert [n.split("-")[-1] for n in numbers] == ["0001", "0002", "0003"]


# ── M7 / M8: product updates and images ─────────────────────────────────────

def test_product_null_fields_are_422_not_409(client, world, login):
    h = login("admin")
    assert client.put(f"/api/v1/products/{world.coke.id}", headers=h, json={"price": None}).status_code == 422
    assert client.put(f"/api/v1/products/{world.coke.id}", headers=h, json={"name": None}).status_code == 422
    assert client.put(f"/api/v1/products/{world.coke.id}", headers=h, json={"price": "30"}).json()["price"] == "30.00"
    r = client.put(f"/api/v1/products/{world.coke.id}", headers=h, json={"name": "Burger"})
    assert r.status_code == 409 and "Burger" in r.json()["detail"]


def test_product_image_limits(client, world, login):
    h = login("admin")
    base = {"name": "Img", "sku": "IMG-1", "price": "1", "cost": "1"}
    huge = "data:image/png;base64," + "A" * 5_000_000
    assert client.post("/api/v1/products", headers=h, json={**base, "image_url": huge}).status_code == 422
    assert client.post("/api/v1/products", headers=h, json={**base, "image_url": "javascript:alert(1)"}).status_code == 422
    assert client.post("/api/v1/products", headers=h, json={**base, "image_url": "data:text/html;base64,AAAA"}).status_code == 422
    small = "data:image/png;base64," + "A" * 1000
    assert client.post("/api/v1/products", headers=h, json={**base, "image_url": small}).status_code == 201
    # Legacy relative forms still accepted (the customer page resolves them); traversal and schemes are not.
    for i, legacy in enumerate(["burger solo.png", "images/coffee/iced coffe.png", "assets/images/BLES.png"]):
        r = client.post("/api/v1/products", headers=h, json={**base, "name": f"L{i}", "sku": f"L-{i}", "image_url": legacy})
        assert r.status_code == 201, (legacy, r.text)
    for bad in ["../../etc/passwd.png", "javascript:x.png", "vbscript:alert(1)"]:
        r = client.post("/api/v1/products", headers=h, json={**base, "name": "bad", "sku": "BAD", "image_url": bad})
        assert r.status_code == 422, bad


def test_cashier_cannot_edit_catalog(client, world, login):
    assert client.put(f"/api/v1/products/{world.coke.id}", headers=login("cashier"), json={"price": "1"}).status_code == 403


# ── M10 / H11: tables ────────────────────────────────────────────────────────

def test_tables_unique_per_branch_and_super_admin_can_manage(client, world, login, db):
    sa = login("superadmin")
    assert client.post(f"/api/v1/tables?tenant_id={world.t1.id}", headers=sa, json={"table_number": "1"}).status_code == 201
    assert client.post("/api/v1/tables", headers=login("admin"), json={"table_number": "1"}).status_code == 400
    assert client.post("/api/v1/tables", headers=login("admin2"), json={"table_number": "1"}).status_code == 201
    assert client.post("/api/v1/tables", headers=login("cashier"), json={"table_number": "3"}).status_code == 403
    from sqlalchemy.exc import IntegrityError
    db.add(m.RestaurantTable(tenant_id=world.t1.id, table_number="1"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_table_with_orders_is_deactivated_not_deleted(client, world, login, db):
    admin = login("admin")
    table = client.post("/api/v1/tables", headers=admin, json={"table_number": "5"}).json()
    client.post("/api/v1/customer-orders", json={"tenant_id": world.t1.id, "customer_name": "A", "table_number": "5",
                                                 "items": [{"product_id": world.coke.id, "quantity": 1}]})
    assert client.delete(f"/api/v1/tables/{table['id']}", headers=admin).status_code == 409
    assert client.put(f"/api/v1/tables/{table['id']}", headers=admin, json={"status": "inactive"}).json()["status"] == "inactive"


# ── H3 / H4: seeding ─────────────────────────────────────────────────────────

def test_demo_seed_is_complete_deterministic_and_idempotent(db):
    from app.seed import seed_demo_data, stable_code, ensure_essentials
    from app.seed_data import POS_MENU_MASTERLIST
    tenant = ensure_essentials(db)
    report = seed_demo_data(db, tenant)
    expected = sum(len(items) for items in POS_MENU_MASTERLIST.values())
    assert report["failed"] == [] and report["products"] == expected == 125
    assert db.query(m.Product).filter_by(tenant_id=tenant.id).count() == 125
    frappe = db.query(m.Product).filter_by(name="Mango Frappe — 16 oz").one()
    sticky = db.query(m.Product).filter_by(name="Mango — 16 oz").one()
    assert (frappe.price, sticky.price) == (Decimal("80.00"), Decimal("75.00"))
    assert frappe.sku == stable_code("POS", "Mango Frappe — 16 oz")
    again = seed_demo_data(db, tenant)
    assert again["products"] == 0 and again["users"] == 0
    demo = db.query(m.User).filter_by(username="admin").one()
    assert demo.must_change_password is True


def test_skus_do_not_depend_on_python_hash_seed():
    import subprocess, sys, os
    from conftest import APP_DIR
    code = "from app.seed import stable_code; print(stable_code('POS', 'Kropek'))"
    outputs = {
        subprocess.run([sys.executable, "-c", code], cwd=APP_DIR, capture_output=True, text=True,
                       env={**os.environ, "PYTHONHASHSEED": seed}).stdout.strip()
        for seed in ("1", "2", "3")
    }
    assert len(outputs) == 1


def test_no_default_super_admin_in_production(db, monkeypatch):
    from app.seed import ensure_essentials
    monkeypatch.delenv("INITIAL_SUPERADMIN_PASSWORD", raising=False)
    ensure_essentials(db)
    assert db.query(m.User).filter_by(role=m.UserRole.SUPER_ADMIN).count() == 0
    monkeypatch.setenv("INITIAL_SUPERADMIN_PASSWORD", "short")
    from app.seed import SeedError
    with pytest.raises(SeedError):
        ensure_essentials(db)
    monkeypatch.setenv("INITIAL_SUPERADMIN_PASSWORD", "A-long-initial-pass-1")
    ensure_essentials(db)
    owner = db.query(m.User).filter_by(role=m.UserRole.SUPER_ADMIN).one()
    assert owner.must_change_password is True
