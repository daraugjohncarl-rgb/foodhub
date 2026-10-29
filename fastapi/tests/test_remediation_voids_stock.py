"""
Cashier ordering remediation (2026-10-27): payment-line integrity, strict money parsing, explicit cash
classification, the void / manual-refund workflow, one locked status path for customer orders (customer-
orders API and kitchen API), kitchen limits on POS sales, reconciliation of half-finished online orders,
and recipe-based stock deduction (INVENTORY_DEDUCTION=on_sale, off by default).

These run on SQLite: they prove application logic and database constraints, NOT PostgreSQL row locking.
The PostgreSQL concurrency checks live in test_postgres_concurrency.py (needs TEST_POSTGRES_URL).
"""
from decimal import Decimal

import pytest

import app.models as models
from conftest import R
from test_online_orders_payments import (  # noqa: F401  (fixtures are used by name)
    KEY_A, KEY_B, shop, events, order, verify, sale, cart_sale, fresh,
)

KEY_C = "cccccccc-0000-0000-0000-000000000003"


def void(client, shop, tx_id, who="cash", reason="Customer changed mind", status="cancelled"):
    body = {"status": status}
    if reason is not None:
        body["reason"] = reason
    return client.put(f"/api/v1/transactions/{tx_id}/status", headers=shop[who], json=body)


def refund(client, shop, tx_id, who="mgr", **body):
    body.setdefault("note", "Cash handed back at the counter")
    return client.post(f"/api/v1/transactions/{tx_id}/refund", headers=shop[who], json=body)


def drawer(client, shop, who="cash"):
    data = client.get("/api/v1/shifts/drawer-summary", headers=shop[who]).json()
    return next(s for s in data["shifts"] if s["status"] == "open")


# =========================================================================== checkout integrity
def test_split_payment_lines_must_add_up_to_exactly_the_amount_due(client, shop, db):
    over = cart_sale(client, shop, payments=[{"payment_method": "CASH", "amount": "500"}])
    assert over.status_code == 400 and db.query(models.Payment).count() == 0   # would have inflated the drawer
    short = cart_sale(client, shop, payments=[{"payment_method": "CASH", "amount": "40"}])
    assert short.status_code == 400
    ok = cart_sale(client, shop, payments=[{"payment_method": "cash", "amount": "60"},
                                           {"payment_method": "Card", "amount": "40.00"}])
    assert ok.status_code == 201
    rows = sorted((p.payment_method, str(p.amount)) for p in db.query(models.Payment).all())
    assert rows == [("CARD", "40.00"), ("CASH", "60.00")]
    assert drawer(client, shop)["cash_sales"] == 60.0 and drawer(client, shop)["non_cash_sales"] == 40.0


def test_same_key_with_different_split_amounts_is_a_conflict(client, shop, db):
    split = [{"payment_method": "CASH", "amount": "60"}, {"payment_method": "CARD", "amount": "40"}]
    assert cart_sale(client, shop, client_tx_id=KEY_A, payments=split).status_code == 201
    same = cart_sale(client, shop, client_tx_id=KEY_A, payments=list(reversed(split)))
    assert same.status_code == 201 and same.json()["idempotent_replay"] is True   # order of lines is irrelevant
    changed = [{"payment_method": "CASH", "amount": "10"}, {"payment_method": "CARD", "amount": "90"}]
    assert cart_sale(client, shop, client_tx_id=KEY_A, payments=changed).status_code == 409
    assert db.query(models.Transaction).count() == 1 and db.query(models.Payment).count() == 2


@pytest.mark.parametrize("field,value", [
    ("tax_amount", "1.005"), ("discount_amount", "0.001"), ("amount_paid", "100.001"),
    ("tax_amount", "NaN"), ("tax_amount", "-1"), ("amount_paid", True), ("discount_amount", "Infinity"),
])
def test_money_with_extra_decimals_or_invalid_values_is_rejected_not_rounded(client, shop, db, field, value):
    resp = cart_sale(client, shop, **{field: value})
    assert resp.status_code == 400 and db.query(models.Transaction).count() == 0


