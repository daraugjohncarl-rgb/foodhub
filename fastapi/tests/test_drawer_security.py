"""
Cash Drawer authorization (2026-10-28): who may edit or cash out a drawer, what the drawer summary
reveals to each role, and that the summary GET never writes. Runs on SQLite (application logic and
authorization only; no PostgreSQL locking is claimed here).
"""
from decimal import Decimal

import pytest

import app.models as models
from conftest import R


@pytest.fixture
def staff(tenants, make_user, make_product, login):
    a, b = tenants
    make_user("cash1", R.CASHIER, a)
    make_user("cash2", R.CASHIER, a)
    make_user("boss", R.MANAGER, a)
    make_user("owner", R.ADMIN, a)
    make_user("cash_b", R.CASHIER, b)
    make_user("boss_b", R.MANAGER, b)
    item = make_product(a, "Rice Meal", "100.00")
    return {"a": a.id, "b": b.id, "item": item.id,
            **{n: login(n) for n in ("cash1", "cash2", "boss", "owner", "cash_b", "boss_b")}}


def start(client, staff, who, cash="500"):
    r = client.post("/api/v1/shifts/start", headers=staff[who], json={"start_cash": cash})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def cash_sale(client, staff, who):
    r = client.post("/api/v1/transactions", headers=staff[who], json={
        "items": [{"product_id": staff["item"], "quantity": 1}], "payment_method": "CASH", "amount_paid": 100})
    assert r.status_code == 201, r.text


def snapshot(db):
    """Everything a drawer request could change."""
    db.expire_all()
    return (
        sorted((s.id, s.user_id, s.status, str(s.start_cash), str(s.end_cash)) for s in db.query(models.Shift).all()),
        sorted((m.shift_id, m.type, str(m.amount)) for m in db.query(models.ShiftCashMovement).all()),
        db.query(models.Transaction).count(),
    )


def summary(client, staff, who):
    r = client.get("/api/v1/shifts/drawer-summary", headers=staff[who])
    assert r.status_code == 200, r.text
    return r.json()


# ----------------------------------------------------------------------------- PUT /shifts/{id}/drawer-cash
def test_cashier_cannot_edit_another_cashiers_drawer_or_their_own(client, staff, db):
    other = start(client, staff, "cash2")
    own = start(client, staff, "cash1")
    before = snapshot(db)
    for shift_id in (other, own):
        r = client.put(f"/api/v1/shifts/{shift_id}/drawer-cash", headers=staff["cash1"], json={"amount": "0", "reason": "x"})
        assert r.status_code == 403
    assert snapshot(db) == before


def test_manager_and_admin_can_edit_a_cashier_drawer(client, staff, db):
    sid = start(client, staff, "cash1", cash="500")
    r = client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["boss"], json={"amount": "450", "reason": "count"})
    assert r.status_code == 200 and r.json()["adjustment"] == -50.0
    r = client.post(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["owner"], json={"amount": "500", "reason": "recount"})
    assert r.status_code == 200 and r.json()["adjustment"] == 50.0
    db.expire_all()
    assert sorted((m.type, str(m.amount)) for m in db.query(models.ShiftCashMovement).filter_by(shift_id=sid)) == [
        ("PAID_IN", "50.00"), ("PAID_OUT", "50.00")]


def test_manager_cannot_edit_another_tenants_drawer(client, staff, db):
    sid = start(client, staff, "cash1")
    before = snapshot(db)
    r = client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=staff["boss_b"], json={"amount": "0"})
    assert r.status_code == 404 and snapshot(db) == before


# ----------------------------------------------------------------------------- POST /shifts/cashout
def test_cashier_cannot_cash_out_another_cashiers_shift(client, staff, db):
    other = start(client, staff, "cash2")
    start(client, staff, "cash1")
    before = snapshot(db)
    r = client.post("/api/v1/shifts/cashout", headers=staff["cash1"], json={"shift_id": other, "amount": "100"})
    assert r.status_code == 403
    assert snapshot(db) == before                     # no movement, no closed shift, no new shift


