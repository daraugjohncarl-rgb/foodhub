"""
Cashier ordering hardening: checkout idempotency, the customer's payment choice, manual GCash
verification (cashier-reported amount, no payment gateway), discrepancy handling, and one-sale-per-
online-order processing.

These run on SQLite. They prove the application logic and that the database constraints reject
duplicates; they do NOT prove PostgreSQL row-locking or isolation behaviour (see
docs/REMEDIATION_STATUS.md for the staging test plan).
"""
import threading
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError

from conftest import R
import app.models as models

KEY_A = "aaaaaaaa-0000-0000-0000-000000000001"
KEY_B = "bbbbbbbb-0000-0000-0000-000000000002"


# --------------------------------------------------------------------------------------- fixtures
@pytest.fixture
def shop(tenants, make_user, make_product, login):
    a, b = tenants
    make_user("cash_a", R.CASHIER, a)
    make_user("cash_a2", R.CASHIER, a)
    make_user("mgr_a", R.MANAGER, a)
    make_user("kitchen_a", R.KITCHEN, a)
    make_user("cash_b", R.CASHIER, b)
    class Ref:   # plain ids only: ORM objects must not be touched from the worker threads some tests use
        def __init__(self, obj):
            self.id = obj.id

    return {
        "a": Ref(a), "b": Ref(b),
        "cash": login("cash_a"), "cash2": login("cash_a2"), "mgr": login("mgr_a"),
        "kitchen": login("kitchen_a"), "cash_b": login("cash_b"),
        "burger": Ref(make_product(a, "Burger", "50.00")),
        "fries": Ref(make_product(a, "Fries", "19.99")),
        "cake": Ref(make_product(a, "Cake", "100.00")),
        "soda": Ref(make_product(a, "Soda", "30.00", station="drinks")),
        "b_item": Ref(make_product(b, "Bowl", "75.00")),
    }


@pytest.fixture
def events(monkeypatch):
    sent = []

    def fake(tenant_id, event_type, data=None):
        sent.append((tenant_id, event_type, data or {}))

    monkeypatch.setattr("app.core.websocket.notify_realtime_event", fake)
    monkeypatch.setattr("app.routers.customer_orders.notify_realtime_event", fake)
    return sent