@pytest.mark.parametrize("method", ["BITCOIN", "gcash-ish", "Cash Register", "CASHBACK", 5])
def test_unknown_payment_methods_are_rejected(client, shop, db, method):
    assert cart_sale(client, shop, payment_method=method).status_code == 400
    assert db.query(models.Transaction).count() == 0


def test_payment_methods_are_stored_canonically(client, shop, db):
    assert cart_sale(client, shop, payment_method=" cash ").status_code == 201
    assert cart_sale(client, shop, payment_method="Card", amount_paid="100.00").status_code == 201
    assert cart_sale(client, shop, payment_method="gcash", amount_paid="100").status_code == 201
    assert sorted(p.payment_method for p in db.query(models.Payment).all()) == ["CARD", "CASH", "GCASH"]


def test_sale_response_and_replay_carry_the_committed_lines_for_the_receipt(client, shop):
    first = sale(client, shop, {"client_tx_id": KEY_A, "payment_method": "CASH", "amount_paid": 200,
                                "items": [{"product_id": shop["fries"].id, "quantity": 2}]}).json()
    assert first["items"] == [{"product_id": shop["fries"].id, "name": "Fries", "quantity": 2,
                               "unit_price": 19.99, "total_price": 39.98}]
    assert first["payments"] == [{"payment_method": "CASH", "amount": 39.98, "status": "completed"}]
    replay = sale(client, shop, {"client_tx_id": KEY_A, "payment_method": "CASH", "amount_paid": 50,
                                 "items": [{"product_id": shop["fries"].id, "quantity": 1},
                                           {"product_id": shop["fries"].id, "quantity": 1}]}).json()
    assert replay["idempotent_replay"] is True and replay["items"] == first["items"] and replay["net_amount"] == 39.98


def test_legacy_cash_spellings_count_as_drawer_cash_but_lookalikes_do_not(client, shop, db):
    resp = cart_sale(client, shop, payment_method="CASH")
    tx = db.get(models.Transaction, resp.json()["id"])
    # Historical rows (written before methods were canonicalised) and look-alike names inserted directly.
    for method, amount in (("Cash", "1.00"), ("cash ", "2.00"), ("CASHBACK", "4.00"), ("GCash", "8.00"), ("Cash Register", "16.00")):
        db.add(models.Payment(transaction_id=tx.id, payment_method=method, amount=Decimal(amount), status="completed"))
    db.commit()
    shift = drawer(client, shop)
    assert shift["cash_sales"] == 103.0          # CASH + Cash + "cash " only
    assert shift["non_cash_sales"] == 28.0       # CASHBACK, GCash, "Cash Register" are not drawer cash


# =========================================================================== voids and refunds
def test_void_requires_a_reason_and_keeps_the_payment_record(client, shop, db):
    tx_id = cart_sale(client, shop).json()["id"]
    assert void(client, shop, tx_id, reason=None).status_code == 400
    assert void(client, shop, tx_id, reason="  ").status_code == 400
    assert fresh(db, models.Transaction, tx_id).status == "completed"

    resp = void(client, shop, tx_id)
    assert resp.status_code == 200 and resp.json()["refund_status"] == "pending"
    tx = fresh(db, models.Transaction, tx_id)
    assert tx.status == "cancelled" and tx.void_reason == "Customer changed mind" and tx.voided_at is not None
    assert tx.voided_by == db.query(models.User).filter_by(username="cash_a").one().id
    assert [(p.payment_method, str(p.amount), p.status) for p in tx.payments] == [("CASH", "100.00", "cancelled")]
    shift = drawer(client, shop)
    assert shift["cash_sales"] == 0.0 and shift["voided_cash_refund_pending"] == 100.0
    log = db.query(models.ActivityLog).filter_by(action="Order Cancelled/Rejected").one()
    assert "refund pending" in log.details and "Customer changed mind" in log.details


def test_a_voided_sale_cannot_be_voided_or_reopened_again(client, shop, db):
    tx_id = cart_sale(client, shop).json()["id"]
    assert void(client, shop, tx_id).status_code == 200
    assert void(client, shop, tx_id, status="rejected").status_code == 400
    assert client.put(f"/api/v1/transactions/{tx_id}/status", headers=shop["cash"], json={"status": "completed"}).status_code == 400
    assert db.query(models.ActivityLog).filter_by(action="Order Cancelled/Rejected").count() == 1