def test_cashier_can_cash_out_their_own_shift_as_before(client, staff, db):
    own = start(client, staff, "cash1", cash="300")
    r = client.post("/api/v1/shifts/cashout", headers=staff["cash1"], json={"amount": "300"})
    assert r.status_code == 200 and r.json()["cashed_out_shift_id"] == own
    r2 = client.post("/api/v1/shifts/cashout", headers=staff["cash1"], json={"shift_id": r.json()["new_shift_id"], "amount": "0"})
    assert r2.status_code == 200


def test_cashout_refuses_closed_unknown_invalid_and_missing_shifts_without_writing(client, staff, db):
    own = start(client, staff, "cash1")
    closed = client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": own, "amount": "1"}).json()["cashed_out_shift_id"]
    before = snapshot(db)
    assert client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": closed}).status_code == 409
    assert client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": 99999}).status_code == 404
    assert client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": "abc"}).status_code == 400
    assert client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": True}).status_code == 400
    assert client.post("/api/v1/shifts/cashout", headers=staff["cash2"], json={"amount": "5"}).status_code == 404  # cash2 has no shift
    assert snapshot(db) == before                     # in particular: no shift was created for anyone


def test_manager_can_cash_out_any_cashier_shift_of_the_tenant_only(client, staff, db):
    sid = start(client, staff, "cash2", cash="200")
    before = snapshot(db)
    assert client.post("/api/v1/shifts/cashout", headers=staff["boss_b"], json={"shift_id": sid}).status_code == 404
    assert client.post("/api/v1/shifts/cashout", headers=staff["boss_b"], json={"amount": "5"}).status_code == 404
    assert snapshot(db) == before
    r = client.post("/api/v1/shifts/cashout", headers=staff["boss"], json={"shift_id": sid, "amount": "200"})
    assert r.status_code == 200
    db.expire_all()
    assert db.get(models.Shift, sid).status == "closed"


# ----------------------------------------------------------------------------- GET /shifts/drawer-summary
def test_drawer_summary_get_never_creates_a_shift(client, staff, db):
    before = snapshot(db)
    for who in ("cash1", "boss", "owner"):
        data = summary(client, staff, who)
        assert data["shifts"] == [] and data["has_open_shift"] is False
    assert snapshot(db) == before and db.query(models.Shift).count() == 0


def test_cashier_summary_shows_only_their_own_drawer_and_sales(client, staff, db):
    start(client, staff, "cash2", cash="900")
    cash_sale(client, staff, "cash2")
    cash_sale(client, staff, "cash1")              # auto-opens cash1's own shift (AUTO_OPEN_SHIFT unchanged)
    mine = summary(client, staff, "cash1")
    assert mine["scope"] == "own"
    assert [s["cashier_username"] for s in mine["shifts"]] == ["cash1"]
    assert mine["shifts"][0]["expected_cash"] == 100.0           # the POS "Cash in Drawer" figure still works
    assert mine["total_cash_in_drawers"] == 100.0                # not cash2's 900 + 100
    assert mine["today_total_orders_amount"] == 100.0 and mine["overall_income"] == 100.0
    assert "900" not in str(mine)


def test_manager_and_admin_summaries_cover_every_cashier_of_their_tenant_only(client, staff, db):
    start(client, staff, "cash2", cash="900")
    cash_sale(client, staff, "cash1")
    start(client, staff, "cash_b", cash="77")
    for who in ("boss", "owner"):
        data = summary(client, staff, who)
        assert data["scope"] == "tenant_cashiers"
        assert sorted(s["cashier_username"] for s in data["shifts"]) == ["cash1", "cash2"]
        assert data["total_cash_in_drawers"] == 1000.0
    other = summary(client, staff, "boss_b")
    assert [s["cashier_username"] for s in other["shifts"]] == ["cash_b"]


def test_cashier_without_a_shift_gets_an_empty_but_valid_summary(client, staff, db):
    start(client, staff, "cash2")
    data = summary(client, staff, "cash1")
    assert data["shifts"] == [] and data["has_open_shift"] is False and data["total_cash_in_drawers"] == 0.0
    assert db.query(models.Shift).count() == 1