def order(client, shop, product="cake", qty=1, method="GCASH", tenant="a", **extra):
    body = {"tenant_id": shop[tenant].id, "customer_name": "Maria", "order_type": "Dine In", "table_number": "5",
            "items": [{"product_id": shop[product].id, "quantity": qty}], **extra}
    if method is not None:
        body["payment_method"] = method
    resp = client.post("/api/v1/customer-orders", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["order_id"]


def verify(client, shop, order_id, amount, who="cash", **extra):
    return client.post(f"/api/v1/customer-orders/{order_id}/payment/verify", headers=shop[who],
                       json={"amount_received": amount, **extra})


def sale(client, shop, body, who="cash"):
    return client.post("/api/v1/transactions", headers=shop[who], json=body)


def cart_sale(client, shop, product="cake", qty=1, who="cash", **extra):
    return sale(client, shop, {"items": [{"product_id": shop[product].id, "quantity": qty}], **extra}, who)


def fresh(db, model, pk):
    db.expire_all()
    return db.get(model, pk)


# =============================================================================== checkout idempotency
def test_normal_sale_stores_key_and_fingerprint(client, shop, db):
    resp = cart_sale(client, shop, client_tx_id=KEY_A, payment_method="Cash", amount_paid=150)
    assert resp.status_code == 201
    tx = db.get(models.Transaction, resp.json()["id"])
    assert tx.client_tx_id == KEY_A and len(tx.request_fingerprint) == 64
    assert str(tx.net_amount) == "100.00" and [p.status for p in tx.payments] == ["completed"]


def test_double_click_creates_one_sale_and_no_second_audit_or_event(client, shop, db, events):
    first = cart_sale(client, shop, client_tx_id=KEY_A)
    after_first = len(events)
    logs_after_first = db.query(models.ActivityLog).count()
    again = cart_sale(client, shop, client_tx_id=KEY_A)
    assert first.status_code == again.status_code == 201
    assert first.json()["id"] == again.json()["id"] and again.json()["idempotent_replay"] is True
    assert db.query(models.Transaction).count() == db.query(models.Payment).count() == 1
    assert db.query(models.ActivityLog).count() == logs_after_first      # no duplicate audit entry
    assert len(events) == after_first                                     # no duplicate events
    assert db.query(models.Shift).count() == 1


def test_same_key_with_different_payload_is_rejected(client, shop, db):
    assert cart_sale(client, shop, qty=1, client_tx_id=KEY_A).status_code == 201
    assert cart_sale(client, shop, qty=2, client_tx_id=KEY_A).status_code == 409           # different quantity
    assert cart_sale(client, shop, product="burger", client_tx_id=KEY_A).status_code == 409  # different item
    assert cart_sale(client, shop, client_tx_id=KEY_A, payment_method="GCASH").status_code == 409
    assert cart_sale(client, shop, client_tx_id=KEY_A, discount_amount="5").status_code == 409
    assert db.query(models.Transaction).count() == 1


def test_retry_with_reordered_or_split_lines_is_the_same_checkout(client, shop, db):
    body = {"client_tx_id": KEY_A, "items": [{"product_id": shop["burger"].id, "quantity": 1},
                                             {"product_id": shop["cake"].id, "quantity": 1}]}
    assert sale(client, shop, body).status_code == 201
    body["items"] = [{"product_id": shop["cake"].id, "quantity": 1}, {"product_id": shop["burger"].id, "quantity": 1}]
    assert sale(client, shop, body).json()["idempotent_replay"] is True
    assert db.query(models.Transaction).count() == 1


def test_changed_tendered_cash_on_retry_is_still_the_same_checkout(client, shop, db):
    assert cart_sale(client, shop, client_tx_id=KEY_A, payment_method="Cash", amount_paid=100).status_code == 201
    again = cart_sale(client, shop, client_tx_id=KEY_A, payment_method="Cash", amount_paid=500)
    assert again.status_code == 201 and again.json()["idempotent_replay"] is True
    assert db.query(models.Transaction).count() == 1


def test_failed_request_can_be_retried_with_the_same_key(client, shop, db):
    too_little = cart_sale(client, shop, client_tx_id=KEY_A, payment_method="Cash", amount_paid=10)
    assert too_little.status_code == 400 and db.query(models.Transaction).count() == 0
    ok = cart_sale(client, shop, client_tx_id=KEY_A, payment_method="Cash", amount_paid=100)
    assert ok.status_code == 201 and "idempotent_replay" not in ok.json()
    assert db.query(models.Transaction).count() == 1


def test_concurrent_identical_checkouts_create_one_sale(client, shop, db):
    barrier = threading.Barrier(6)

    def fire(_):
        barrier.wait()
        return cart_sale(client, shop, client_tx_id=KEY_A).status_code

    with ThreadPoolExecutor(6) as pool:
        codes = list(pool.map(fire, range(6)))
    assert set(codes) <= {201, 409}, codes     # 409 = "could not record, retry"; never a 5xx duplicate
    assert db.query(models.Transaction).count() == 1
    assert db.query(models.Payment).count() == 1
    assert db.query(models.ActivityLog).filter(models.ActivityLog.action == "POS Sale").count() == 1


def test_legacy_sale_without_fingerprint_still_replays(client, shop, db):
    resp = cart_sale(client, shop, client_tx_id=KEY_A)
    tx = db.get(models.Transaction, resp.json()["id"])
    tx.request_fingerprint = None
    db.commit()
    assert cart_sale(client, shop, qty=3, client_tx_id=KEY_A).json()["id"] == resp.json()["id"]


@pytest.mark.parametrize("method", ["GCASH", "CARD"])
def test_non_cash_payment_must_equal_the_amount_due(client, shop, db, method):
    assert cart_sale(client, shop, payment_method=method, amount_paid=150).status_code == 400
    assert cart_sale(client, shop, payment_method=method, amount_paid=50).status_code == 400
    assert cart_sale(client, shop, payment_method=method, amount_paid=100).status_code == 201
    assert cart_sale(client, shop, payment_method="CASH", amount_paid=200).status_code == 201   # cash keeps change
    assert db.query(models.Transaction).count() == 2


def test_card_sale_counts_as_non_cash_and_not_in_the_drawer(client, shop, db):
    cart_sale(client, shop, payment_method="CARD", amount_paid=100)
    cart_sale(client, shop, payment_method="CASH", amount_paid=100)
    summary = client.get("/api/v1/shifts/drawer-summary", headers=shop["cash"]).json()
    shift = summary["shifts"][0]
    assert Decimal(str(shift["expected_cash"])) == Decimal("100.00")


# =========================================================================== customer's payment choice
def test_payment_choice_is_persisted_and_normalised(client, shop, db):
    gc = order(client, shop, method="gcash")
    counter = order(client, shop, method="pay at counter")
    assert db.get(models.CustomerOrder, gc).payment_method == "GCASH"
    assert db.get(models.CustomerOrder, counter).payment_method == "PAY_AT_COUNTER"
    assert db.get(models.CustomerOrder, gc).payment_status == "unpaid"   # a choice is not a payment


def test_invalid_payment_choice_is_rejected(client, shop):
    for bad in ("BITCOIN", "CASH", "paymaya", "x" * 31):
        resp = client.post("/api/v1/customer-orders", json={"tenant_id": shop["a"].id, "payment_method": bad,
                                                           "items": [{"product_id": shop["cake"].id, "quantity": 1}]})
        assert resp.status_code in (400, 422), bad


def test_customer_cannot_mark_their_own_order_paid_or_verified(client, shop, db):
    resp = client.post("/api/v1/customer-orders", json={
        "tenant_id": shop["a"].id, "payment_method": "GCASH", "payment_status": "verified",
        "verified": True, "amount_received": "100.00", "status": "completed",
        "items": [{"product_id": shop["cake"].id, "quantity": 1, "price": "0.01"}]})
    assert resp.status_code == 201
    o = db.get(models.CustomerOrder, resp.json()["order_id"])
    assert (o.payment_status, o.status, str(o.total_amount)) == ("unpaid", "pending", "100.00")


def test_cashier_sees_the_saved_choice_and_status(client, shop):
    gc = order(client, shop, method="GCASH")
    counter = order(client, shop, method="PAY_AT_COUNTER")
    pending = {o["id"]: o for o in client.get("/api/v1/customer-orders/pending", headers=shop["cash"]).json()}
    assert pending[gc]["payment_method"] == "GCASH" and pending[gc]["payment_status"] == "unpaid"
    assert pending[counter]["payment_method"] == "PAY_AT_COUNTER"
    history = {o["id"]: o for o in client.get("/api/v1/customer-orders/history", headers=shop["cash"]).json()}
    assert history[gc]["sale_recorded"] is False and history[gc]["payment_attempt"] is None


def test_legacy_order_without_a_method_is_never_treated_as_gcash(client, shop, db):
    legacy = order(client, shop, method=None)
    o = db.get(models.CustomerOrder, legacy)
    assert o.payment_method is None and o.payment_status == "unpaid"
    assert verify(client, shop, legacy, "100.00").status_code == 409            # not a GCash order
    assert client.get("/api/v1/customer-orders/pending", headers=shop["cash"]).json()[0]["payment_method"] is None
    paid = sale(client, shop, {"customer_order_id": legacy, "payment_method": "Cash", "amount_paid": 100})
    assert paid.status_code == 201
    assert fresh(db, models.CustomerOrder, legacy).payment_status == "counter_paid"   # recorded by the cashier at the till


def test_customer_tracking_shows_choice_but_no_payment_details(client, shop, db):
    resp = client.post("/api/v1/customer-orders", json={"tenant_id": shop["a"].id, "payment_method": "GCASH",
                                                        "items": [{"product_id": shop["cake"].id, "quantity": 1}]})
    number, token, oid = resp.json()["order_number"], resp.json()["tracking_token"], resp.json()["order_id"]
    verify(client, shop, oid, "90.00")                                            # discrepancy
    tracked = client.get(f"/api/v1/customer-orders/track/{number}", headers={"X-Tracking-Token": token}).json()
    assert tracked["payment_method"] == "GCASH" and tracked["payment_status"] == "under_review"
    assert "payment_attempt" not in tracked and "transaction_id" not in tracked
    assert "90" not in str(tracked.get("payment_status"))


# ============================================================================ manual GCash verification
def test_exact_amount_is_verified_without_touching_fulfilment(client, shop, db):
    oid = order(client, shop)
    resp = verify(client, shop, oid, "100.00", reference_no="gc 1234 5678 901")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["verified"] is True and body["outcome"] == "matched" and body["payment_status"] == "verified"
    assert body["expected_amount"] == 100.0 and body["discrepancy_amount"] == 0.0
    assert body["reference_no"] == "GC12345678901"                       # whitespace dropped, upper-cased
    assert "not confirmed by GCash" in body["basis"]                    # the UI/API never claims GCash confirmed it
    o = fresh(db, models.CustomerOrder, oid)
    assert (o.status, o.payment_status) == ("pending", "verified")       # fulfilment status unchanged
    assert db.query(models.Transaction).count() == 0                     # verifying is not selling
    attempt = db.query(models.PaymentVerification).one()
    assert attempt.claimed_reference == attempt.reference_no and attempt.attempted_by is not None


def test_underpayment_is_flagged_not_verified(client, shop, db):
    oid = order(client, shop)
    body = verify(client, shop, oid, "90.00").json()
    assert body["verified"] is False and body["outcome"] == "mismatch" and body["payment_status"] == "discrepancy"
    assert body["expected_amount"] == 100.0 and body["reported_amount"] == 90.0 and body["discrepancy_amount"] == -10.0
    o = fresh(db, models.CustomerOrder, oid)
    assert (o.status, o.payment_status) == ("pending", "discrepancy")
    attempt = db.query(models.PaymentVerification).one()
    assert attempt.claimed_reference is None and attempt.resolution is None
    assert db.query(models.ActivityLog).filter(models.ActivityLog.action == "GCash Payment Discrepancy").count() == 1


def test_overpayment_is_flagged_too(client, shop, db):
    oid = order(client, shop)
    body = verify(client, shop, oid, "100.50").json()
    assert body["outcome"] == "mismatch" and body["discrepancy_amount"] == 0.5
    assert fresh(db, models.CustomerOrder, oid).payment_status == "discrepancy"


@pytest.mark.parametrize("bad", ["abc", "-5", -5, "0", 0, "NaN", "Infinity", "-Infinity", "1e12", "100000000", "100.005",
                                 "99.999", True, "", "   ", None, [], {}])
def test_malformed_negative_and_out_of_range_amounts_are_rejected(client, shop, db, bad):
    oid = order(client, shop)
    assert verify(client, shop, oid, bad).status_code in (400, 422)
    assert db.query(models.PaymentVerification).count() == 0
    assert fresh(db, models.CustomerOrder, oid).payment_status == "unpaid"


def test_missing_amount_is_rejected(client, shop):
    oid = order(client, shop)
    resp = client.post(f"/api/v1/customer-orders/{oid}/payment/verify", headers=shop["cash"], json={})
    assert resp.status_code == 400


def test_amount_with_thousands_separator_and_whitespace_parses_exactly(client, shop):
    oid = order(client, shop, product="cake", qty=11)       # 1,100.00
    assert verify(client, shop, oid, " 1,100.00 ").json()["verified"] is True


def test_expected_amount_is_computed_by_the_server_and_is_price_locked(client, shop, db):
    oid = order(client, shop, product="fries", qty=3)                   # 3 x 19.99 = 59.97
    product = db.get(models.Product, shop["fries"].id)
    product.price = Decimal("25.00")                                     # menu price changes afterwards
    db.commit()
    body = verify(client, shop, oid, "59.97", expected_amount="1.00", expected="1.00", total_amount="1.00").json()
    assert body["verified"] is True and body["expected_amount"] == 59.97


def test_client_cannot_force_a_verified_status(client, shop, db):
    oid = order(client, shop)
    body = verify(client, shop, oid, "10.00", payment_status="verified", verified=True, outcome="matched",
                  status="verified", attempted_by=999, tenant_id=999).json()
    assert body["verified"] is False and body["payment_status"] == "discrepancy"
    attempt = db.query(models.PaymentVerification).one()
    assert attempt.attempted_by != 999 and attempt.tenant_id == shop["a"].id


def test_cash_status_endpoint_cannot_set_payment_state(client, shop, db):
    oid = order(client, shop)
    resp = client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"],
                      json={"status": "accepted", "payment_status": "verified"})
    assert resp.status_code == 200
    assert fresh(db, models.CustomerOrder, oid).payment_status == "unpaid"


