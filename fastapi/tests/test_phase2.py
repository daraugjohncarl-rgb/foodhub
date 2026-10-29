"""Phase 2 regression tests: cookie-only sessions, CSRF, product cost confidentiality, limits, tenant integrity."""
import os
import shutil
import subprocess

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import R, PASSWORD
import app.models as models
from app.core.websocket import manager

FASTAPI_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_DIR = os.path.join(FASTAPI_DIR, "tests", "js")


# ------------------------------------------------------------------ sessions: cookie only
def test_cookie_alone_authenticates_without_authorization_header(client, tenants, make_user):
    tenant_a, _ = tenants
    make_user("cash", R.CASHIER, tenant_a)
    resp = client.post("/api/v1/auth/login", data={"username": "cash", "password": PASSWORD})
    assert resp.status_code == 200
    assert client.cookies.get("session_token")
    assert client.get("/api/v1/auth/me").status_code == 200   # cookie only


def test_logout_revokes_the_cookie_session(client, tenants, make_user):
    tenant_a, _ = tenants
    make_user("cash", R.CASHIER, tenant_a)
    client.post("/api/v1/auth/login", data={"username": "cash", "password": PASSWORD})
    stale = client.cookies.get("session_token")
    assert client.post("/api/v1/auth/logout").status_code == 200
    client.cookies.set("session_token", stale)       # replaying the old cookie must fail
    assert client.get("/api/v1/auth/me").status_code == 401


def test_customer_registration_sets_httponly_session_cookie(client, tenants):
    tenant_a, _ = tenants
    resp = client.post("/api/v1/auth/register", json={"username": "newcust", "password": "Passw0rd!x", "tenant_id": tenant_a.id})
    assert resp.status_code == 201
    header = resp.headers["set-cookie"].lower()
    assert "session_token=" in header and "httponly" in header and "samesite=lax" in header
    assert client.get("/api/v1/auth/me").status_code == 200


def test_frontend_never_stores_the_jwt():
    static = os.path.join(FASTAPI_DIR, "static")
    offenders = []
    for sub in ("js", os.path.join("assets", "js")):
        for name in os.listdir(os.path.join(static, sub)):
            if not name.endswith(".js"):
                continue
            with open(os.path.join(static, sub, name), encoding="utf-8") as handle:
                text = handle.read()
            for line in text.splitlines():
                if ("setItem" in line and "access_token" in line) or "getToken" in line or "Authorization" in line:
                    offenders.append(f"{sub}/{name}: {line.strip()[:80]}")
    assert offenders == []


def test_cookie_authenticated_writes_need_a_same_site_origin(client, tenants, make_user):
    tenant_a, _ = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    client.post("/api/v1/auth/login", data={"username": "mgr", "password": PASSWORD})
    body = {"table_number": "T-1"}
    for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Origin": "", "Referer": "https://evil.example/page"}, {"Origin": ""}):
        blocked = client.post("/api/v1/tables", json=body, headers=headers)
        assert blocked.status_code == 403, headers
    ok = client.post("/api/v1/tables", json=body, headers={"Origin": "http://testserver"})
    assert ok.status_code == 201