def test_a_completed_sale_cannot_be_moved_back_out_of_the_income_figures(client, shop, db):
    tx_id = cart_sale(client, shop, product="soda").json()["id"]     # drinks item: fulfilment starts pending
    put = lambda s: client.put(f"/api/v1/transactions/{tx_id}/status", headers=shop["cash"], json={"status": s})
    assert put("pending").status_code == 409
    resp = put("preparing")
    assert resp.status_code == 200 and resp.json()["status"] == "completed" and resp.json()["fulfillment_status"] == "preparing"
    assert put("completed").status_code == 200
    assert fresh(db, models.Transaction, tx_id).status == "completed"
    assert drawer(client, shop)["total_sales"] == 30.0
    served = cart_sale(client, shop).json()["id"]                     # no preparation: already served
    assert client.put(f"/api/v1/transactions/{served}/status", headers=shop["cash"], json={"status": "ready"}).status_code == 409


def test_a_pending_sale_is_completed_only_when_its_payments_match(client, shop, db):
    tx_id = cart_sale(client, shop, status="pending").json()["id"]
    tx = fresh(db, models.Transaction, tx_id)
    assert tx.status == "pending" and [p.status for p in tx.payments] == ["pending"]
    tx.payments[0].amount = Decimal("10.00")     # corrupted / legacy row
    db.commit()
    assert client.put(f"/api/v1/transactions/{tx_id}/status", headers=shop["cash"], json={"status": "completed"}).status_code == 409
    tx = fresh(db, models.Transaction, tx_id)
    tx.payments[0].amount = Decimal("100.00")
    db.commit()
    assert client.put(f"/api/v1/transactions/{tx_id}/status", headers=shop["cash"], json={"status": "completed"}).status_code == 200


def test_voiding_an_unpaid_pending_sale_needs_no_refund(client, shop, db):
    tx_id = cart_sale(client, shop, status="pending").json()["id"]
    assert void(client, shop, tx_id).json()["refund_status"] is None
    assert refund(client, shop, tx_id, amount="100", refund_method="CASH").status_code == 409


def test_only_managers_record_refunds_and_only_the_full_amount_by_the_original_method(client, shop, db):
    tx_id = cart_sale(client, shop).json()["id"]
    assert refund(client, shop, tx_id, amount="100", refund_method="CASH").status_code == 409   # not voided yet
    void(client, shop, tx_id)
    assert refund(client, shop, tx_id, who="cash", amount="100", refund_method="CASH").status_code == 403
    assert refund(client, shop, tx_id, who="cash_b", amount="100", refund_method="CASH").status_code == 403
    assert refund(client, shop, tx_id, amount="40", refund_method="CASH").status_code == 400      # partial
    assert refund(client, shop, tx_id, amount="100.001", refund_method="CASH").status_code == 400
    assert refund(client, shop, tx_id, amount="100", refund_method="GCASH").status_code == 400    # wrong method
    assert refund(client, shop, tx_id, amount="100", refund_method="CASH", note="ok").status_code == 400  # note too short
    assert fresh(db, models.Transaction, tx_id).refund_status == "pending" and db.query(models.SaleRefund).count() == 0

    ok = refund(client, shop, tx_id, amount="100.00", refund_method="cash")
    assert ok.status_code == 200 and ok.json()["refund_status"] == "refunded" and "did not send" in ok.json()["basis"]
    assert refund(client, shop, tx_id, amount="100.00", refund_method="CASH").status_code == 409     # no duplicate
    assert refund(client, shop, tx_id, outcome="not_required").status_code == 409
    rec = db.query(models.SaleRefund).one()
    assert (rec.outcome, str(rec.amount), rec.refund_method) == ("refunded", "100.00", "CASH")
    assert rec.recorded_by == db.query(models.User).filter_by(username="mgr_a").one().id
    assert fresh(db, models.Transaction, tx_id).refund_status == "refunded"
    assert drawer(client, shop)["voided_cash_refund_pending"] == 0.0 and drawer(client, shop)["cash_sales"] == 0.0
    assert db.query(models.ActivityLog).filter_by(action="Refund Recorded").count() == 1