def test_repeating_the_same_verification_is_safe(client, shop, db):
    oid = order(client, shop)
    assert verify(client, shop, oid, "100.00", reference_no="REF-0001").status_code == 200
    again = verify(client, shop, oid, "100", reference_no="ref-0001")
    assert again.status_code == 200 and again.json()["verified"] is True
    assert db.query(models.PaymentVerification).count() == 1
    assert verify(client, shop, oid, "99.00").status_code == 409          # cannot change a verified payment
    assert verify(client, shop, oid, "100.00", reference_no="OTHER-REF").status_code == 409
    assert db.query(models.PaymentVerification).count() == 1


def test_matching_reverification_supersedes_but_keeps_the_discrepancy(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "90.00")
    fixed = verify(client, shop, oid, "100.00", who="cash2")
    assert fixed.json()["verified"] is True
    first, second = db.query(models.PaymentVerification).order_by(models.PaymentVerification.id).all()
    assert (first.outcome, str(first.reported_amount), first.resolution) == ("mismatch", "90.00", "superseded")
    assert first.resolved_by is not None and first.resolved_by != first.attempted_by   # who corrected it is recorded
    assert (second.outcome, second.resolution) == ("matched", None)
    assert fresh(db, models.CustomerOrder, oid).payment_status == "verified"


