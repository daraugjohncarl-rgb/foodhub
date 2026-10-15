"""POS sales: validation, money, atomicity, idempotency, revenue, user deletion, shifts, recipes (C5-C8, M3, M4, M9)."""
import threading
import uuid
from decimal import Decimal

import pytest

import app.models as m
from conftest import PASSWORD


def sale(client, headers, items, **extra):
    return client.post("/api/v1/transactions", headers=headers, json={"items": items, **extra})


@pytest.fixture
def cashier(world, login):
    world.open_shift("cashier", start_cash="500")
    return login("cashier")


# ── C7: validation and server-side money ─────────────────────────────────────

@pytest.mark.parametrize("items", [
    [{"product_id": 1, "quantity": -5}],
    [{"product_id": 1, "quantity": 0}],
    [{"product_id": 1, "quantity": "abc"}],
    [{"product_id": 1, "quantity": 100000}],
    [],
])
def test_malformed_quantities_are_rejected(client, world, cashier, items):
    if items:
        items[0]["product_id"] = world.coke.id
    assert sale(client, cashier, items).status_code == 422


def test_client_cannot_send_totals_or_tax(client, world, cashier):
    r = sale(client, cashier, [{"product_id": world.coke.id, "quantity": 1}], net_amount=0, tax_amount=-10)
    assert r.status_code == 422


def test_exact_decimal_totals_and_change(client, world, cashier, db):
    r = sale(client, cashier, [{"product_id": world.burger.id, "quantity": 3}], payment_method="cash", amount_paid="300")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["total_amount"] == "286.50" and body["net_amount"] == "286.50"
    assert body["amount_tendered"] == "300.00" and body["change_amount"] == "13.50"
    assert body["status"] == "completed" and body["fulfillment_status"] == "pending"
    assert [p["amount"] for p in body["payments"]] == ["286.50"]


def test_duplicate_lines_are_merged(client, world, cashier):
    r = sale(client, cashier, [{"product_id": world.coke.id, "quantity": 1}, {"product_id": world.coke.id, "quantity": 2}])
    assert r.status_code == 201
    assert [(i["product_id"], i["quantity"]) for i in r.json()["items"]] == [(world.coke.id, 3)]


def test_underpayment_and_bad_noncash_amounts(client, world, cashier):
    item = [{"product_id": world.coke.id, "quantity": 2}]   # 50.00
    assert sale(client, cashier, item, payment_method="CASH", amount_paid="49.99").status_code == 422
    assert sale(client, cashier, item, payment_method="GCASH", amount_paid="60").status_code == 422
    assert sale(client, cashier, item, payment_method="GCASH", amount_paid="50").status_code == 201
    assert sale(client, cashier, item, payment_method="BITCOIN").status_code == 422


def test_split_payment(client, world, cashier):
    r = sale(client, cashier, [{"product_id": world.coke.id, "quantity": 4}],   # 100.00
             payments=[{"payment_method": "GCASH", "amount": "40"}, {"payment_method": "CASH", "amount": "100"}])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["change_amount"] == "40.00"
    assert sorted((p["payment_method"], p["amount"]) for p in body["payments"]) == [("CASH", "60.00"), ("GCASH", "40.00")]


def test_discounts_need_a_manager_and_cannot_exceed_subtotal(client, world, cashier, login):
    item = [{"product_id": world.coke.id, "quantity": 2}]
    assert sale(client, cashier, item, discount_amount="5").status_code == 403
    world.open_shift("manager")
    mgr = login("manager")
    assert sale(client, mgr, item, discount_amount="51").status_code == 422
    r = sale(client, mgr, item, discount_amount="5", amount_paid="45")
    assert r.status_code == 201 and r.json()["net_amount"] == "45.00"


def test_cross_tenant_and_inactive_products(client, world, cashier, db):
    assert sale(client, cashier, [{"product_id": world.t2_product.id, "quantity": 1}]).status_code == 404
    world.coke.is_active = False
    db.commit()
    assert sale(client, cashier, [{"product_id": world.coke.id, "quantity": 1}]).status_code == 400


def test_sale_requires_open_shift(client, world, login):
    r = sale(client, login("cashier"), [{"product_id": world.coke.id, "quantity": 1}])
    assert r.status_code == 409 and r.headers.get("x-shift-required") == "1"


def test_kitchen_cannot_ring_up_sales(client, world, login):
    assert sale(client, login("kitchen"), [{"product_id": world.coke.id, "quantity": 1}]).status_code == 403


# ── C7: atomic rollback ──────────────────────────────────────────────────────

