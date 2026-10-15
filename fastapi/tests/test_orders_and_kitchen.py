"""Customer QR orders (C1, H2, M9, M10) and the kitchen display (C9, M1, M2)."""
from datetime import datetime, timezone

import pytest

import app.models as m


def place(client, items, **extra):
    payload = {"customer_name": "Juan", "order_type": "Dine In", "items": items}
    payload.update(extra)
    return client.post("/api/v1/customer-orders", json=payload)


# ── H2: public order validation ──────────────────────────────────────────────

def test_public_order_happy_path_server_prices_and_number(client, world):
    r = place(client, [{"product_id": world.burger.id, "quantity": 2}], order_number="MINE-1", tenant_id=world.t1.id)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["order_number"].startswith("CUST-") and body["order_number"] != "MINE-1"
    assert body["total_amount"] == "191.00"
    assert len(body["tracking_token"]) >= 20


@pytest.mark.parametrize("payload_change,expected", [
    ({"items": [{"product_id": 0, "quantity": 1}]}, 422),
    ({"items": [{"product_id": 1, "quantity": 51}]}, 422),
    ({"items": []}, 422),
    ({"customer_name": ""}, 422),
    ({"customer_name": "x" * 101}, 422),
    ({"notes": "n" * 501}, 422),
    ({"order_type": "Drive Thru"}, 422),
    ({"tenant_id": "abc"}, 422),
    ({"tenant_id": 999999}, 404),
])
def test_public_order_rejects_bad_input(client, world, payload_change, expected):
    payload = {"customer_name": "Juan", "order_type": "Dine In", "items": [{"product_id": world.coke.id, "quantity": 1}]}
    payload.update(payload_change)
    assert client.post("/api/v1/customer-orders", json=payload).status_code == expected


def test_public_order_cannot_use_other_branch_products(client, world):
    r = place(client, [{"product_id": world.t2_product.id, "quantity": 1}], tenant_id=world.t1.id)
    assert r.status_code == 404


def test_public_order_rate_limit(client, world):
    codes = [place(client, [{"product_id": world.coke.id, "quantity": 1}]).status_code for _ in range(12)]
    assert codes[:10] == [201] * 10 and codes[10] == 429


def test_inactive_or_unknown_table_cannot_order(client, world, db):
    db.add_all([m.RestaurantTable(tenant_id=world.t1.id, table_number="1"),
                m.RestaurantTable(tenant_id=world.t1.id, table_number="2", status="inactive")])
    db.commit()
    item = [{"product_id": world.coke.id, "quantity": 1}]
    assert place(client, item, table_number="1").status_code == 201
    assert place(client, item, table_number="2").status_code == 409
    assert place(client, item, table_number="99").status_code == 409


# ── C1: no anonymous staff operations, tracking by secret token only ────────

def test_anonymous_cannot_change_status_or_read_history(client, world):
    place(client, [{"product_id": world.coke.id, "quantity": 1}])
    assert client.put("/api/v1/customer-orders/1/status", json={"status": "rejected"}).status_code == 401
    assert client.get("/api/v1/customer-orders/history").status_code == 401
    assert client.get("/api/v1/customer-orders/pending").status_code == 401


def test_tracking_requires_the_secret_token(client, world):
    r = place(client, [{"product_id": world.coke.id, "quantity": 1}], notes="no ice")
    body = r.json()
    assert client.get(f"/api/v1/customer-orders/track/{body['order_number']}").status_code == 404
    tracked = client.get(f"/api/v1/customer-orders/track/{body['tracking_token']}")
    assert tracked.status_code == 200
    data = tracked.json()
    assert data["order_number"] == body["order_number"] and data["status"] == "pending"
    assert "customer_name" not in data and "notes" not in data and "id" not in data


def test_staff_status_changes_are_tenant_scoped(client, world, login, db):
    place(client, [{"product_id": world.coke.id, "quantity": 1}], tenant_id=world.t1.id)
    order_id = db.query(m.CustomerOrder).one().id
    assert client.put(f"/api/v1/customer-orders/{order_id}/status", headers=login("cashier2"),
                      json={"status": "rejected"}).status_code == 404
    assert client.put(f"/api/v1/customer-orders/{order_id}/status", headers=login("kitchen"),
                      json={"status": "rejected"}).status_code == 403
    assert client.put(f"/api/v1/customer-orders/{order_id}/status", headers=login("cashier"),
                      json={"status": "bogus"}).status_code == 422
    assert client.put(f"/api/v1/customer-orders/{order_id}/status", headers=login("cashier"),
                      json={"status": "accepted"}).status_code == 200
    assert client.get("/api/v1/customer-orders/pending", headers=login("cashier2")).json() == []
    history = client.get("/api/v1/customer-orders/history", headers=login("cashier")).json()
    assert len(history) == 1 and history[0]["status"] == "accepted"