def test_repeated_mismatches_each_leave_a_record(client, shop, db):
    oid = order(client, shop)
    for amount in ("90.00", "95.00", "90.00"):
        assert verify(client, shop, oid, amount).json()["outcome"] == "mismatch"
    assert db.query(models.PaymentVerification).count() == 3
    assert fresh(db, models.CustomerOrder, oid).payment_status == "discrepancy"


def test_duplicate_reference_cannot_verify_a_second_order(client, shop, db):
    first, second = order(client, shop), order(client, shop)
    assert verify(client, shop, first, "100.00", reference_no="GC 1234 5678").status_code == 200
    dup = verify(client, shop, second, "100.00", reference_no="gc12345678")     # case/space-insensitive
    assert dup.status_code == 409 and "already used" in dup.json()["detail"]
    assert fresh(db, models.CustomerOrder, first).order_number not in dup.text   # no detail about the other order
    assert fresh(db, models.CustomerOrder, second).payment_status == "unpaid"
    kinds = [a.outcome for a in db.query(models.PaymentVerification).filter_by(customer_order_id=second)]
    assert kinds == ["duplicate_reference"]
    assert db.query(models.ActivityLog).filter(models.ActivityLog.action == "GCash Duplicate Reference").count() == 1
    # the cashier can fix a mistyped reference
    assert verify(client, shop, second, "100.00", reference_no="GC-9999-0000").json()["verified"] is True


def test_same_reference_is_allowed_in_another_tenant_and_without_a_reference(client, shop, db):
    a_order, b_order = order(client, shop), order(client, shop, product="b_item", tenant="b")
    assert verify(client, shop, a_order, "100.00", reference_no="SHARED-REF-1").status_code == 200
    assert verify(client, shop, b_order, "75.00", reference_no="SHARED-REF-1", who="cash_b").json()["verified"] is True
    n1, n2 = order(client, shop), order(client, shop)
    assert verify(client, shop, n1, "100.00").json()["verified"] and verify(client, shop, n2, "100.00").json()["verified"]


def test_a_mismatched_attempt_does_not_reserve_its_reference(client, shop, db):
    first, second = order(client, shop), order(client, shop)
    verify(client, shop, first, "90.00", reference_no="REF-MISMATCH")
    assert verify(client, shop, second, "100.00", reference_no="REF-MISMATCH").json()["verified"] is True


@pytest.mark.parametrize("ref", ["%%%%", "a", "x" * 41, "ref<script>", "REF;DROP"])
def test_invalid_reference_format_is_rejected(client, shop, ref):
    oid = order(client, shop)
    assert verify(client, shop, oid, "100.00", reference_no=ref).status_code in (400, 422)


def test_transaction_time_is_validated_and_stored_as_typed(client, shop, db):
    oid = order(client, shop)
    assert verify(client, shop, oid, "100.00", transaction_time="not-a-time").status_code == 400
    assert verify(client, shop, oid, "100.00", transaction_time="2999-01-01T10:00:00").status_code == 400
    assert verify(client, shop, oid, "100.00", transaction_time="2026-10-24T14:05:00").status_code == 200
    assert db.query(models.PaymentVerification).one().transaction_time.hour == 14


def test_concurrent_verifications_of_one_order_confirm_a_single_outcome(client, shop, db):
    oid = order(client, shop)
    barrier = threading.Barrier(5)

    def fire(_):
        barrier.wait()
        return verify(client, shop, oid, "100.00", reference_no="RACE-REF-1").status_code

    with ThreadPoolExecutor(5) as pool:
        codes = list(pool.map(fire, range(5)))
    assert set(codes) <= {200, 409}, codes
    assert db.query(models.PaymentVerification).filter_by(customer_order_id=oid, outcome="matched").count() == 1
    assert fresh(db, models.CustomerOrder, oid).payment_status == "verified"


