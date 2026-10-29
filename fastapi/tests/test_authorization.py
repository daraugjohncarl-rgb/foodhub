"""P0 regression tests: authentication, role-based access control and tenant isolation."""
import pytest

from conftest import R, PASSWORD
import app.models as models

STAFF_ONLY_ENDPOINTS = [
    ("GET", "/api/v1/users"),
    ("GET", "/api/v1/users/stats"),
    ("POST", "/api/v1/users"),
    ("GET", "/api/v1/transactions"),
    ("POST", "/api/v1/transactions"),
    ("GET", "/api/v1/shifts/active"),
    ("POST", "/api/v1/shifts/start"),
    ("GET", "/api/v1/kitchen/orders"),
    ("GET", "/api/v1/kitchen/drinks-orders"),
    ("GET", "/api/v1/customer-orders/pending"),
    ("GET", "/api/v1/customer-orders/history"),
    ("PUT", "/api/v1/customer-orders/1/status"),
    ("GET", "/api/v1/tables"),
    ("GET", "/api/v1/activity-logs"),
    ("POST", "/api/v1/activity-logs"),
    ("DELETE", "/api/v1/activity-logs"),
    ("GET", "/api/v1/analytics/dashboard"),
    ("GET", "/api/v1/analytics/profit-loss"),
    ("GET", "/api/v1/expenses"),
    ("GET", "/api/v1/products"),
    ("GET", "/api/v1/categories"),
    ("GET", "/api/v1/inventory"),
    ("GET", "/api/v1/suppliers"),
    ("GET", "/api/v1/purchase-orders"),
    ("POST", "/api/v1/reports"),
]


def call(client, method, path, headers=None, json=None):
    return client.request(method, path, headers=headers, json=json if json is not None else ({} if method in ("POST", "PUT") else None))


@pytest.mark.parametrize("method,path", STAFF_ONLY_ENDPOINTS)
def test_unauthenticated_requests_are_rejected(client, method, path):
    assert call(client, method, path).status_code == 401


@pytest.mark.parametrize("method,path", STAFF_ONLY_ENDPOINTS)
def test_customer_cannot_use_staff_endpoints(client, tenants, make_user, login, method, path):
    tenant_a, _ = tenants
    make_user("cust", R.CUSTOMER, tenant_a)
    resp = call(client, method, path, login("cust"))
    assert resp.status_code == 403, f"{method} {path} returned {resp.status_code}"


@pytest.mark.parametrize("role", [R.CASHIER, R.KITCHEN, R.INVENTORY])
def test_non_management_roles_cannot_manage_users(client, tenants, make_user, login, role):
    tenant_a, _ = tenants
    make_user("worker", role, tenant_a)
    target = make_user("victim", R.CASHIER, tenant_a)
    headers = login("worker")

    assert client.get("/api/v1/users", headers=headers).status_code == 403
    assert client.post("/api/v1/users", headers=headers, json={"username": "evil", "password": "Passw0rd!x", "role": "MANAGER"}).status_code == 403
    assert client.put(f"/api/v1/users/{target.id}/password", headers=headers, json={"new_password": "Hacked123!"}).status_code == 403
    assert client.put(f"/api/v1/users/{target.id}/status", headers=headers).status_code == 403
    assert client.delete(f"/api/v1/users/{target.id}", headers=headers).status_code == 403