def test_super_admin_sees_pending_orders_of_a_branch(client, world, login):
    place(client, [{"product_id": world.coke.id, "quantity": 1}], tenant_id=world.t1.id)
    r = client.get(f"/api/v1/customer-orders/pending?tenant_id={world.t1.id}", headers=login("superadmin"))
    assert r.status_code == 200 and len(r.json()) == 1


# ── M9: checkout links the customer order and completes it atomically ───────

def test_checkout_links_customer_order(client, world, login, db):
    place(client, [{"product_id": world.coke.id, "quantity": 2}], table_number="7")
    order = db.query(m.CustomerOrder).one()
    world.open_shift("cashier")
    h = login("cashier")
    r = client.post("/api/v1/transactions", headers=h,
                    json={"items": [{"product_id": world.coke.id, "quantity": 2}], "customer_order_id": order.id})
    assert r.status_code == 201, r.text
    assert r.json()["customer_order_id"] == order.id and r.json()["table_number"] == "7"
    db.expire_all()
    assert db.get(m.CustomerOrder, order.id).status == "completed"
    again = client.post("/api/v1/transactions", headers=h,
                        json={"items": [{"product_id": world.coke.id, "quantity": 2}], "customer_order_id": order.id})
    assert again.status_code == 409


# ── C9 / M1: kitchen ─────────────────────────────────────────────────────────

@pytest.fixture
def ticket(client, world, login):
    world.open_shift("cashier")
    r = client.post("/api/v1/transactions", headers=login("cashier"),
                    json={"items": [{"product_id": world.coke.id, "quantity": 1}], "order_type": "Take Out"})
    assert r.status_code == 201
    return r.json()["id"]


def test_kitchen_updates_are_tenant_scoped_and_validated(client, world, login, ticket):
    assert client.put(f"/api/v1/kitchen/orders/{ticket}/status", headers=login("admin2"),
                      json={"status": "completed"}).status_code == 404
    assert client.put(f"/api/v1/kitchen/orders/{ticket}/status", headers=login("inventory"),
                      json={"status": "completed"}).status_code == 403
    assert client.put(f"/api/v1/kitchen/orders/{ticket}/status", headers=login("kitchen"),
                      json={"status": "x" * 40}).status_code == 422
    assert client.put(f"/api/v1/kitchen/orders/ORD-{ticket:04d}/status", headers=login("kitchen"),
                      json={"status": "PREPARING"}).status_code == 200
    assert client.put(f"/api/v1/kitchen/orders/{ticket}/status", headers=login("kitchen"),
                      json={"status": "READY"}).status_code == 200
    assert client.put(f"/api/v1/kitchen/orders/{ticket}/status", headers=login("kitchen"),
                      json={"status": "pending"}).status_code == 409


def test_kitchen_does_not_affect_revenue(client, world, login, ticket):
    before = client.get("/api/v1/analytics/dashboard", headers=login("admin")).json()["today_sales"]
    client.put(f"/api/v1/kitchen/orders/{ticket}/status", headers=login("kitchen"), json={"status": "cancelled"})
    after = client.get("/api/v1/analytics/dashboard", headers=login("admin")).json()["today_sales"]
    assert before == after == "25.00"


def test_kitchen_ticket_uses_real_order_type(client, world, login, ticket):
    orders = client.get("/api/v1/kitchen/orders", headers=login("kitchen")).json()
    assert orders[0]["order_type"] == "Take Out" and orders[0]["table"] == "Take Out"
    assert orders[0]["status"] == "PENDING"
    assert client.get("/api/v1/kitchen/orders", headers=login("kitchen2")).json() == []


# ── M2: business-timezone day boundaries ─────────────────────────────────────

def test_manila_midnight_boundary():
    from app.core.timeutils import business_day_bounds_utc, business_today
    # 16:30 UTC on Oct 15 is 00:30 on Oct 16 in Manila (UTC+8).
    assert str(business_today(datetime(2026, 10, 15, 16, 30, tzinfo=timezone.utc))) == "2026-10-16"
    assert str(business_today(datetime(2026, 10, 15, 15, 59, tzinfo=timezone.utc))) == "2026-10-15"
    from datetime import date
    start, end = business_day_bounds_utc(date(2026, 10, 16))
    assert start == datetime(2026, 10, 15, 16, 0, tzinfo=timezone.utc)
    assert end == datetime(2026, 10, 16, 16, 0, tzinfo=timezone.utc)


def test_api_timestamps_are_utc_with_offset(client, world, login, ticket):
    created = client.get("/api/v1/transactions", headers=login("admin")).json()[0]["created_at"]
    assert created.endswith("+00:00")