def test_concurrent_conflicting_verifications_never_yield_two_outcomes(client, shop, db):
    oid = order(client, shop)
    barrier = threading.Barrier(2)

    def fire(amount):
        barrier.wait()
        return verify(client, shop, oid, amount).json()

    with ThreadPoolExecutor(2) as pool:
        list(pool.map(fire, ["100.00", "50.00"]))
    status = fresh(db, models.CustomerOrder, oid).payment_status
    matched = db.query(models.PaymentVerification).filter_by(customer_order_id=oid, outcome="matched").count()
    assert (status == "verified") == (matched == 1)      # state always agrees with the audit trail
    assert matched <= 1


def test_database_rejects_duplicate_claims_directly(db, shop):
    o1 = models.CustomerOrder(tenant_id=shop["a"].id, order_number="CUST-T1", customer_name="x", order_type="Dine In",
                              total_amount=1, payment_method="GCASH")
    o2 = models.CustomerOrder(tenant_id=shop["a"].id, order_number="CUST-T2", customer_name="x", order_type="Dine In",
                              total_amount=1, payment_method="GCASH")
    db.add_all([o1, o2])
    db.commit()
    for o in (o1, o2):
        db.add(models.PaymentVerification(tenant_id=shop["a"].id, customer_order_id=o.id, expected_amount=1,
                                          reported_amount=1, reference_no="R1", claimed_reference="R1", outcome="matched"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_database_rejects_two_sales_for_one_order(db, shop):
    o = models.CustomerOrder(tenant_id=shop["a"].id, order_number="CUST-T3", customer_name="x", order_type="Dine In", total_amount=1)
    user = db.query(models.User).filter_by(username="cash_a").one()
    db.add(o)
    db.commit()
    s = models.Shift(tenant_id=shop["a"].id, user_id=user.id)
    db.add(s)
    db.commit()
    for i in range(2):
        db.add(models.Transaction(tenant_id=shop["a"].id, shift_id=s.id, user_id=user.id, customer_order_id=o.id,
                                  client_tx_id=f"dup-{i}", total_amount=1, net_amount=1))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


# ====================================================================== permissions and tenant isolation
def test_verification_requires_a_pos_staff_login(client, shop, db):
    oid = order(client, shop)
    client.cookies.clear()      # the login fixtures leave a session cookie on the shared client
    assert client.post(f"/api/v1/customer-orders/{oid}/payment/verify", json={"amount_received": "100"}).status_code == 401
    assert verify(client, shop, oid, "100.00", who="kitchen").status_code == 403
    assert fresh(db, models.CustomerOrder, oid).payment_status == "unpaid"


def test_another_tenants_cashier_cannot_see_verify_or_resolve_an_order(client, shop, db, make_user, login):
    oid = order(client, shop)
    assert verify(client, shop, oid, "100.00", who="cash_b").status_code == 404
    assert client.get("/api/v1/customer-orders/pending", headers=shop["cash_b"]).json() == []
    make_user("mgr_b", R.MANAGER, shop["b"])
    mgr_b = login("mgr_b")
    assert client.post(f"/api/v1/customer-orders/{oid}/payment/resolve", headers=mgr_b, json={"resolution": "invalid", "note": "nope nope"}).status_code == 404
    assert client.get(f"/api/v1/customer-orders/{oid}/payment/attempts", headers=mgr_b).status_code == 404
    assert fresh(db, models.CustomerOrder, oid).payment_status == "unpaid"


def test_a_cashier_cannot_use_another_tenants_order_in_a_sale(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00")
    assert sale(client, shop, {"customer_order_id": oid}, who="cash_b").status_code == 404
    assert db.query(models.Transaction).count() == 0


# ================================================================================ discrepancy handling
def test_a_discrepancy_blocks_fulfilment_and_payment_but_not_rejection(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "90.00")
    for new_status in ("accepted", "preparing", "ready", "completed"):
        resp = client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": new_status})
        assert resp.status_code == 409, new_status
    kitchen = client.put(f"/api/v1/kitchen/orders/CUST-{oid}/status", headers=shop["kitchen"], json={"status": "preparing"})
    assert kitchen.status_code == 409
    assert sale(client, shop, {"customer_order_id": oid}).status_code == 409
    assert db.query(models.Transaction).count() == 0
    assert fresh(db, models.CustomerOrder, oid).status == "pending"
    assert client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "rejected"}).status_code == 200


def test_only_a_manager_can_close_a_discrepancy_and_the_record_survives(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "90.00")
    url = f"/api/v1/customer-orders/{oid}/payment/resolve"
    assert client.post(url, headers=shop["cash"], json={"resolution": "invalid", "note": "customer short-paid"}).status_code == 403
    assert client.post(url, headers=shop["mgr"], json={"resolution": "invalid", "note": "abc"}).status_code == 422          # note required
    assert client.post(url, headers=shop["mgr"], json={"resolution": "accept", "note": "accept the short pay"}).status_code == 400
    ok = client.post(url, headers=shop["mgr"], json={"resolution": "invalid", "note": "Customer short-paid; refunded GCash."})
    assert ok.status_code == 200 and ok.json()["payment_status"] == "invalid"
    attempt = db.query(models.PaymentVerification).one()
    assert (str(attempt.reported_amount), attempt.outcome, attempt.resolution) == ("90.00", "mismatch", "invalidated")
    assert attempt.resolved_by is not None and "refunded" in attempt.resolution_note and attempt.resolved_at
    assert client.post(url, headers=shop["mgr"], json={"resolution": "invalid", "note": "again again"}).status_code == 409
    assert verify(client, shop, oid, "100.00").status_code == 409        # invalid is final for verification


def test_cannot_resolve_a_payment_that_is_not_in_discrepancy(client, shop):
    oid = order(client, shop)
    url = f"/api/v1/customer-orders/{oid}/payment/resolve"
    assert client.post(url, headers=shop["mgr"], json={"resolution": "invalid", "note": "not needed"}).status_code == 409
    verify(client, shop, oid, "100.00")
    assert client.post(url, headers=shop["mgr"], json={"resolution": "invalid", "note": "not needed"}).status_code == 409


def test_audit_trail_is_manager_only_and_names_people(client, shop):
    oid = order(client, shop)
    verify(client, shop, oid, "90.00")
    verify(client, shop, oid, "100.00", who="cash2")
    url = f"/api/v1/customer-orders/{oid}/payment/attempts"
    assert client.get(url, headers=shop["cash"]).status_code == 403
    rows = client.get(url, headers=shop["mgr"]).json()
    assert [r["outcome"] for r in rows] == ["mismatch", "matched"]
    assert rows[0]["attempted_by"] == "cash_a" and rows[0]["resolved_by"] == "cash_a2" and rows[0]["resolution"] == "superseded"


def test_cashier_listings_do_not_leak_who_attempted_or_references(client, shop):
    oid = order(client, shop)
    verify(client, shop, oid, "90.00", reference_no="LEAK-REF-001")
    text = client.get("/api/v1/customer-orders/pending", headers=shop["cash"]).text
    text += client.get("/api/v1/customer-orders/history", headers=shop["cash"]).text
    assert "LEAK-REF-001" not in text and "cash_a" not in text and "attempted_by" not in text


def test_rejecting_a_verified_order_is_audited_for_manual_refund(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00")
    assert client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "rejected"}).status_code == 200
    assert db.query(models.ActivityLog).filter(models.ActivityLog.action == "Paid Order Rejected").count() == 1
    assert verify(client, shop, oid, "100.00").status_code == 409        # rejected orders are not reopened
    assert sale(client, shop, {"customer_order_id": oid}).status_code == 409