def test_other_tenants_manager_cannot_touch_the_sale(client, shop, db, make_user, login):
    b = db.get(models.Tenant, shop["b"].id)
    make_user("mgr_b", R.MANAGER, b)
    tx_id = cart_sale(client, shop).json()["id"]
    void(client, shop, tx_id)
    resp = client.post(f"/api/v1/transactions/{tx_id}/refund", headers=login("mgr_b"),
                       json={"amount": "100", "refund_method": "CASH", "note": "not my sale"})
    assert resp.status_code == 404 and fresh(db, models.Transaction, tx_id).refund_status == "pending"


def test_gcash_refund_is_recorded_with_its_reference_and_never_claimed_as_sent(client, shop, db):
    tx_id = cart_sale(client, shop, payment_method="GCASH", amount_paid="100").json()["id"]
    void(client, shop, tx_id)
    ok = refund(client, shop, tx_id, amount="100", refund_method="GCASH", reference_no="9012 345 678 901",
                note="Sent back from store GCash app")
    assert ok.status_code == 200 and ok.json()["reference_no"] == "9012345678901"
    assert db.query(models.SaleRefund).one().reference_no == "9012345678901"


def test_not_required_outcome_closes_a_mistaken_void(client, shop, db):
    tx_id = cart_sale(client, shop, payment_method="CARD", amount_paid="100").json()["id"]
    void(client, shop, tx_id)
    resp = refund(client, shop, tx_id, outcome="not_required", note="Card was declined; nothing charged")
    assert resp.status_code == 200 and fresh(db, models.Transaction, tx_id).refund_status == "not_required"
    rec = db.query(models.SaleRefund).one()
    assert rec.amount == 0 and rec.refund_method is None


def test_database_rejects_two_refund_records_for_one_sale(db, shop, client):
    from sqlalchemy.exc import IntegrityError
    tx_id = cart_sale(client, shop).json()["id"]
    for _ in range(2):
        db.add(models.SaleRefund(tenant_id=shop["a"].id, transaction_id=tx_id, outcome="refunded",
                                 amount=Decimal("100"), note="direct insert"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_void_permission_switch_restricts_voids_to_managers(client, shop, db, monkeypatch):
    monkeypatch.setattr("app.routers.transactions.VOID_REQUIRES_MANAGER", True)
    tx_id = cart_sale(client, shop).json()["id"]
    assert void(client, shop, tx_id).status_code == 403
    assert fresh(db, models.Transaction, tx_id).status == "completed"
    assert void(client, shop, tx_id, who="mgr").status_code == 200


def test_cancelled_sale_and_its_refund_are_not_double_counted_in_reports(client, shop, db):
    keep = cart_sale(client, shop, product="burger").json()["id"]
    gone = cart_sale(client, shop).json()["id"]
    void(client, shop, gone)
    refund(client, shop, gone, amount="100", refund_method="CASH")
    shift = drawer(client, shop)
    assert shift["cash_sales"] == 50.0 and shift["total_sales"] == 50.0 and shift["expected_cash"] == 50.0
    assert keep


# =========================================================================== customer-order status path
def _counter_sale_for_accepted_order(client, shop):
    oid = order(client, shop, method="PAY_AT_COUNTER")
    assert client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "accepted"}).status_code == 200
    tx = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_A, "payment_method": "CASH", "amount_paid": 100})
    assert tx.status_code == 201
    return oid, tx.json()["id"]


def test_an_order_with_an_active_sale_cannot_be_rejected_by_any_route(client, shop, db):
    oid, tx_id = _counter_sale_for_accepted_order(client, shop)
    assert client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "rejected"}).status_code == 409
    assert client.put(f"/api/v1/kitchen/orders/CUST-{oid}/status", headers=shop["kitchen"], json={"status": "cancelled"}).status_code == 409
    assert fresh(db, models.CustomerOrder, oid).status == "accepted"

    void(client, shop, tx_id, reason="Customer left before eating")
    assert client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "rejected"}).status_code == 200
    assert db.query(models.ActivityLog).filter_by(action="Paid Order Rejected").count() == 1


