"""P1 regression tests: server-side totals, payments, idempotency, atomicity, shifts and reporting."""
from datetime import datetime
from decimal import Decimal

import pytest

from conftest import R
import app.models as models


@pytest.fixture
def pos(tenants, make_user, make_product, login):
    tenant_a, tenant_b = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    return {
        "tenant": tenant_a,
        "headers": login("cash_a"),
        "coffee": make_product(tenant_a, "Coffee", "19.99"),
        "cake": make_product(tenant_a, "Cake", "100.00"),
        "retired": make_product(tenant_a, "Retired", "5.00", active=False),
    }


def sale(client, pos, items, **extra):
    return client.post("/api/v1/transactions", headers=pos["headers"], json={"items": items, **extra})


def test_totals_use_trusted_prices_and_exact_decimal_math(client, pos, db):
    resp = sale(client, pos, [
        {"product_id": pos["coffee"].id, "quantity": 3, "unit_price": "0.01", "price": 0.01},
        {"product_id": pos["cake"].id, "quantity": 1},
    ], tax_amount="12.50", discount_amount="10.00")
    assert resp.status_code == 201, resp.text
    tx = db.get(models.Transaction, resp.json()["id"])
    assert str(tx.total_amount) == "159.97"           # 3 * 19.99 + 100.00, no float drift
    assert str(tx.net_amount) == "162.47"             # 159.97 + 12.50 - 10.00
    assert sorted(str(i.unit_price) for i in tx.items) == ["100.00", "19.99"]
    assert [str(p.amount) for p in tx.payments] == ["162.47"]
    assert tx.status == "completed"


def test_tax_and_discount_rounding(client, pos, db):
    # More than 2 decimals is rejected rather than silently rounded (2026-10-27): the client must send the
    # exact amount it means; the server never changes a financial input on its own.
    resp = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}], tax_amount="0.125", discount_amount="0.005")
    assert resp.status_code == 400 and db.query(models.Transaction).count() == 0
    resp = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}], tax_amount="0.13", discount_amount="0.01")
    assert resp.status_code == 201
    tx = db.get(models.Transaction, resp.json()["id"])
    assert (str(tx.tax_amount), str(tx.discount_amount), str(tx.net_amount)) == ("0.13", "0.01", "100.12")


@pytest.mark.parametrize("quantity", [0, -3, 101, 1.5, "x", None, True])
def test_invalid_quantities_are_rejected(client, pos, quantity):
    assert sale(client, pos, [{"product_id": pos["coffee"].id, "quantity": quantity}]).status_code == 400


@pytest.mark.parametrize("extra", [
    {"discount_amount": "-1"},
    {"tax_amount": "-5"},
    {"discount_amount": "100000.00"},          # larger than the order -> would have been a free sale
    {"tax_amount": "abc"},
    {"tax_amount": "NaN"},
    {"discount_amount": "Infinity"},
    {"status": "refunded"},
])
def test_invalid_money_and_status_inputs_are_rejected(client, pos, extra):
    assert sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}], **extra).status_code == 400


def test_inactive_unknown_and_malformed_items_are_rejected(client, pos):
    assert sale(client, pos, [{"product_id": pos["retired"].id, "quantity": 1}]).status_code == 400
    assert sale(client, pos, [{"product_id": 999999, "quantity": 1}]).status_code == 404
    assert sale(client, pos, [{"product_id": "abc", "quantity": 1}]).status_code == 400
    assert sale(client, pos, ["nope"]).status_code == 400
    assert sale(client, pos, []).status_code == 400


def test_payment_validation(client, pos, db):
    item = [{"product_id": pos["cake"].id, "quantity": 1}]
    # Tendered less than due
    assert sale(client, pos, item, payment_method="Cash", amount_paid=50).status_code == 400
    # Split payments that do not cover the net amount
    assert sale(client, pos, item, payments=[{"payment_method": "Cash", "amount": 40}, {"payment_method": "GCash", "amount": 40}]).status_code == 400
    # Negative / zero / non-numeric payment amounts
    for bad in (-5, 0, "abc"):
        assert sale(client, pos, item, payments=[{"payment_method": "Cash", "amount": bad}]).status_code == 400
    # Overpaying in cash is fine (change is a till concern); split payments covering the total are fine
    assert sale(client, pos, item, payment_method="Cash", amount_paid=200).status_code == 201
    assert sale(client, pos, item, payments=[{"payment_method": "Cash", "amount": 60}, {"payment_method": "GCash", "amount": 40}]).status_code == 201
    assert db.query(models.Transaction).count() == 2


def test_duplicate_client_tx_id_returns_original_sale(client, pos, db):
    item = [{"product_id": pos["cake"].id, "quantity": 1}]
    first = sale(client, pos, item, client_tx_id="11111111-1111-1111-1111-111111111111")
    again = sale(client, pos, item, client_tx_id="11111111-1111-1111-1111-111111111111")
    assert first.status_code == 201 and again.status_code == 201
    assert first.json()["id"] == again.json()["id"]
    assert again.json()["message"] == "Transaction already processed."
    assert db.query(models.Transaction).count() == 1
    assert db.query(models.Payment).count() == 1