# ========================================================================== online order -> POS sale
def test_unverified_gcash_order_cannot_be_recorded_as_a_sale(client, shop, db):
    oid = order(client, shop)
    resp = sale(client, shop, {"customer_order_id": oid, "payment_method": "GCASH", "amount_paid": 100})
    assert resp.status_code == 409 and "Verify" in resp.json()["detail"]
    assert db.query(models.Transaction).count() == 0
    assert fresh(db, models.CustomerOrder, oid).payment_status == "unpaid"


def test_verified_gcash_order_becomes_one_sale_with_server_priced_lines(client, shop, db, events):
    oid = order(client, shop, product="burger", qty=2)                            # 100.00
    verify(client, shop, oid, "100.00", reference_no="PAID-REF-77", transaction_time="2026-10-24T09:30:00")
    events.clear()
    resp = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_A,
                               "items": [{"product_id": shop["burger"].id, "quantity": 1}],     # ignored
                               "total_amount": "1.00"})
    assert resp.status_code == 201, resp.text
    tx = db.get(models.Transaction, resp.json()["id"])
    assert (str(tx.net_amount), tx.customer_order_id) == ("100.00", oid)
    assert [(i.quantity, str(i.unit_price)) for i in tx.items] == [(2, "50.00")]
    pay = tx.payments[0]
    assert (pay.payment_method, pay.status, str(pay.amount), str(pay.amount_received)) == ("GCASH", "completed", "100.00", "100.00")
    assert pay.reference_no == "PAID-REF-77" and pay.verified_by is not None and pay.verified_at is not None
    o = fresh(db, models.CustomerOrder, oid)
    assert (o.status, o.payment_status) == ("completed", "verified")
    types = [e[1] for e in events]
    assert "ORDER_CREATED" in types and "CUSTOMER_ORDER_UPDATED" in types
    payload = [e[2] for e in events if e[1] == "CUSTOMER_ORDER_UPDATED"][0]
    assert set(payload) == {"order_id", "order_number", "status", "payment_status"}     # no amounts/references


def test_gcash_sale_counts_as_non_cash_in_the_shift(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00")
    sale(client, shop, {"customer_order_id": oid})
    shift = client.get("/api/v1/shifts/drawer-summary", headers=shop["cash"]).json()["shifts"][0]
    assert Decimal(str(shift["expected_cash"])) == Decimal("0.00")     # GCash never inflates the cash drawer
    assert Decimal(str(shift["total_sales"])) == Decimal("100.00")


def test_the_method_tax_and_discount_of_a_gcash_order_cannot_be_changed(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00")
    assert sale(client, shop, {"customer_order_id": oid, "payment_method": "Cash"}).status_code == 400
    assert sale(client, shop, {"customer_order_id": oid, "payments": [{"payment_method": "Cash", "amount": 100}]}).status_code == 400
    assert sale(client, shop, {"customer_order_id": oid, "discount_amount": "10"}).status_code == 400
    assert sale(client, shop, {"customer_order_id": oid, "tax_amount": "5"}).status_code == 400
    assert sale(client, shop, {"customer_order_id": oid, "status": "pending"}).status_code == 400
    assert db.query(models.Transaction).count() == 0
    assert sale(client, shop, {"customer_order_id": oid, "payment_method": "gcash"}).status_code == 201


def test_retrying_an_online_order_never_creates_a_second_sale(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00")
    first = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_A})
    same_key = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_A})
    new_key = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_B}, who="cash2")   # e.g. page reloaded / 2nd cashier
    assert first.json()["id"] == same_key.json()["id"] == new_key.json()["id"]
    assert db.query(models.Transaction).count() == db.query(models.Payment).count() == 1