def test_failure_mid_sale_leaves_nothing_behind(client, world, cashier, db, monkeypatch):
    from app.routers import transactions as tx_router

    def explode(*a, **k):
        raise RuntimeError("audit write failed")

    monkeypatch.setattr(tx_router.audit, "record", explode)
    r = sale(client, cashier, [{"product_id": world.coke.id, "quantity": 1}])
    assert r.status_code == 500
    db.expire_all()
    assert db.query(m.Transaction).count() == 0
    assert db.query(m.TransactionItem).count() == 0
    assert db.query(m.Payment).count() == 0


# ── C8: idempotent offline retries ───────────────────────────────────────────

def test_retry_with_same_client_tx_id_returns_original(client, world, cashier, db):
    cid = str(uuid.uuid4())
    first = sale(client, cashier, [{"product_id": world.coke.id, "quantity": 2}], client_tx_id=cid)
    retry = sale(client, cashier, [{"product_id": world.coke.id, "quantity": 2}], client_tx_id=cid)
    assert first.status_code == 201 and retry.status_code == 200
    assert retry.json()["id"] == first.json()["id"] and retry.json()["replayed"] is True
    assert db.query(m.Transaction).count() == 1


def test_same_client_tx_id_with_different_contents_conflicts(client, world, cashier):
    cid = str(uuid.uuid4())
    assert sale(client, cashier, [{"product_id": world.coke.id, "quantity": 2}], client_tx_id=cid).status_code == 201
    assert sale(client, cashier, [{"product_id": world.coke.id, "quantity": 3}], client_tx_id=cid).status_code == 409


def test_same_client_tx_id_allowed_in_another_branch(client, world, cashier, login):
    cid = str(uuid.uuid4())
    world.open_shift("cashier2")
    assert sale(client, cashier, [{"product_id": world.coke.id, "quantity": 1}], client_tx_id=cid).status_code == 201
    r = sale(client, login("cashier2"), [{"product_id": world.t2_product.id, "quantity": 1}], client_tx_id=cid)
    assert r.status_code == 201


def test_concurrent_retries_create_one_sale(world, db):
    """Two simultaneous requests with the same client_tx_id (real threads, real PostgreSQL)."""
    from fastapi.testclient import TestClient
    from app.main import app

    world.open_shift("cashier")
    coke_id = world.coke.id   # read before the threads start; ORM objects are not thread-safe
    cid = str(uuid.uuid4())
    results = []
    with TestClient(app, raise_server_exceptions=False) as c:
        token = c.post("/api/v1/auth/login", data={"username": "cashier", "password": PASSWORD}).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        barrier = threading.Barrier(4)

        def worker():
            barrier.wait()
            results.append(sale(c, headers, [{"product_id": coke_id, "quantity": 1}], client_tx_id=cid).status_code)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    db.expire_all()
    assert db.query(m.Transaction).filter_by(client_tx_id=cid).count() == 1
    assert sorted(results).count(201) == 1 and all(s in (200, 201) for s in results), results


# ── C6: revenue independent of the kitchen ──────────────────────────────────

def test_paid_sale_counts_in_dashboard_immediately(client, world, cashier, login):
    sale(client, cashier, [{"product_id": world.burger.id, "quantity": 2}])
    r = client.get("/api/v1/analytics/dashboard", headers=login("admin"))
    assert r.status_code == 200
    assert Decimal(r.json()["today_sales"]) == Decimal("191.00")
    assert r.json()["total_transactions_today"] == 1
    # The other branch sees nothing of it.
    assert Decimal(client.get("/api/v1/analytics/dashboard", headers=login("admin2")).json()["today_sales"]) == 0


def test_legacy_kitchen_states_still_count_and_voided_do_not(client, world, db, login):
    shift = world.open_shift("cashier")
    for status_value in ("pending", "preparing", "ready", "voided"):
        db.add(m.Transaction(tenant_id=world.t1.id, shift_id=shift.id, user_id=world.users["cashier"].id,
                             total_amount=10, net_amount=10, status=status_value))
    db.commit()
    r = client.get("/api/v1/analytics/dashboard", headers=login("manager"))
    assert Decimal(r.json()["today_sales"]) == Decimal("30.00") and r.json()["total_transactions_today"] == 3


def test_cashier_sees_only_own_sales_and_total_header(client, world, cashier, login):
    sale(client, cashier, [{"product_id": world.coke.id, "quantity": 1}])
    world.open_shift("manager")
    sale(client, login("manager"), [{"product_id": world.coke.id, "quantity": 1}])
    mine = client.get("/api/v1/transactions", headers=cashier)
    assert mine.headers["x-total-count"] == "1" and len(mine.json()) == 1
    everyone = client.get("/api/v1/transactions?limit=1", headers=login("admin"))
    assert everyone.headers["x-total-count"] == "2" and len(everyone.json()) == 1


# ── C5: deleting a user never deletes history ───────────────────────────────

