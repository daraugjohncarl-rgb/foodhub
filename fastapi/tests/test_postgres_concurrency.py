"""
PostgreSQL-only concurrency and rollback checks for the cashier ordering flow.

SQLite serialises writers and ignores SELECT ... FOR UPDATE, so the rest of the suite cannot prove how the
code behaves under real concurrency. These tests run the real API (FastAPI TestClient, real worker threads)
against a DISPOSABLE PostgreSQL database and race requests against each other.

Enable with:   TEST_POSTGRES_URL=postgresql://user:pass@127.0.0.1:5432/inboxpos_test  pytest tests/test_postgres_concurrency.py
Safety: refuses hosted Supabase hosts and any database whose name does not contain "test". All objects are
created in a private schema (pos_concurrency_test) that is dropped afterwards; nothing else is touched.
"""
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest

PG_URL = os.getenv("TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="set TEST_POSTGRES_URL to a DISPOSABLE PostgreSQL database")

SCHEMA = "pos_concurrency_test"
THREADS = 8


def _engine_url(url: str) -> str:
    for prefix in ("postgresql+psycopg://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    raise RuntimeError("TEST_POSTGRES_URL must be a postgresql:// URL")


@pytest.fixture(scope="module")
def pg():
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from sqlalchemy.orm import sessionmaker

    url = make_url(_engine_url(PG_URL))
    assert "supabase" not in (url.host or ""), "refusing to run against a hosted Supabase project"
    assert "test" in (url.database or "").lower(), "the database name must contain 'test' (disposable databases only)"

    admin = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        conn.execute(text(f"CREATE SCHEMA {SCHEMA}"))
    engine = create_engine(url, pool_size=THREADS + 4, max_overflow=4,
                           connect_args={"options": f"-csearch_path={SCHEMA}", "prepare_threshold": None})
    yield engine, sessionmaker(autocommit=False, autoflush=False, bind=engine)
    engine.dispose()
    with admin.connect() as conn:
        conn.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
    admin.dispose()


@pytest.fixture
def api(pg, monkeypatch):
    """App wired to PostgreSQL with fresh tables, two tenants, staff and products."""
    from fastapi.testclient import TestClient
    from app.db import Base, get_db
    from app.main import app
    import app.models as models
    from app.core.security import get_password_hash

    engine, Session = pg
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    def pg_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = pg_get_db
    monkeypatch.setattr("app.core.websocket.notify_realtime_event", lambda *a, **k: None)
    monkeypatch.setattr("app.routers.customer_orders.notify_realtime_event", lambda *a, **k: None)

    db = Session()
    a = models.Tenant(name="PG A", subdomain_or_code="pg-a", is_active=True)
    b = models.Tenant(name="PG B", subdomain_or_code="pg-b", is_active=True)
    db.add_all([a, b])
    db.flush()
    pw = get_password_hash("Passw0rd!test")
    for name, role, tenant in (("c1", "CASHIER", a), ("c2", "CASHIER", a), ("m1", "MANAGER", a), ("k1", "KITCHEN", a)):
        db.add(models.User(username=name, email=f"{name}@pg.test", password_hash=pw, role=models.UserRole(role), tenant_id=tenant.id))
    cake = models.Product(tenant_id=a.id, name="Cake", sku="CAKE", price=Decimal("100.00"), cost=0, preparation_station="none")
    burger = models.Product(tenant_id=a.id, name="Burger", sku="BURGER", price=Decimal("50.00"), cost=0, preparation_station="none")
    db.add_all([cake, burger])
    db.flush()
    beef = models.InventoryItem(tenant_id=a.id, name="Beef", unit="pc", quantity=Decimal("3"), min_stock=0, unit_price=0)
    db.add(beef)
    db.flush()
    db.add(models.ProductRecipe(product_id=burger.id, inventory_item_id=beef.id, quantity=Decimal("1")))
    db.commit()
    ids = {"a": a.id, "cake": cake.id, "burger": burger.id, "beef": beef.id}
    db.close()

    with TestClient(app) as client:
        client.headers["Origin"] = "http://testserver"
        heads = {}
        for name in ("c1", "c2", "m1", "k1"):
            r = client.post("/api/v1/auth/login", data={"username": name, "password": "Passw0rd!test"})
            assert r.status_code == 200, r.text
            heads[name] = {"Authorization": f"Bearer {r.json()['access_token']}"}
        yield client, heads, ids, Session
    app.dependency_overrides.pop(get_db, None)


def race(*calls):
    """Start every call at the same moment (barrier) on its own thread; return their results in order."""
    barrier = threading.Barrier(len(calls))

    def run(fn):
        barrier.wait()
        return fn()

    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        return [f.result() for f in [pool.submit(run, fn) for fn in calls]]


def count(Session, model, **filters):
    db = Session()
    try:
        return db.query(model).filter_by(**filters).count()
    finally:
        db.close()


def place_order(client, ids, method="GCASH", product="cake"):
    r = client.post("/api/v1/customer-orders", json={"tenant_id": ids["a"], "payment_method": method,
                                                     "items": [{"product_id": ids[product], "quantity": 1}]})
    assert r.status_code == 201, r.text
    return r.json()["order_id"]


# ---------------------------------------------------------------------------------------------- tests
def test_identical_concurrent_checkouts_create_exactly_one_sale(api):
    import app.models as models
    client, h, ids, Session = api
    body = {"client_tx_id": "11111111-0000-0000-0000-000000000001", "payment_method": "CASH", "amount_paid": 100,
            "items": [{"product_id": ids["cake"], "quantity": 1}]}
    results = race(*[lambda: client.post("/api/v1/transactions", headers=h["c1"], json=body)] * THREADS)
    assert all(r.status_code == 201 for r in results), [r.text for r in results]
    assert len({r.json()["id"] for r in results}) == 1
    assert count(Session, models.Transaction) == 1 and count(Session, models.Payment) == 1
    assert count(Session, models.ActivityLog, action="POS Sale") == 1


def test_two_cashiers_settling_one_order_with_different_keys_make_one_sale(api):
    import app.models as models
    client, h, ids, Session = api
    oid = place_order(client, ids, method="PAY_AT_COUNTER")
    calls = [lambda i=i: client.post("/api/v1/transactions", headers=h["c1" if i % 2 else "c2"],
                                     json={"customer_order_id": oid, "client_tx_id": f"22222222-0000-0000-0000-{i:012d}",
                                           "payment_method": "CASH", "amount_paid": 100}) for i in range(THREADS)]
    results = race(*calls)
    assert all(r.status_code == 201 for r in results), [r.text for r in results]
    assert len({r.json()["id"] for r in results}) == 1
    assert count(Session, models.Transaction, customer_order_id=oid) == 1 and count(Session, models.Payment) == 1


def test_one_gcash_reference_cannot_verify_two_orders_concurrently(api):
    import app.models as models
    client, h, ids, Session = api
    orders = [place_order(client, ids) for _ in range(THREADS)]
    calls = [lambda o=o: client.post(f"/api/v1/customer-orders/{o}/payment/verify", headers=h["c1"],
                                     json={"amount_received": "100.00", "reference_no": "5555 666 777 888"}) for o in orders]
    results = race(*calls)
    ok = [r for r in results if r.status_code == 200 and r.json()["verified"]]
    assert len(ok) == 1, [r.status_code for r in results]
    assert all(r.status_code == 409 for r in results if r not in ok)
    assert count(Session, models.CustomerOrder, payment_status="verified") == 1
    assert count(Session, models.PaymentVerification, claimed_reference="5555666777888") == 1


def test_verification_racing_with_rejection_never_leaves_an_unaudited_paid_rejection(api):
    import app.models as models
    client, h, ids, Session = api
    for _ in range(4):
        oid = place_order(client, ids)
        verify_r, reject_r = race(
            lambda: client.post(f"/api/v1/customer-orders/{oid}/payment/verify", headers=h["c1"], json={"amount_received": "100"}),
            lambda: client.put(f"/api/v1/customer-orders/{oid}/status", headers=h["c2"], json={"status": "rejected"}),
        )
        db = Session()
        o = db.get(models.CustomerOrder, oid)
        if o.status == "rejected" and o.payment_status == "verified":
            # Verified first, then rejected: the rejection must have seen the payment and audited it.
            assert db.query(models.ActivityLog).filter(models.ActivityLog.action == "Paid Order Rejected",
                                                       models.ActivityLog.details.contains(o.order_number)).count() == 1
        else:
            # Rejected first: the verification must have been refused and nothing verified.
            assert o.status == "rejected" and o.payment_status == "unpaid" and verify_r.status_code == 409
        db.close()


def test_sale_racing_with_rejection_never_leaves_a_rejected_order_with_an_active_sale(api):
    import app.models as models
    client, h, ids, Session = api
    for i in range(4):
        oid = place_order(client, ids, method="PAY_AT_COUNTER")
        race(
            lambda: client.post("/api/v1/transactions", headers=h["c1"], json={
                "customer_order_id": oid, "client_tx_id": f"33333333-0000-0000-0000-{i:012d}", "payment_method": "CASH"}),
            lambda: client.put(f"/api/v1/customer-orders/{oid}/status", headers=h["c2"], json={"status": "rejected"}),
        )
        db = Session()
        o = db.get(models.CustomerOrder, oid)
        sold = db.query(models.Transaction).filter_by(customer_order_id=oid).count()
        assert (o.status == "rejected" and sold == 0) or (o.status == "completed" and sold == 1), (o.status, sold)
        db.close()


def test_concurrent_sales_cannot_oversell_recipe_stock(api, monkeypatch):
    import app.models as models
    monkeypatch.setenv("INVENTORY_DEDUCTION", "on_sale")
    client, h, ids, Session = api
    calls = [lambda i=i: client.post("/api/v1/transactions", headers=h["c1" if i % 2 else "c2"], json={
        "client_tx_id": f"44444444-0000-0000-0000-{i:012d}", "items": [{"product_id": ids["burger"], "quantity": 1}]})
        for i in range(THREADS)]
    results = race(*calls)
    assert sorted(r.status_code for r in results) == [201] * 3 + [409] * (THREADS - 3)
    db = Session()
    assert db.get(models.InventoryItem, ids["beef"]).quantity == 0
    assert db.query(models.StockMovement).filter_by(movement_type="SALE").count() == 3
    assert db.query(models.Transaction).count() == 3
    db.close()


def test_concurrent_voids_restore_stock_once_and_flag_one_refund(api, monkeypatch):
    import app.models as models
    monkeypatch.setenv("INVENTORY_DEDUCTION", "on_sale")
    client, h, ids, Session = api
    tx_id = client.post("/api/v1/transactions", headers=h["c1"], json={
        "items": [{"product_id": ids["burger"], "quantity": 2}]}).json()["id"]
    results = race(*[lambda: client.put(f"/api/v1/transactions/{tx_id}/status", headers=h["c2"],
                                        json={"status": "cancelled", "reason": "duplicate tap"})] * THREADS)
    assert sorted(r.status_code for r in results) == [200] + [400] * (THREADS - 1)
    db = Session()
    assert db.get(models.InventoryItem, ids["beef"]).quantity == 3
    assert db.query(models.StockMovement).filter_by(movement_type="REVERSAL").count() == 1
    assert db.query(models.ActivityLog).filter_by(action="Order Cancelled/Rejected").count() == 1
    db.close()
    refunds = race(*[lambda: client.post(f"/api/v1/transactions/{tx_id}/refund", headers=h["m1"], json={
        "amount": "100", "refund_method": "CASH", "note": "cash handed back"})] * 4)
    assert sorted(r.status_code for r in refunds) == [200, 409, 409, 409]
    assert count(Session, models.SaleRefund) == 1


def test_failure_after_writes_rolls_everything_back_on_postgres(api, monkeypatch):
    import app.models as models
    client, h, ids, Session = api

    def boom(*a, **k):
        raise RuntimeError("simulated database failure after the sale rows were flushed")

    monkeypatch.setattr("app.services.stock.deduct_for_sale", boom)
    body = {"client_tx_id": "55555555-0000-0000-0000-000000000001", "items": [{"product_id": ids["cake"], "quantity": 1}]}
    assert client.post("/api/v1/transactions", headers=h["c1"], json=body).status_code == 500
    assert count(Session, models.Transaction) == 0 and count(Session, models.Payment) == 0
    assert count(Session, models.TransactionItem) == 0 and count(Session, models.ActivityLog, action="POS Sale") == 0
    monkeypatch.undo()
    retry = client.post("/api/v1/transactions", headers=h["c1"], json=body)
    assert retry.status_code == 201 and "idempotent_replay" not in retry.json()
    again = client.post("/api/v1/transactions", headers=h["c1"], json=body)    # e.g. the reply was lost
    assert again.json()["idempotent_replay"] is True and again.json()["id"] == retry.json()["id"]
    assert count(Session, models.Transaction) == 1


def test_select_for_update_is_really_emitted_and_blocks(api):
    """Sanity check that row locks work on this server: a second FOR UPDATE waits for the first commit."""
    from sqlalchemy import text
    import time
    client, h, ids, Session = api
    oid = place_order(client, ids)
    holder = Session()
    holder.execute(text("SELECT id FROM customer_orders WHERE id = :i FOR UPDATE"), {"i": oid})
    started = time.monotonic()

    def release():
        time.sleep(0.8)
        holder.commit()

    t = threading.Thread(target=release)
    t.start()
    r = client.post(f"/api/v1/customer-orders/{oid}/payment/verify", headers=h["c1"], json={"amount_received": "100"})
    t.join()
    holder.close()
    assert r.status_code == 200 and time.monotonic() - started >= 0.7


# ---------------------------------------------------------------------------------------------- cash drawer (2026-10-29)
def open_shift(client, h, who="c1", cash="300"):
    r = client.post("/api/v1/shifts/start", headers=h[who], json={"start_cash": cash})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_concurrent_cashouts_of_one_shift_close_it_once(api):
    import app.models as models
    client, h, ids, Session = api
    sid = open_shift(client, h)
    results = race(*[lambda: client.post("/api/v1/shifts/cashout", headers=h["m1"], json={"shift_id": sid})] * THREADS)
    codes = sorted(r.status_code for r in results)
    assert codes == [200] + [409] * (THREADS - 1), [r.text for r in results]
    assert count(Session, models.ShiftCashMovement, shift_id=sid, type="PAID_OUT") == 1
    assert count(Session, models.Shift, status="closed") == 1 and count(Session, models.Shift, status="open") == 1


def test_cashout_racing_a_drawer_edit_never_writes_to_a_closed_shift(api):
    import app.models as models
    client, h, ids, Session = api
    sid = open_shift(client, h, cash="300")
    for _ in range(5):
        movements_before = count(Session, models.ShiftCashMovement, shift_id=sid)
        cash, edit = race(lambda: client.post("/api/v1/shifts/cashout", headers=h["m1"], json={"shift_id": sid}),
                          lambda: client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=h["m1"], json={"amount": "50"}))
        assert cash.status_code == 200, cash.text
        if edit.status_code == 200:      # the edit won the lock: the cash-out then empties the edited drawer
            assert cash.json()["amount_cashed_out"] == 50.0
        else:                            # the cash-out won: the edit found the shift closed and wrote nothing
            assert edit.status_code == 400, edit.text
            assert count(Session, models.ShiftCashMovement, shift_id=sid) == movements_before + 1
        db = Session()
        try:
            assert db.get(models.Shift, sid).end_cash == Decimal("0.00")
        finally:
            db.close()
        sid = cash.json()["new_shift_id"]
        client.put(f"/api/v1/shifts/{sid}/drawer-cash", headers=h["m1"], json={"amount": "300"})


def test_concurrent_first_sales_open_one_shift_for_the_cashier(api):
    """Intended rule: one open shift per cashier. NOT expected to pass yet: the sale path's auto-open (and
    POST /shifts/start) is check-then-insert with no lock or unique index, so this documents a known gap."""
    import app.models as models
    client, h, ids, Session = api
    calls = [lambda i=i: client.post("/api/v1/transactions", headers=h["c1"], json={
        "client_tx_id": f"33333333-0000-0000-0000-{i:012d}", "payment_method": "CASH", "amount_paid": 100,
        "items": [{"product_id": ids["cake"], "quantity": 1}]}) for i in range(THREADS)]
    results = race(*calls)
    assert all(r.status_code == 201 for r in results), [r.text for r in results]
    assert count(Session, models.Shift, status="open") == 1

