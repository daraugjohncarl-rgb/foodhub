"""P0 regression tests: public customer ordering, tracking and staff order management."""
import uuid

import pytest

from conftest import R
import app.models as models


def place_order(client, tenant, items, headers=None, **extra):
    body = {"tenant_id": tenant.id, "customer_name": "Maria", "order_type": "Dine In", "table_number": "5", "items": items, **extra}
    return client.post("/api/v1/customer-orders", json=body, headers=headers or {})


@pytest.fixture
def menu(tenants, make_product):
    tenant_a, tenant_b = tenants
    return {
        "burger": make_product(tenant_a, "Burger", "50.00"),
        "fries": make_product(tenant_a, "Fries", "19.99"),
        "retired": make_product(tenant_a, "Old Special", "10.00", active=False),
        "foreign": make_product(tenant_b, "Foreign Dish", "5.00"),
    }


def test_price_and_total_are_calculated_from_the_database(client, tenants, menu, db):
    tenant_a, _ = tenants
    resp = place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 2}, {"product_id": menu["fries"].id, "quantity": 3}])
    assert resp.status_code == 201, resp.text
    order = db.get(models.CustomerOrder, resp.json()["order_id"])
    assert str(order.total_amount) == "159.97"  # 2*50.00 + 3*19.99
    assert {(i.name, str(i.price)) for i in order.items} == {("Burger", "50.00"), ("Fries", "19.99")}
    assert order.status == "pending"


def test_forged_prices_totals_names_and_status_are_ignored(client, tenants, menu, db):
    tenant_a, _ = tenants
    resp = place_order(
        client, tenant_a,
        [{"product_id": menu["burger"].id, "quantity": 1, "price": "0.01", "name": "Free Burger"}],
        total_amount="0.01", status="completed", tracking_token="mine", order_number="CUST-AAAAAA",
    )
    assert resp.status_code == 201
    order = db.get(models.CustomerOrder, resp.json()["order_id"])
    assert str(order.total_amount) == "50.00"
    assert order.items[0].name == "Burger" and str(order.items[0].price) == "50.00"
    assert order.status == "pending"
    assert order.order_number != "CUST-AAAAAA" and order.tracking_token != "mine"


@pytest.mark.parametrize("quantity", [0, -1, 51, 1000, "abc", 1.5, None])
def test_invalid_quantities_are_rejected(client, tenants, menu, quantity):
    tenant_a, _ = tenants
    resp = place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": quantity}])
    assert resp.status_code in (400, 422)


def test_order_size_limits(client, tenants, menu):
    tenant_a, _ = tenants
    too_many_lines = [{"product_id": menu["burger"].id, "quantity": 1}] * 51
    assert place_order(client, tenant_a, too_many_lines).status_code == 422
    too_many_units = [{"product_id": menu["burger"].id, "quantity": 50}] * 5  # 250 units
    assert place_order(client, tenant_a, too_many_units).status_code == 400
    assert place_order(client, tenant_a, []).status_code == 422
    assert place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 1}], notes="x" * 501).status_code == 422


def test_cross_tenant_inactive_and_unknown_products_are_rejected(client, tenants, menu):
    tenant_a, _ = tenants
    for product_id in (menu["foreign"].id, menu["retired"].id, 999999):
        assert place_order(client, tenant_a, [{"product_id": product_id, "quantity": 1}]).status_code == 400


def test_unknown_or_missing_tenant_is_rejected(client, tenants, menu):
    resp = client.post("/api/v1/customer-orders", json={"tenant_id": 424242, "items": [{"product_id": menu["burger"].id, "quantity": 1}]})
    assert resp.status_code == 400
    resp = client.post("/api/v1/customer-orders", json={"items": [{"product_id": menu["burger"].id, "quantity": 1}]})
    assert resp.status_code == 400  # two active tenants: no silent default


def test_order_reference_and_token_are_unpredictable(client, tenants, menu):
    tenant_a, _ = tenants
    item = [{"product_id": menu["burger"].id, "quantity": 1}]
    first, second = place_order(client, tenant_a, item).json(), place_order(client, tenant_a, item).json()
    assert first["order_number"] != second["order_number"]
    assert len(first["order_number"]) >= len("CUST-") + 12
    assert len(first["tracking_token"]) >= 30 and first["tracking_token"] != second["tracking_token"]


def test_tracking_requires_matching_token(client, tenants, menu):
    tenant_a, _ = tenants
    created = place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 1}]).json()
    url = f"/api/v1/customer-orders/track/{created['order_number']}"

    assert client.get(url).status_code == 404  # no token
    assert client.get(url, headers={"X-Tracking-Token": "wrong"}).status_code == 404
    assert client.get(url + "?token=" + created["tracking_token"]).status_code == 404  # query param is not accepted
    ok = client.get(url, headers={"X-Tracking-Token": created["tracking_token"]})
    assert ok.status_code == 200 and ok.json()["status"] == "pending"
    assert "tracking_token" not in ok.json()
    # A token from another order never works.
    other = place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 1}]).json()
    assert client.get(url, headers={"X-Tracking-Token": other["tracking_token"]}).status_code == 404


def test_legacy_order_without_token_is_not_trackable(client, tenants, db):
    tenant_a, _ = tenants
    db.add(models.CustomerOrder(order_number="CUST-LEGACY", customer_name="x", order_type="Dine In", tenant_id=tenant_a.id, total_amount=1, tracking_token=None))
    db.commit()
    assert client.get("/api/v1/customer-orders/track/CUST-LEGACY").status_code == 404
    assert client.get("/api/v1/customer-orders/track/CUST-LEGACY", headers={"X-Tracking-Token": ""}).status_code == 404