def test_user_with_sales_cannot_be_deleted_and_history_survives(client, world, cashier, login, db):
    sale(client, cashier, [{"product_id": world.coke.id, "quantity": 1}])
    admin = login("admin")
    cashier_id = world.users["cashier"].id
    assert client.delete(f"/api/v1/users/{cashier_id}", headers=admin).status_code == 409
    assert client.put(f"/api/v1/users/{cashier_id}/status", headers=admin).json()["is_active"] is False
    db.expire_all()
    assert db.query(m.Transaction).count() == 1 and db.query(m.Payment).count() == 1
    assert db.query(m.Shift).count() == 1
    assert client.get("/api/v1/transactions", headers=admin).json()[0]["cashier"] == "cashier"


def test_user_without_history_can_be_deleted(client, world, login):
    assert client.delete(f"/api/v1/users/{world.users['kitchen'].id}", headers=login("admin")).status_code == 204


def test_database_refuses_to_cascade_sales_when_user_row_is_deleted(world, db):
    """Defence in depth: even a raw ORM delete cannot take sales history with it (FK RESTRICT, no ORM cascade)."""
    from sqlalchemy.exc import IntegrityError
    shift = world.open_shift("cashier")
    db.add(m.Transaction(tenant_id=world.t1.id, shift_id=shift.id, user_id=world.users["cashier"].id,
                         total_amount=1, net_amount=1, status="completed"))
    db.commit()
    db.delete(db.get(m.User, world.users["cashier"].id))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    assert db.query(m.Transaction).count() == 1


# ── M3: shift reconciliation ─────────────────────────────────────────────────

def test_shift_expected_cash_and_variance(client, world, login):
    h = login("cashier")
    assert client.post("/api/v1/shifts/start", headers=h, json={"start_cash": "500"}).status_code == 200
    assert client.post("/api/v1/shifts/start", headers=h, json={"start_cash": "1"}).status_code == 400
    sale(client, h, [{"product_id": world.burger.id, "quantity": 1}], amount_paid="100")         # cash 95.50, change 4.50
    sale(client, h, [{"product_id": world.coke.id, "quantity": 2}], payment_method="CARD")        # card 50, not in drawer
    client.post("/api/v1/shifts/cash-movement", headers=h, json={"type": "PAID_OUT", "amount": "20", "reason": "ice"})
    client.post("/api/v1/shifts/cash-movement", headers=h, json={"type": "PAID_IN", "amount": "10"})
    r = client.put("/api/v1/shifts/end", headers=h, json={"end_cash": "580"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert Decimal(body["expected_cash"]) == Decimal("585.50")
    assert Decimal(body["cash_variance"]) == Decimal("-5.50")
    assert client.get("/api/v1/shifts/active", headers=h).json() is None


# ── M4: recipes deduct stock atomically ──────────────────────────────────────

def test_recipe_deduction_and_insufficient_stock_rollback(client, world, cashier, login, db):
    admin = login("admin")
    r = client.put(f"/api/v1/products/{world.burger.id}/recipe", headers=admin,
                   json={"lines": [{"inventory_item_id": world.rice.id, "quantity": "0.25"}]})
    assert r.status_code == 200 and r.json()[0]["inventory_item_name"] == "Rice"

    assert sale(client, cashier, [{"product_id": world.burger.id, "quantity": 4}]).status_code == 201
    db.expire_all()
    assert db.get(m.InventoryItem, world.rice.id).quantity == Decimal("9.00")
    movement = db.query(m.StockMovement).one()
    assert movement.movement_type == "SALE" and movement.quantity_delta == Decimal("-1.000")

    r = sale(client, cashier, [{"product_id": world.burger.id, "quantity": 40}])   # needs 10 kg, only 9 left
    assert r.status_code == 409 and "Not enough stock" in r.json()["detail"]
    db.expire_all()
    assert db.get(m.InventoryItem, world.rice.id).quantity == Decimal("9.00")
    assert db.query(m.Transaction).count() == 1

    # Products without a recipe deduct nothing.
    assert sale(client, cashier, [{"product_id": world.coke.id, "quantity": 1}]).status_code == 201
    db.expire_all()
    assert db.query(m.StockMovement).count() == 1


def test_idempotent_retry_does_not_deduct_twice(client, world, cashier, login, db):
    client.put(f"/api/v1/products/{world.burger.id}/recipe", headers=login("admin"),
               json={"lines": [{"inventory_item_id": world.rice.id, "quantity": "1"}]})
    cid = str(uuid.uuid4())
    sale(client, cashier, [{"product_id": world.burger.id, "quantity": 2}], client_tx_id=cid)
    sale(client, cashier, [{"product_id": world.burger.id, "quantity": 2}], client_tx_id=cid)
    db.expire_all()
    assert db.get(m.InventoryItem, world.rice.id).quantity == Decimal("8.00")