def test_kitchen_rejection_of_a_verified_order_is_audited_like_the_pos_route(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00")
    resp = client.put(f"/api/v1/kitchen/orders/CUST-{oid}/status", headers=shop["kitchen"], json={"status": "cancelled"})
    assert resp.status_code == 200 and fresh(db, models.CustomerOrder, oid).status == "rejected"
    assert db.query(models.ActivityLog).filter_by(action="Paid Order Rejected").count() == 1
    assert verify(client, shop, oid, "100.00").status_code == 409                       # rejected: no more payment
    assert sale(client, shop, {"customer_order_id": oid}).status_code == 409


def test_kitchen_route_cannot_reopen_terminal_customer_orders(client, shop, db):
    oid = order(client, shop, method="PAY_AT_COUNTER")
    assert client.put(f"/api/v1/kitchen/orders/CUST-{oid}/status", headers=shop["kitchen"], json={"status": "completed"}).status_code == 200
    for target in ("pending", "accepted", "preparing", "cancelled"):
        assert client.put(f"/api/v1/kitchen/orders/CUST-{oid}/status", headers=shop["kitchen"], json={"status": target}).status_code == 409
    assert fresh(db, models.CustomerOrder, oid).status == "completed"


def test_kitchen_cannot_void_a_pos_sale_or_reopen_a_served_one(client, shop, db):
    tx_id = cart_sale(client, shop, product="soda", amount_paid=30).json()["id"]
    for status in ("cancelled", "rejected"):
        resp = client.put(f"/api/v1/kitchen/orders/{tx_id}/status", headers=shop["kitchen"], json={"status": status})
        assert resp.status_code == 409
    tx = fresh(db, models.Transaction, tx_id)
    assert tx.status == "completed" and [p.status for p in tx.payments] == ["completed"]   # used to be cancelled/completed

    assert client.put(f"/api/v1/kitchen/orders/{tx_id}/drinks-status", headers=shop["cash"], json={"status": "COMPLETED"}).status_code == 200
    assert client.put(f"/api/v1/kitchen/orders/{tx_id}/status", headers=shop["kitchen"], json={"status": "preparing"}).status_code == 409
    assert fresh(db, models.Transaction, tx_id).fulfillment_status == "completed"


# =========================================================================== reconciliation
def _half_finished_online_sale(db, shop, oid, method_status="unpaid"):
    """Simulate the old two-step flow: the sale was saved, the order update was lost."""
    shift = models.Shift(tenant_id=shop["a"].id, user_id=db.query(models.User).filter_by(username="cash_a").one().id,
                         start_cash=0, status="open")
    db.add(shift)
    db.flush()
    tx = models.Transaction(tenant_id=shop["a"].id, shift_id=shift.id, user_id=shift.user_id, client_tx_id=KEY_C,
                            customer_order_id=oid, total_amount=100, tax_amount=0, discount_amount=0, net_amount=100,
                            status="completed", fulfillment_status="completed")
    tx.payments = [models.Payment(payment_method="CASH", amount=100, status="completed")]
    db.add(tx)
    db.commit()
    return tx.id


def test_retry_repairs_a_half_finished_order_and_audits_it(client, shop, db):
    oid = order(client, shop, method="PAY_AT_COUNTER")
    tx_id = _half_finished_online_sale(db, shop, oid)
    resp = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_B, "payment_method": "CASH"})
    assert resp.status_code == 201 and resp.json()["id"] == tx_id and resp.json()["idempotent_replay"] is True
    o = fresh(db, models.CustomerOrder, oid)
    assert (o.status, o.payment_status) == ("completed", "counter_paid")
    assert db.query(models.Transaction).count() == 1 and db.query(models.Payment).count() == 1
    assert db.query(models.ActivityLog).filter_by(action="Order Reconciled").count() == 1
    sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_B, "payment_method": "CASH"})
    assert db.query(models.ActivityLog).filter_by(action="Order Reconciled").count() == 1      # nothing left to repair