def test_cashier_cannot_reach_financial_or_admin_endpoints(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("cash", R.CASHIER, tenant_a)
    headers = login("cash")
    for path in ("/api/v1/analytics/profit-loss", "/api/v1/expenses", "/api/v1/activity-logs", "/api/v1/inventory", "/api/v1/suppliers"):
        assert client.get(path, headers=headers).status_code == 403, path


def test_kitchen_cannot_record_sales_or_view_transactions(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("cook", R.KITCHEN, tenant_a)
    headers = login("cook")
    assert client.get("/api/v1/transactions", headers=headers).status_code == 403
    assert client.post("/api/v1/transactions", headers=headers, json={"items": []}).status_code == 403
    assert client.get("/api/v1/kitchen/orders", headers=headers).status_code == 200


def test_manager_cannot_create_admin_or_super_admin(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    headers = login("mgr")
    for role in ("ADMIN", "SUPER_ADMIN"):
        resp = client.post("/api/v1/users", headers=headers, json={"username": f"x{role}", "password": "Passw0rd!x", "role": role})
        assert resp.status_code == 403


def test_manager_cannot_promote_staff_to_admin(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    cashier = make_user("cash", R.CASHIER, tenant_a)
    resp = client.put(f"/api/v1/users/{cashier.id}", headers=login("mgr"), json={"role": "ADMIN"})
    assert resp.status_code == 403


def test_created_user_is_always_placed_in_callers_tenant(client, tenants, make_user, login, db):
    tenant_a, tenant_b = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    resp = client.post(
        "/api/v1/users",
        headers=login("mgr"),
        json={"username": "newbie", "password": "Passw0rd!x", "role": "CASHIER", "tenant_id": tenant_b.id},
    )
    assert resp.status_code == 201
    assert resp.json()["tenant_id"] == tenant_a.id


def test_cross_tenant_user_access_is_hidden(client, tenants, make_user, login):
    tenant_a, tenant_b = tenants
    make_user("mgr_a", R.MANAGER, tenant_a)
    foreign = make_user("cash_b", R.CASHIER, tenant_b)
    headers = login("mgr_a")

    assert client.get(f"/api/v1/users/{foreign.id}", headers=headers).status_code == 404
    assert client.put(f"/api/v1/users/{foreign.id}", headers=headers, json={"first_name": "x"}).status_code == 404
    assert client.put(f"/api/v1/users/{foreign.id}/password", headers=headers, json={"new_password": "Hacked123!"}).status_code == 404
    assert client.put(f"/api/v1/users/{foreign.id}/status", headers=headers).status_code == 404
    assert client.delete(f"/api/v1/users/{foreign.id}", headers=headers).status_code == 404
    assert foreign.username not in {u["username"] for u in client.get("/api/v1/users?exclude_self=false", headers=headers).json()}


def test_user_cannot_change_own_role_or_status(client, tenants, make_user, login):
    tenant_a, _ = tenants
    mgr = make_user("mgr", R.MANAGER, tenant_a)
    headers = login("mgr")
    assert client.put(f"/api/v1/users/{mgr.id}", headers=headers, json={"role": "MANAGER"}).status_code == 403
    assert client.put(f"/api/v1/users/{mgr.id}/status", headers=headers).status_code == 403
    assert client.put(f"/api/v1/users/{mgr.id}/password", headers=headers, json={"new_password": "Another123!"}).status_code == 403


def test_profile_endpoint_ignores_role_and_tenant_fields(client, tenants, make_user, login, db):
    tenant_a, tenant_b = tenants
    user = make_user("cash", R.CASHIER, tenant_a)
    resp = client.put(
        "/api/v1/auth/me",
        headers=login("cash"),
        json={"first_name": "Cass", "role": "SUPER_ADMIN", "is_active": False, "tenant_id": tenant_b.id},
    )
    assert resp.status_code == 200
    db.expire_all()
    refreshed = db.get(models.User, user.id)
    assert refreshed.role == R.CASHIER and refreshed.tenant_id == tenant_a.id and refreshed.is_active
    assert refreshed.first_name == "Cass"


def test_cross_tenant_transaction_is_not_readable(client, tenants, make_user, make_product, login):
    tenant_a, tenant_b = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    make_user("cash_b", R.CASHIER, tenant_b)
    product = make_product(tenant_b, "Coffee", "50.00")
    sale = client.post("/api/v1/transactions", headers=login("cash_b"), json={"items": [{"product_id": product.id, "quantity": 1}]})
    assert sale.status_code == 201
    tx_id = sale.json()["id"]

    headers_a = login("cash_a")
    assert client.get(f"/api/v1/transactions/{tx_id}", headers=headers_a).status_code == 404
    assert client.put(f"/api/v1/transactions/{tx_id}/status", headers=headers_a, json={"status": "cancelled"}).status_code == 404
    assert client.get("/api/v1/transactions", headers=headers_a).json() == []


def test_cross_tenant_product_cannot_be_sold(client, tenants, make_user, make_product, login):
    tenant_a, tenant_b = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    foreign_product = make_product(tenant_b, "Foreign Item", "10.00")
    resp = client.post("/api/v1/transactions", headers=login("cash_a"), json={"items": [{"product_id": foreign_product.id, "quantity": 1}]})
    assert resp.status_code == 404


def test_cross_tenant_product_management_is_hidden(client, tenants, make_user, make_product, login):
    tenant_a, tenant_b = tenants
    make_user("mgr_a", R.MANAGER, tenant_a)
    foreign_product = make_product(tenant_b, "Foreign Item", "10.00")
    headers = login("mgr_a")
    assert client.get("/api/v1/products", headers=headers).json() == []
    assert client.put(f"/api/v1/products/{foreign_product.id}", headers=headers, json={"price": "1.00"}).status_code == 404
    assert client.delete(f"/api/v1/products/{foreign_product.id}", headers=headers).status_code == 404


def test_deactivated_account_session_is_rejected(client, tenants, make_user, login, db):
    tenant_a, _ = tenants
    make_user("admin_a", R.ADMIN, tenant_a)
    worker = make_user("cash", R.CASHIER, tenant_a)
    worker_headers = login("cash")
    assert client.get("/api/v1/tables", headers=worker_headers).status_code == 200

    # Deactivate through the admin API (manager/admin flow).
    assert client.put(f"/api/v1/users/{worker.id}/status", headers=login("admin_a")).status_code == 200
    assert client.get("/api/v1/tables", headers=worker_headers).status_code == 401


def test_password_reset_revokes_existing_sessions(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    worker = make_user("cash", R.CASHIER, tenant_a)
    worker_headers = login("cash")
    assert client.put(f"/api/v1/users/{worker.id}/password", headers=login("mgr"), json={"new_password": "BrandNew123!"}).status_code == 200
    assert client.get("/api/v1/tables", headers=worker_headers).status_code == 401
    # and the new password works
    assert client.post("/api/v1/auth/login", data={"username": "cash", "password": "BrandNew123!"}).status_code == 200


def test_role_change_revokes_existing_sessions(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    worker = make_user("cash", R.CASHIER, tenant_a)
    worker_headers = login("cash")
    assert client.put(f"/api/v1/users/{worker.id}", headers=login("mgr"), json={"role": "KITCHEN"}).status_code == 200
    assert client.get("/api/v1/tables", headers=worker_headers).status_code == 401


def test_self_service_password_change_revokes_session(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("cash", R.CASHIER, tenant_a)
    headers = login("cash")
    resp = client.put("/api/v1/auth/change-password", headers=headers, json={"current_password": PASSWORD, "new_password": "ChangedPw123!"})
    assert resp.status_code == 200
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401


def test_token_without_version_claim_is_rejected(client, tenants, make_user):
    from app.core.security import create_access_token
    tenant_a, _ = tenants
    user = make_user("cash", R.CASHIER, tenant_a)
    token = create_access_token({"sub": str(user.id), "username": user.username})
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_forged_token_signature_is_rejected(client, tenants, make_user):
    import jwt
    tenant_a, _ = tenants
    user = make_user("admin_a", R.ADMIN, tenant_a)
    forged = jwt.encode({"sub": str(user.id), "token_version": 0}, "not-the-real-secret", algorithm="HS256")
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401


def test_customer_registration_cannot_pick_unknown_tenant_or_escalate(client, tenants, db):
    tenant_a, _ = tenants
    bad = client.post("/api/v1/auth/register", json={"username": "newcust", "password": "Passw0rd!x", "tenant_id": 9999})
    assert bad.status_code == 400
    ok = client.post("/api/v1/auth/register", json={"username": "newcust", "password": "Passw0rd!x", "tenant_id": tenant_a.id, "role": "ADMIN"})
    assert ok.status_code == 201
    created = db.query(models.User).filter_by(username="newcust").one()
    assert created.role == R.CUSTOMER


def test_registration_requires_branch_when_ambiguous(client, tenants):
    resp = client.post("/api/v1/auth/register", json={"username": "newcust", "password": "Passw0rd!x"})
    assert resp.status_code == 400


def test_registration_rejects_case_insensitive_duplicates_and_short_passwords(client, tenants):
    tenant_a, _ = tenants
    payload = {"username": "Dupe", "password": "Passw0rd!x", "email": "Dupe@Example.com", "tenant_id": tenant_a.id}
    assert client.post("/api/v1/auth/register", json=payload).status_code == 201
    assert client.post("/api/v1/auth/register", json={**payload, "username": "dupe"}).status_code == 400
    assert client.post("/api/v1/auth/register", json={**payload, "username": "other", "email": "dupe@example.com"}).status_code == 400
    assert client.post("/api/v1/auth/register", json={**payload, "username": "short", "email": None, "password": "abc12"}).status_code == 422


def test_super_admin_without_tenant_selection_is_rejected_when_ambiguous(client, tenants, make_user, login):
    tenant_a, tenant_b = tenants
    make_user("root", R.SUPER_ADMIN, None)
    headers = login("root")
    assert client.get("/api/v1/tables", headers=headers).status_code == 400  # two tenants: selection required
    assert client.get("/api/v1/tables", headers={**headers, "X-Tenant-ID": str(tenant_a.id)}).status_code == 200
    assert client.get("/api/v1/tables", headers={**headers, "X-Tenant-ID": "99999"}).status_code == 404
    resp = client.get("/api/v1/products", headers=headers)  # read-only listing spans tenants by design
    assert resp.status_code == 200
    resp = client.post("/api/v1/categories", headers=headers, json={"name": "Drinks"})
    assert resp.status_code == 400  # no silent "first tenant"
    ok = client.post("/api/v1/categories", headers={**headers, "X-Tenant-ID": str(tenant_b.id)}, json={"name": "Drinks"})
    assert ok.status_code in (200, 201), ok.text
    assert ok.json()["tenant_id"] == tenant_b.id


def test_activity_log_actor_cannot_be_forged(client, tenants, make_user, login, db):
    tenant_a, _ = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    resp = client.post(
        "/api/v1/activity-logs",
        headers=login("mgr"),
        json={"action": "Custom", "performed_by": "admin", "role": "SUPER_ADMIN", "details": "forged"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["performed_by"] == "mgr" and body["role"] == "MANAGER"


def test_activity_logs_are_tenant_scoped_and_not_clearable_by_admin(client, tenants, make_user, login, db):
    tenant_a, tenant_b = tenants
    make_user("admin_a", R.ADMIN, tenant_a)
    db.add(models.ActivityLog(tenant_id=tenant_b.id, action="Secret", performed_by="other", role="ADMIN"))
    db.add(models.ActivityLog(tenant_id=tenant_a.id, action="Mine", performed_by="me", role="ADMIN"))
    db.commit()
    headers = login("admin_a")
    actions = {entry["action"] for entry in client.get("/api/v1/activity-logs", headers=headers).json()}
    assert "Secret" not in actions and "Mine" in actions
    assert client.delete("/api/v1/activity-logs", headers=headers).status_code == 403


def test_login_error_does_not_reveal_whether_account_exists(client, tenants, make_user):
    tenant_a, _ = tenants
    make_user("real", R.CASHIER, tenant_a)
    wrong_pw = client.post("/api/v1/auth/login", data={"username": "real", "password": "nope-nope"})
    unknown = client.post("/api/v1/auth/login", data={"username": "ghost", "password": "nope-nope"})
    assert wrong_pw.status_code == unknown.status_code == 401
    assert wrong_pw.json() == unknown.json()


def test_login_is_case_insensitive_and_rate_limited(client, tenants, make_user, monkeypatch):
    tenant_a, _ = tenants
    make_user("MixedCase", R.CASHIER, tenant_a)
    assert client.post("/api/v1/auth/login", data={"username": "mixedcase", "password": PASSWORD}).status_code == 200

    monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
    codes = [client.post("/api/v1/auth/login", data={"username": "mixedcase", "password": "wrong-pass"}).status_code for _ in range(7)]
    assert codes[:5] == [401] * 5
    assert 429 in codes[5:]
    # The lock-out also blocks the correct password for that account from this client.
    assert client.post("/api/v1/auth/login", data={"username": "mixedcase", "password": PASSWORD}).status_code == 429