def test_bearer_clients_are_not_subject_to_the_cookie_csrf_check(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    headers = {**login("mgr"), "Origin": ""}
    client.cookies.clear()
    assert client.post("/api/v1/tables", json={"table_number": "T-2"}, headers=headers).status_code == 201


# ------------------------------------------------------------------ product cost confidentiality
@pytest.mark.parametrize("role,sees_cost", [
    (R.CASHIER, False), (R.KITCHEN, False), (R.INVENTORY, False),
    (R.MANAGER, True), (R.ADMIN, True),
])
def test_product_cost_only_for_management_roles(client, tenants, make_user, make_product, login, db, role, sees_cost):
    tenant_a, _ = tenants
    product = make_product(tenant_a, "Burger", "50.00")
    product.cost = "21.50"
    db.commit()
    make_user("worker", role, tenant_a)
    resp = client.get("/api/v1/products", headers=login("worker"))
    assert resp.status_code == 200
    row = resp.json()[0]
    assert ("cost" in row) is sees_cost
    assert sees_cost or "21.5" not in resp.text
    assert row["price"] is not None


def test_cost_is_not_exposed_by_other_cashier_reachable_endpoints(client, tenants, make_user, make_product, login, db):
    tenant_a, _ = tenants
    product = make_product(tenant_a, "Burger", "50.00")
    product.cost = "21.50"
    db.commit()
    make_user("cash", R.CASHIER, tenant_a)
    headers = login("cash")
    sale = client.post("/api/v1/transactions", headers=headers, json={"items": [{"product_id": product.id, "quantity": 1}]})
    texts = [
        sale.text,
        client.get("/api/v1/transactions", headers=headers).text,
        client.get("/api/v1/categories", headers=headers).text,
        client.get("/api/v1/kitchen/orders?type=all", headers=headers).text,
        client.get(f"/api/v1/customer-orders/menu?tenant_id={tenant_a.id}").text,
        client.get("/api/v1/products", headers=headers).text,
    ]
    for text in texts:
        assert "21.5" not in text and '"cost"' not in text


# ------------------------------------------------------------------ rate limiting / client IP
def test_x_forwarded_for_cannot_be_used_to_dodge_limits_by_default(client, tenants, make_user, monkeypatch):
    tenant_a, _ = tenants
    make_user("cash", R.CASHIER, tenant_a)
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
    monkeypatch.delenv("TRUSTED_PROXY_COUNT", raising=False)
    codes = [client.post("/api/v1/auth/login", data={"username": "cash", "password": "wrong-pw1"}, headers={"X-Forwarded-For": f"10.0.0.{i}"}).status_code for i in range(7)]
    assert 429 in codes   # the spoofed header is ignored: every attempt counts against the real peer


def test_trusted_proxy_count_uses_the_rightmost_hop(monkeypatch):
    from starlette.requests import Request
    from app.core.rate_limit import client_ip

    def req(xff):
        return Request({"type": "http", "headers": [(b"x-forwarded-for", xff.encode())], "client": ("9.9.9.9", 1)})

    monkeypatch.delenv("TRUSTED_PROXY_COUNT", raising=False)
    assert client_ip(req("1.1.1.1, 2.2.2.2")) == "9.9.9.9"
    monkeypatch.setenv("TRUSTED_PROXY_COUNT", "1")
    assert client_ip(req("6.6.6.6, 2.2.2.2")) == "2.2.2.2"       # a client-forged left entry is ignored
    monkeypatch.setenv("TRUSTED_PROXY_COUNT", "3")
    assert client_ip(req("2.2.2.2")) == "9.9.9.9"                 # fewer hops than expected: fall back to the peer


def test_change_password_guessing_is_throttled(client, tenants, make_user, login, monkeypatch):
    tenant_a, _ = tenants
    make_user("cash", R.CASHIER, tenant_a)
    headers = login("cash")
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
    codes = [client.put("/api/v1/auth/change-password", headers=headers, json={"current_password": "guess-guess", "new_password": "NewPassw0rd!"}).status_code for _ in range(7)]
    assert codes[:5] == [400] * 5 and codes[5] == 429


# ------------------------------------------------------------------ websocket lifecycle
def bearer(h):
    return {"Authorization": h["Authorization"]}


def test_websocket_registry_is_cleaned_after_disconnect(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("cash", R.CASHIER, tenant_a)
    headers = bearer(login("cash"))
    for _ in range(3):
        with client.websocket_connect(f"/api/v1/ws/{tenant_a.id}", headers=headers) as ws:
            ws.send_text("ping")
            assert ws.receive_text() == "pong"
    assert manager.active_connections.get(tenant_a.id) in (None, [])
    assert not manager._owners


def test_rejected_handshakes_do_not_consume_capacity(client, tenants, make_user, login):
    tenant_a, tenant_b = tenants
    make_user("cash", R.CASHIER, tenant_a)
    headers = bearer(login("cash"))
    for _ in range(10):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/api/v1/ws/{tenant_b.id}", headers=headers) as ws:
                ws.receive_text()
    assert not manager._owners and not manager.active_connections


def test_per_tenant_connection_cap_and_idle_timeout(client, tenants, make_user, login, monkeypatch):
    tenant_a, _ = tenants
    make_user("cash1", R.CASHIER, tenant_a)
    make_user("cash2", R.CASHIER, tenant_a)
    h1, h2 = bearer(login("cash1")), bearer(login("cash2"))
    monkeypatch.setattr("app.core.websocket.MAX_CONNECTIONS_PER_TENANT", 1)
    with client.websocket_connect(f"/api/v1/ws/{tenant_a.id}", headers=h1):
        with pytest.raises(WebSocketDisconnect) as info:
            with client.websocket_connect(f"/api/v1/ws/{tenant_a.id}", headers=h2) as ws:
                ws.receive_text()
        assert info.value.code == 4429
    monkeypatch.setattr("app.routers.realtime.IDLE_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr("app.core.websocket.MAX_CONNECTIONS_PER_TENANT", 100)
    with client.websocket_connect(f"/api/v1/ws/{tenant_a.id}", headers=h1) as ws:
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()   # the server drops an idle client
    assert not manager._owners


# ------------------------------------------------------------------ tenant integrity
def test_cross_tenant_references_are_rejected_everywhere(client, tenants, make_user, make_product, login, db):
    tenant_a, tenant_b = tenants
    make_user("mgr_a", R.MANAGER, tenant_a)
    make_user("cash_a", R.CASHIER, tenant_a)
    foreign_product = make_product(tenant_b, "Foreign", "9.00")
    foreign_category = models.Category(tenant_id=tenant_b.id, name="Foreign cat")
    db.add(foreign_category)
    db.commit()
    mgr = login("mgr_a")
    resp = client.post("/api/v1/products", headers=mgr, json={"name": "Mine", "sku": "M1", "price": "5.00", "cost": "1.00", "category_id": foreign_category.id})
    assert resp.status_code in (400, 404, 422)
    assert db.query(models.Product).filter_by(sku="M1").count() == 0
    assert client.post("/api/v1/transactions", headers=login("cash_a"), json={"items": [{"product_id": foreign_product.id, "quantity": 1}]}).status_code == 404
    order = client.post("/api/v1/customer-orders", json={"tenant_id": tenant_a.id, "items": [{"product_id": foreign_product.id, "quantity": 1}]})
    assert order.status_code == 400


def test_tenant_scoped_idempotency_key(client, tenants, make_user, make_product, login):
    tenant_a, tenant_b = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    make_user("cash_b", R.CASHIER, tenant_b)
    pa, pb = make_product(tenant_a, "A", "1.00"), make_product(tenant_b, "B", "1.00")
    key = "22222222-2222-2222-2222-222222222222"
    a = client.post("/api/v1/transactions", headers=login("cash_a"), json={"items": [{"product_id": pa.id, "quantity": 1}], "client_tx_id": key})
    b = client.post("/api/v1/transactions", headers=login("cash_b"), json={"items": [{"product_id": pb.id, "quantity": 1}], "client_tx_id": key})
    assert a.status_code == 201 and b.status_code == 201 and a.json()["id"] != b.json()["id"]


def test_uniqueness_is_tenant_scoped_for_catalog_names(client, tenants, make_user, login):
    tenant_a, tenant_b = tenants
    make_user("mgr_a", R.MANAGER, tenant_a)
    make_user("mgr_b", R.MANAGER, tenant_b)
    body = {"name": "House Burger", "sku": "HB-1", "price": "10.00", "cost": "4.00"}
    assert client.post("/api/v1/products", headers=login("mgr_a"), json=body).status_code in (200, 201)
    assert client.post("/api/v1/products", headers=login("mgr_b"), json=body).status_code in (200, 201)   # same sku, other tenant
    assert client.post("/api/v1/products", headers=login("mgr_a"), json=body).status_code in (400, 409, 422)  # same tenant


# ------------------------------------------------------------------ front-end DOM tests (jsdom)
@pytest.mark.skipif(shutil.which("node") is None or not os.path.isdir(os.path.join(JS_DIR, "node_modules")),
                    reason="run `npm ci` in fastapi/tests/js to enable the jsdom XSS tests")
def test_frontend_xss_dom_tests():
    result = subprocess.run(["node", "--test", "--test-force-exit"], cwd=JS_DIR, capture_output=True, text=True, timeout=600)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-1000:]