def test_reconciliation_never_marks_a_gcash_order_paid(client, shop, db):
    oid = order(client, shop, method="GCASH")
    _half_finished_online_sale(db, shop, oid)
    sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_B})
    o = fresh(db, models.CustomerOrder, oid)
    assert o.status == "completed" and o.payment_status == "unpaid"


def test_a_voided_online_sale_is_neither_repaired_nor_resold(client, shop, db):
    oid = order(client, shop, method="PAY_AT_COUNTER")
    tx_id = _half_finished_online_sale(db, shop, oid)
    void(client, shop, tx_id)
    resp = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_B, "payment_method": "CASH"})
    assert resp.status_code == 409
    o = fresh(db, models.CustomerOrder, oid)
    assert (o.status, o.payment_status) == ("pending", "unpaid")
    assert db.query(models.Transaction).count() == 1


def test_reconcile_script_scan_finds_repairs_and_review_cases(client, shop, db):
    import importlib.util, os
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "reconcile_customer_orders.py")
    spec = importlib.util.spec_from_file_location("reconcile_customer_orders", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    stuck = order(client, shop, method="PAY_AT_COUNTER")
    _half_finished_online_sale(db, shop, stuck)
    repairs, review = module.scan(db)
    assert [o.id for o, _ in repairs] == [stuck] and review == []
    o = fresh(db, models.CustomerOrder, stuck)
    o.status = "rejected"         # an inconsistent record a person must look at; never auto-changed
    db.commit()
    repairs, review = module.scan(db)
    assert repairs == [] and len(review) == 1 and "rejected order" in review[0][2]


# =========================================================================== inventory (recipe-based)
@pytest.fixture
def pantry(db, shop):
    a = shop["a"].id
    beef = models.InventoryItem(tenant_id=a, name="Beef patty", unit="pc", quantity=Decimal("3"), min_stock=0, unit_price=0)
    bun = models.InventoryItem(tenant_id=a, name="Bun", unit="pc", quantity=Decimal("10"), min_stock=0, unit_price=0)
    db.add_all([beef, bun])
    db.flush()
    db.add_all([
        models.ProductRecipe(product_id=shop["burger"].id, inventory_item_id=beef.id, quantity=Decimal("1")),
        models.ProductRecipe(product_id=shop["burger"].id, inventory_item_id=bun.id, quantity=Decimal("2")),
    ])
    db.commit()
    return {"beef": beef.id, "bun": bun.id}


def qty(db, item_id):
    db.expire_all()
    return db.get(models.InventoryItem, item_id).quantity


def test_stock_is_untouched_while_deduction_is_off(client, shop, db, pantry, monkeypatch):
    monkeypatch.delenv("INVENTORY_DEDUCTION", raising=False)
    assert cart_sale(client, shop, product="burger", qty=2).status_code == 201
    assert qty(db, pantry["beef"]) == 3 and db.query(models.StockMovement).count() == 0


def test_sale_deducts_recipe_stock_once_and_logs_the_movement(client, shop, db, pantry, monkeypatch):
    monkeypatch.setenv("INVENTORY_DEDUCTION", "on_sale")
    first = cart_sale(client, shop, product="burger", qty=2, client_tx_id=KEY_A)
    assert first.status_code == 201
    assert qty(db, pantry["beef"]) == 1 and qty(db, pantry["bun"]) == 6
    replay = cart_sale(client, shop, product="burger", qty=2, client_tx_id=KEY_A)
    assert replay.json()["idempotent_replay"] is True
    assert qty(db, pantry["beef"]) == 1                                         # no double deduction
    moves = db.query(models.StockMovement).order_by(models.StockMovement.inventory_item_id).all()
    assert [(m.movement_type, m.reference_type, m.reference_id) for m in moves] == [("SALE", "pos_sale", first.json()["id"])] * 2
    assert Decimal(str(moves[0].quantity_delta)) == -2 and Decimal(str(moves[1].quantity_delta)) == -4
    assert Decimal(str(moves[0].quantity_after)) == 1


def test_insufficient_stock_rejects_the_whole_sale(client, shop, db, pantry, monkeypatch, events):
    monkeypatch.setenv("INVENTORY_DEDUCTION", "on_sale")
    resp = cart_sale(client, shop, product="burger", qty=4, client_tx_id=KEY_A)
    assert resp.status_code == 409 and "Beef patty" in resp.json()["detail"]
    assert db.query(models.Transaction).count() == 0 and db.query(models.Payment).count() == 0
    assert db.query(models.StockMovement).count() == 0 and qty(db, pantry["bun"]) == 10
    assert not [e for e in events if e[1] == "ORDER_CREATED"]
    assert cart_sale(client, shop, product="burger", qty=3, client_tx_id=KEY_A).status_code == 201   # same key, fixed cart
    assert qty(db, pantry["beef"]) == 0


def test_products_without_a_recipe_are_not_stock_tracked(client, shop, db, pantry, monkeypatch):
    monkeypatch.setenv("INVENTORY_DEDUCTION", "on_sale")
    assert cart_sale(client, shop, product="cake", qty=5).status_code == 201
    assert db.query(models.StockMovement).count() == 0 and qty(db, pantry["beef"]) == 3


def test_void_restores_exactly_once_even_after_the_setting_is_switched_off(client, shop, db, pantry, monkeypatch):
    monkeypatch.setenv("INVENTORY_DEDUCTION", "on_sale")
    tx_id = cart_sale(client, shop, product="burger", qty=1).json()["id"]
    assert qty(db, pantry["beef"]) == 2
    monkeypatch.setenv("INVENTORY_DEDUCTION", "off")
    assert void(client, shop, tx_id).status_code == 200
    assert qty(db, pantry["beef"]) == 3 and qty(db, pantry["bun"]) == 10
    assert void(client, shop, tx_id).status_code == 400                       # already voided: no second restore
    assert qty(db, pantry["beef"]) == 3
    assert db.query(models.StockMovement).filter_by(movement_type="REVERSAL").count() == 2


def test_database_rejects_a_second_deduction_row_for_the_same_sale_and_item(db, shop, pantry, client):
    from sqlalchemy.exc import IntegrityError
    for _ in range(2):
        db.add(models.StockMovement(tenant_id=shop["a"].id, inventory_item_id=pantry["beef"], movement_type="SALE",
                                    quantity_delta=-1, quantity_after=2, reference_type="pos_sale", reference_id=999))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    # Other movement kinds (manual adjustments) are not restricted by the index.
    for _ in range(2):
        db.add(models.StockMovement(tenant_id=shop["a"].id, inventory_item_id=pantry["beef"], movement_type="ADJUSTMENT",
                                    quantity_delta=1, quantity_after=4, reference_type="manual", reference_id=1))
    db.commit()


def test_online_order_is_deducted_once_at_sale_and_never_at_kitchen_acceptance(client, shop, db, pantry, monkeypatch):
    monkeypatch.setenv("INVENTORY_DEDUCTION", "on_sale")
    oid = order(client, shop, product="burger", qty=2, method="PAY_AT_COUNTER")
    client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "accepted"})
    client.put(f"/api/v1/kitchen/orders/CUST-{oid}/status", headers=shop["kitchen"], json={"status": "preparing"})
    assert qty(db, pantry["beef"]) == 3
    body = {"customer_order_id": oid, "client_tx_id": KEY_A, "payment_method": "CASH", "amount_paid": 100}
    assert sale(client, shop, body).status_code == 201
    assert sale(client, shop, {**body, "client_tx_id": KEY_B}).status_code == 201       # second cashier / new key
    assert qty(db, pantry["beef"]) == 1 and db.query(models.StockMovement).count() == 2


def test_two_sales_cannot_take_the_same_last_stock(client, shop, db, pantry, monkeypatch):
    """Sequential on SQLite; the PostgreSQL version with real concurrency is in test_postgres_concurrency.py."""
    monkeypatch.setenv("INVENTORY_DEDUCTION", "on_sale")
    assert cart_sale(client, shop, product="burger", qty=2, client_tx_id=KEY_A).status_code == 201
    assert cart_sale(client, shop, product="burger", qty=2, client_tx_id=KEY_B, who="cash2").status_code == 409
    assert qty(db, pantry["beef"]) == 1