def test_two_cashiers_cannot_process_the_same_order_twice(client, shop, db):
    oid = order(client, shop, method="PAY_AT_COUNTER")
    barrier = threading.Barrier(4)

    def fire(i):
        barrier.wait()
        who = "cash" if i % 2 else "cash2"
        return sale(client, shop, {"customer_order_id": oid, "client_tx_id": f"race-key-{i:02d}", "payment_method": "Cash",
                                   "amount_paid": 100}, who).status_code

    with ThreadPoolExecutor(4) as pool:
        codes = list(pool.map(fire, range(4)))
    assert set(codes) <= {201, 409}, codes
    assert db.query(models.Transaction).filter_by(customer_order_id=oid).count() == 1
    assert db.query(models.Payment).count() == 1
    assert db.query(models.ActivityLog).filter(models.ActivityLog.action == "POS Sale").count() == 1


def test_partial_failure_is_recoverable_and_does_not_double_count(client, shop, db):
    """An old two-step flow left a sale with the order still pending: the next attempt must finish it, not sell again."""
    oid = order(client, shop, method="PAY_AT_COUNTER")
    user = db.query(models.User).filter_by(username="cash_a").one()
    shift = models.Shift(tenant_id=shop["a"].id, user_id=user.id)
    db.add(shift)
    db.commit()
    stranded = models.Transaction(tenant_id=shop["a"].id, shift_id=shift.id, user_id=user.id, customer_order_id=oid,
                                  client_tx_id=KEY_A, total_amount=100, net_amount=100, status="completed")
    stranded.payments = [models.Payment(payment_method="Cash", amount=100, status="completed")]
    db.add(stranded)
    db.commit()
    assert fresh(db, models.CustomerOrder, oid).status == "pending"
    resp = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_B, "payment_method": "Cash", "amount_paid": 100})
    assert resp.status_code == 201 and resp.json()["id"] == stranded.id
    o = fresh(db, models.CustomerOrder, oid)
    assert (o.status, o.payment_status) == ("completed", "counter_paid")
    assert db.query(models.Transaction).count() == 1 and db.query(models.Payment).count() == 1


def test_failure_in_the_middle_of_processing_leaves_nothing_behind_and_can_be_retried(client, shop, db, monkeypatch):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00")
    real = models.ActivityLog

    class Boom:
        def __init__(self, *a, **k):
            raise RuntimeError("simulated crash after the sale was staged")

    monkeypatch.setattr("app.routers.transactions.models.ActivityLog", Boom)
    assert sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_A}).status_code == 500
    monkeypatch.setattr("app.routers.transactions.models.ActivityLog", real)
    db.expire_all()
    assert db.query(models.Transaction).count() == db.query(models.Payment).count() == db.query(models.Shift).count() == 0
    o = db.get(models.CustomerOrder, oid)
    assert (o.status, o.payment_status) == ("pending", "verified")              # order untouched
    ok = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_A})
    assert ok.status_code == 201 and db.query(models.Transaction).count() == 1


def test_no_events_are_sent_for_a_rolled_back_sale(client, shop, db, events, monkeypatch):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00")
    events.clear()

    class Boom:
        def __init__(self, *a, **k):
            raise RuntimeError("boom")

    monkeypatch.setattr("app.routers.transactions.models.ActivityLog", Boom)
    assert sale(client, shop, {"customer_order_id": oid}).status_code == 500
    assert events == []


def test_pay_at_counter_is_not_paid_until_the_cashier_records_it(client, shop, db):
    oid = order(client, shop, method="PAY_AT_COUNTER")
    assert fresh(db, models.CustomerOrder, oid).payment_status == "unpaid"
    assert db.query(models.Transaction).count() == 0
    assert verify(client, shop, oid, "100.00").status_code == 409               # GCash verification does not apply
    assert sale(client, shop, {"customer_order_id": oid, "payment_method": "GCASH"}).status_code == 400
    assert sale(client, shop, {"customer_order_id": oid, "payment_method": "Cash", "amount_paid": 50}).status_code == 400
    paid = sale(client, shop, {"customer_order_id": oid, "payment_method": "CASH", "amount_paid": 200})
    assert paid.status_code == 201 and paid.json()["payment_status"] == "counter_paid"
    tx = db.get(models.Transaction, paid.json()["id"])
    assert tx.payments[0].reference_no is None and tx.payments[0].verified_at is None     # no GCash fields for counter pay
    assert fresh(db, models.CustomerOrder, oid).status == "completed"
    card = order(client, shop, method="PAY_AT_COUNTER")
    assert sale(client, shop, {"customer_order_id": card, "payment_method": "CARD", "amount_paid": 100}).status_code == 201


def test_kitchen_items_still_reach_the_kitchen_from_a_pending_order(client, shop, db):
    oid = order(client, shop, product="soda", method="PAY_AT_COUNTER")
    resp = sale(client, shop, {"customer_order_id": oid, "payment_method": "Cash", "amount_paid": 30})
    assert db.get(models.Transaction, resp.json()["id"]).fulfillment_status == "pending"
    drinks = client.get("/api/v1/kitchen/drinks-orders", headers=shop["cash"])
    assert drinks.status_code == 200 and len(drinks.json()) == 1


def test_an_accepted_order_is_settled_without_a_duplicate_kitchen_ticket(client, shop, db):
    oid = order(client, shop, product="soda", method="PAY_AT_COUNTER")
    client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "accepted"})
    resp = sale(client, shop, {"customer_order_id": oid, "payment_method": "Cash", "amount_paid": 30})
    assert resp.status_code == 201
    tx = db.get(models.Transaction, resp.json()["id"])
    assert tx.fulfillment_status == "completed"                                  # the CUST ticket is the kitchen's
    o = fresh(db, models.CustomerOrder, oid)
    assert (o.status, o.payment_status) == ("accepted", "counter_paid")          # fulfilment untouched by payment