def test_tracking_enumeration_is_throttled(client, tenants, menu, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
    codes = [client.get(f"/api/v1/customer-orders/track/CUST-{i:012d}", headers={"X-Tracking-Token": "guess"}).status_code for i in range(15)]
    assert codes[0] == 404 and 429 in codes


def test_order_history_is_staff_only_and_tenant_scoped(client, tenants, menu, make_user, login):
    tenant_a, tenant_b = tenants
    place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 1}], customer_name="Alice A")
    make_user("cash_b", R.CASHIER, tenant_b)
    make_user("cust", R.CUSTOMER, tenant_a)
    make_user("cash_a", R.CASHIER, tenant_a)

    assert client.get("/api/v1/customer-orders/history").status_code == 401
    assert client.get("/api/v1/customer-orders/history", headers=login("cust")).status_code == 403
    assert client.get("/api/v1/customer-orders/history", headers=login("cash_b")).json() == []
    mine = client.get("/api/v1/customer-orders/history", headers=login("cash_a")).json()
    assert [o["customer_name"] for o in mine] == ["Alice A"]
    assert client.get("/api/v1/customer-orders/history?limit=1000", headers=login("cash_a")).status_code == 422


def test_status_update_requires_staff_in_same_tenant(client, tenants, menu, make_user, login):
    tenant_a, tenant_b = tenants
    created = place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 1}]).json()
    url = f"/api/v1/customer-orders/{created['order_id']}/status"
    make_user("cash_a", R.CASHIER, tenant_a)
    make_user("cash_b", R.CASHIER, tenant_b)
    make_user("cust", R.CUSTOMER, tenant_a)
    make_user("cook_b", R.KITCHEN, tenant_b)

    assert client.put(url, json={"status": "accepted"}).status_code == 401
    assert client.put(url, json={"status": "accepted"}, headers=login("cust")).status_code == 403
    assert client.put(url, json={"status": "accepted"}, headers=login("cash_b")).status_code == 404
    kitchen_url = f"/api/v1/kitchen/orders/CUST-{created['order_id']}/status"
    assert client.put(kitchen_url, json={"status": "completed"}, headers=login("cook_b")).status_code == 404
    assert client.put(url, json={"status": "accepted"}, headers=login("cash_a")).status_code == 200


def test_invalid_status_values_and_transitions(client, tenants, menu, make_user, login):
    tenant_a, _ = tenants
    created = place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 1}]).json()
    url = f"/api/v1/customer-orders/{created['order_id']}/status"
    make_user("cash_a", R.CASHIER, tenant_a)
    headers = login("cash_a")

    assert client.put(url, json={"status": "paid"}, headers=headers).status_code == 400
    assert client.put(url, json={}, headers=headers).status_code == 400
    assert client.put(url, json={"status": "accepted"}, headers=headers).status_code == 200
    assert client.put(url, json={"status": "pending"}, headers=headers).status_code == 409  # cannot go backwards
    assert client.put(url, json={"status": "completed"}, headers=headers).status_code == 200
    assert client.put(url, json={"status": "rejected"}, headers=headers).status_code == 409  # final state is locked


def test_duplicate_submission_with_idempotency_key_creates_one_order(client, tenants, menu, db):
    tenant_a, _ = tenants
    key = str(uuid.uuid4())
    item = [{"product_id": menu["burger"].id, "quantity": 1}]
    first = place_order(client, tenant_a, item, headers={"Idempotency-Key": key})
    second = place_order(client, tenant_a, item, headers={"Idempotency-Key": key})
    assert first.status_code == 201 and second.status_code in (200, 201)
    assert first.json()["order_id"] == second.json()["order_id"]
    assert first.json()["tracking_token"] == second.json()["tracking_token"]
    assert db.query(models.CustomerOrder).count() == 1
    # The same key under a different tenant is a different order.
    other = place_order(client, tenants[1], [{"product_id": menu["foreign"].id, "quantity": 1}], headers={"Idempotency-Key": key})
    assert other.status_code == 201 and other.json()["order_id"] != first.json()["order_id"]


def test_public_order_submission_is_rate_limited(client, tenants, menu, monkeypatch):
    tenant_a, _ = tenants
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
    codes = [place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 1}]).status_code for _ in range(13)]
    assert codes[:10] == [201] * 10
    assert 429 in codes[10:]


def test_public_menu_is_scoped_and_requires_a_valid_branch(client, tenants, menu):
    tenant_a, _ = tenants
    resp = client.get(f"/api/v1/customer-orders/menu?tenant_id={tenant_a.id}")
    names = {p["name"] for category in resp.json() for p in category["products"]}
    assert names == {"Burger", "Fries"}  # no inactive, no other tenant
    assert client.get("/api/v1/customer-orders/menu?tenant_id=424242").status_code == 400
    assert client.get("/api/v1/customer-orders/menu").status_code == 400


def test_pending_orders_are_tenant_scoped(client, tenants, menu, make_user, login):
    tenant_a, tenant_b = tenants
    place_order(client, tenant_a, [{"product_id": menu["burger"].id, "quantity": 1}])
    make_user("cash_a", R.CASHIER, tenant_a)
    make_user("cash_b", R.CASHIER, tenant_b)
    assert len(client.get("/api/v1/customer-orders/pending", headers=login("cash_a")).json()) == 1
    assert client.get("/api/v1/customer-orders/pending", headers=login("cash_b")).json() == []