def test_sale_is_atomic_when_a_late_step_fails(client, pos, db, monkeypatch):
    class Boom:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("simulated failure after items and payments were staged")

    monkeypatch.setattr("app.routers.transactions.models.ActivityLog", Boom)
    resp = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}])
    assert resp.status_code == 500
    assert "simulated" not in resp.text            # no internals leaked
    assert db.query(models.Transaction).count() == 0
    assert db.query(models.TransactionItem).count() == 0
    assert db.query(models.Payment).count() == 0
    assert db.query(models.Shift).count() == 0     # the auto-opened shift rolled back as well


def test_shift_lifecycle_and_explicit_start_cash(client, pos, db):
    started = client.post("/api/v1/shifts/start", headers=pos["headers"], json={"start_cash": "500.00"})
    assert started.status_code == 200
    assert client.post("/api/v1/shifts/start", headers=pos["headers"], json={"start_cash": "1.00"}).status_code == 400
    assert sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}]).status_code == 201
    assert db.query(models.Shift).count() == 1     # the sale used the real shift
    shift = db.query(models.Shift).one()
    assert str(shift.start_cash) == "500.00"
    assert client.put("/api/v1/shifts/end", headers=pos["headers"], json={"end_cash": "600.00"}).status_code == 200


def test_sale_without_open_shift_auto_opens_zero_cash_shift_by_default(client, pos, db):
    """Documents the current (pending business decision) behaviour."""
    assert sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}]).status_code == 201
    shift = db.query(models.Shift).one()
    assert str(shift.start_cash) == "0.00" and shift.status == "open"


def test_sale_without_open_shift_is_rejected_when_auto_open_is_disabled(client, pos, db, monkeypatch):
    monkeypatch.setattr("app.routers.transactions.AUTO_OPEN_SHIFT", False)
    resp = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}])
    assert resp.status_code == 409
    assert db.query(models.Transaction).count() == 0 and db.query(models.Shift).count() == 0


def test_cancelled_sales_are_locked_and_excluded_from_reports(client, pos, db, make_user, login):
    first = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}]).json()["id"]
    second = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 2}]).json()["id"]
    for tx in db.query(models.Transaction).all():       # pin "today" so the test is timezone independent
        tx.created_at = datetime.now()
    db.commit()

    make_user("mgr_a", R.MANAGER, pos["tenant"])
    manager_headers = login("mgr_a")
    before = client.get("/api/v1/analytics/dashboard", headers=manager_headers).json()
    assert Decimal(str(before["today_sales"])) == Decimal("300.00") and before["total_transactions_today"] == 2

    cancelled = client.put(f"/api/v1/transactions/{second}/status", headers=pos["headers"], json={"status": "cancelled", "reason": "customer left"})
    assert cancelled.status_code == 200
    # Payments of a cancelled sale are voided and the sale can never be revived.
    assert {p.status for p in db.query(models.Payment).filter_by(transaction_id=second)} == {"cancelled"}
    assert client.put(f"/api/v1/transactions/{second}/status", headers=pos["headers"], json={"status": "completed"}).status_code == 400
    assert client.put(f"/api/v1/transactions/{first}/status", headers=pos["headers"], json={"status": "bogus"}).status_code == 400

    after = client.get("/api/v1/analytics/dashboard", headers=manager_headers).json()
    assert Decimal(str(after["today_sales"])) == Decimal("100.00") and after["total_transactions_today"] == 1


def test_transaction_listing_is_paginated_with_a_cap(client, pos):
    assert client.get("/api/v1/transactions?limit=500", headers=pos["headers"]).status_code == 422
    assert client.get("/api/v1/transactions?limit=0", headers=pos["headers"]).status_code == 422
    assert client.get("/api/v1/transactions?limit=5&offset=0", headers=pos["headers"]).status_code == 200


def test_stock_is_not_deducted_on_sale_known_gap(client, pos, db):
    """
    Documents a decision still owed by the business (PRODUCTION_READINESS.md P1-3): sales do not
    decrement inventory. If this test starts failing because deduction was implemented, update it.
    """
    item = models.InventoryItem(tenant_id=pos["tenant"].id, name="Beans", unit="kg", quantity=10)
    db.add(item)
    db.commit()
    db.add(models.ProductRecipe(product_id=pos["coffee"].id, inventory_item_id=item.id, quantity=1))
    db.commit()
    assert sale(client, pos, [{"product_id": pos["coffee"].id, "quantity": 2}]).status_code == 201
    db.expire_all()
    assert db.get(models.InventoryItem, item.id).quantity == Decimal("10.00")


def test_client_supplied_totals_and_prices_never_override_the_server(client, pos, db):
    resp = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 2, "unit_price": "0.01", "total_price": "0.02"}],
                total_amount="0.01", net_amount="0.01", amount="0.01", subtotal="0.01")
    assert resp.status_code == 201
    tx = db.get(models.Transaction, resp.json()["id"])
    assert (str(tx.total_amount), str(tx.net_amount)) == ("200.00", "200.00")
    assert [str(p.amount) for p in tx.payments] == ["200.00"]


def test_discount_and_tax_are_client_entered_but_bounded_documented_policy_gap(client, pos, db):
    """Tax/discount authority is a pending business decision: only structural bounds are enforced."""
    ok = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}], discount_amount="100.00")   # equal to total is allowed
    assert ok.status_code == 201 and ok.json()["net_amount"] == 0.0
    over = sale(client, pos, [{"product_id": pos["cake"].id, "quantity": 1}], discount_amount="100.01")
    assert over.status_code == 400