def test_a_kitchen_completed_order_can_still_be_paid_once(client, shop, db):
    oid = order(client, shop, method="PAY_AT_COUNTER")
    client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "accepted"})
    client.put(f"/api/v1/customer-orders/{oid}/status", headers=shop["cash"], json={"status": "completed"})
    assert fresh(db, models.CustomerOrder, oid).payment_status == "unpaid"       # completed != paid
    assert sale(client, shop, {"customer_order_id": oid, "payment_method": "Cash", "amount_paid": 100}).status_code == 201


def test_invalid_customer_order_ids(client, shop):
    for bad in ("abc", 0, -3, True, 1.5):
        assert sale(client, shop, {"customer_order_id": bad}).status_code == 400, bad
    assert sale(client, shop, {"customer_order_id": 424242}).status_code == 404


# ===================================================================== history, receipts and regression
def test_transaction_history_shows_verification_but_hides_audit_data_from_cashiers(client, shop, db):
    oid = order(client, shop)
    verify(client, shop, oid, "100.00", reference_no="HIST-REF-5")
    sale(client, shop, {"customer_order_id": oid})
    cashier_view = client.get("/api/v1/transactions", headers=shop["cash"]).json()[0]
    assert cashier_view["customer_order_id"] == oid
    assert cashier_view["payments"][0]["verification"] == "cashier_verified"
    assert "reference_no" not in cashier_view["payments"][0] and "verified_by" not in cashier_view["payments"][0]
    manager_view = client.get("/api/v1/transactions", headers=shop["mgr"]).json()[0]
    assert manager_view["payments"][0]["reference_no"] == "HIST-REF-5"
    assert manager_view["payments"][0]["amount_received"] == 100.0


def test_cancelled_online_sale_is_excluded_and_cannot_be_resold(client, shop, db):
    oid = order(client, shop, method="PAY_AT_COUNTER")
    tx_id = sale(client, shop, {"customer_order_id": oid, "payment_method": "Cash", "amount_paid": 100}).json()["id"]
    assert client.put(f"/api/v1/transactions/{tx_id}/status", headers=shop["cash"], json={"status": "cancelled", "reason": "test"}).status_code == 200
    again = sale(client, shop, {"customer_order_id": oid, "client_tx_id": KEY_B, "payment_method": "Cash", "amount_paid": 100})
    # The voided sale is not replayed as if it were valid (2026-10-27): the retry is refused outright.
    assert again.status_code == 409 and db.query(models.Transaction).count() == 1
    shift = client.get("/api/v1/shifts/drawer-summary", headers=shop["cash"]).json()["shifts"][0]
    assert Decimal(str(shift["expected_cash"])) == Decimal("0.00")


def test_stock_is_not_touched_by_online_order_sales_so_retries_cannot_double_deduct(client, shop, db):
    item = models.InventoryItem(tenant_id=shop["a"].id, name="Flour", unit="kg", quantity=10)
    db.add(item)
    db.commit()
    db.add(models.ProductRecipe(product_id=shop["cake"].id, inventory_item_id=item.id, quantity=1))
    db.commit()
    oid = order(client, shop, method="PAY_AT_COUNTER")
    for key in (KEY_A, KEY_B):
        sale(client, shop, {"customer_order_id": oid, "client_tx_id": key, "payment_method": "Cash", "amount_paid": 100})
    db.expire_all()
    assert db.get(models.InventoryItem, item.id).quantity == Decimal("10.00")   # policy gap: no deduction exists at all


def test_gcash_is_not_counted_as_cash_anywhere(client, shop, db):
    """Regression: the drawer queries matched LIKE '%cash%', which also matches 'GCASH'."""
    cart_sale(client, shop, payment_method="GCASH", amount_paid=100)
    cart_sale(client, shop, payment_method="Cash", amount_paid=100)
    summary = client.get("/api/v1/shifts/drawer-summary", headers=shop["cash"]).json()
    shift = summary["shifts"][0]
    assert (shift["cash_sales"], shift["non_cash_sales"], shift["expected_cash"]) == (100.0, 100.0, 100.0)
    assert summary["today_total_cash_sales"] == 100.0
    dash = client.get("/api/v1/analytics/dashboard", headers=shop["mgr"])
    assert dash.status_code == 200


def test_single_order_endpoint_is_staff_only_tenant_scoped_and_does_not_shadow_other_routes(client, shop):
    oid = order(client, shop)
    ok = client.get(f"/api/v1/customer-orders/{oid}", headers=shop["cash"])
    assert ok.status_code == 200
    body = ok.json()
    assert (body["payment_method"], body["payment_status"], body["sale_recorded"], body["payment_attempt"]) == ("GCASH", "unpaid", False, None)
    assert client.get(f"/api/v1/customer-orders/{oid}", headers=shop["cash_b"]).status_code == 404
    assert client.get(f"/api/v1/customer-orders/{oid}", headers=shop["kitchen"]).status_code == 403
    client.cookies.clear()
    assert client.get(f"/api/v1/customer-orders/{oid}").status_code == 401
    assert client.get(f"/api/v1/customer-orders/menu?tenant_id={shop['a'].id}").status_code == 200   # still the public menu
    assert client.get("/api/v1/customer-orders/pending", headers=shop["cash"]).status_code == 200
    assert client.get("/api/v1/customer-orders/history", headers=shop["cash"]).status_code == 200
