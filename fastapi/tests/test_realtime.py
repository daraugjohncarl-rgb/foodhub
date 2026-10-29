"""P0 regression tests: WebSocket authentication, tenant isolation and secret hygiene."""
import json

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import R
from app.core.websocket import manager, _scrub


def expect_close(client, url, code, **kwargs):
    with pytest.raises(WebSocketDisconnect) as info:
        with client.websocket_connect(url, **kwargs) as ws:
            ws.receive_text()
    assert info.value.code == code


def bearer(headers):
    return {"Authorization": headers["Authorization"]}


def test_unauthenticated_connection_is_refused(client, tenants):
    tenant_a, _ = tenants
    expect_close(client, f"/api/v1/ws/{tenant_a.id}", 4401)
    expect_close(client, "/api/v1/ws", 4401)


def test_invalid_token_is_refused(client, tenants):
    tenant_a, _ = tenants
    expect_close(client, f"/api/v1/ws/{tenant_a.id}", 4401, headers={"Authorization": "Bearer not-a-token"})


def test_customer_accounts_are_refused(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("cust", R.CUSTOMER, tenant_a)
    expect_close(client, f"/api/v1/ws/{tenant_a.id}", 4403, headers=bearer(login("cust")))


def test_tenant_spoofing_is_refused(client, tenants, make_user, login):
    tenant_a, tenant_b = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    expect_close(client, f"/api/v1/ws/{tenant_b.id}", 4403, headers=bearer(login("cash_a")))


def test_cross_site_origin_is_refused(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    headers = {**bearer(login("cash_a")), "Origin": "https://evil.example"}
    expect_close(client, f"/api/v1/ws/{tenant_a.id}", 4403, headers=headers)


def test_authenticated_staff_can_connect_and_ping(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    with client.websocket_connect(f"/api/v1/ws/{tenant_a.id}", headers=bearer(login("cash_a"))) as ws:
        ws.send_text("ping")
        assert ws.receive_text() == "pong"
    # The tenant in the URL is optional: it is derived from the identity.
    with client.websocket_connect("/api/v1/ws", headers=bearer(login("cash_a"))) as ws:
        ws.send_text("ping")
        assert ws.receive_text() == "pong"


def test_revoked_session_is_disconnected_on_next_ping(client, tenants, make_user, login, db):
    tenant_a, _ = tenants
    user = make_user("cash_a", R.CASHIER, tenant_a)
    headers = bearer(login("cash_a"))
    with client.websocket_connect(f"/api/v1/ws/{tenant_a.id}", headers=headers) as ws:
        user.is_active = False
        db.commit()
        ws.send_text("ping")
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_text()
        assert info.value.code == 4401


def test_events_never_leak_across_tenants_and_never_carry_tokens(client, tenants, make_user, make_product, login):
    tenant_a, tenant_b = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    make_user("cash_b", R.CASHIER, tenant_b)
    burger = make_product(tenant_a, "Burger", "50.00")
    headers_a, headers_b = bearer(login("cash_a")), bearer(login("cash_b"))

    with client.websocket_connect(f"/api/v1/ws/{tenant_a.id}", headers=headers_a) as ws_a, \
            client.websocket_connect(f"/api/v1/ws/{tenant_b.id}", headers=headers_b) as ws_b:
        created = client.post("/api/v1/customer-orders", json={
            "tenant_id": tenant_a.id, "customer_name": "Maria", "items": [{"product_id": burger.id, "quantity": 1}],
        })
        assert created.status_code == 201

        first = json.loads(ws_a.receive_text())
        second = json.loads(ws_a.receive_text())
        events = {first["event"], second["event"]}
        assert events == {"CUSTOMER_ORDER_CREATED", "ORDER_CREATED"}
        for message in (first, second):
            assert message["tenant_id"] == tenant_a.id
            assert created.json()["tracking_token"] not in json.dumps(message)
            assert "tracking_token" not in json.dumps(message)

        # Tenant B's socket received nothing: its next frame is the reply to its own ping.
        ws_b.send_text("ping")
        assert ws_b.receive_text() == "pong"


def test_broadcast_scrubs_sensitive_keys():
    scrubbed = _scrub({"a": 1, "tracking_token": "t", "nested": {"access_token": "x", "ok": [{"password": "p", "v": 2}]}})
    assert scrubbed == {"a": 1, "nested": {"ok": [{"v": 2}]}}


def test_websocket_route_is_registered_once(client, tenants):
    """Only the /api/v1 endpoints exist; the former duplicate un-prefixed routes are gone."""
    tenant_a, _ = tenants
    for path in ("/ws", f"/ws/{tenant_a.id}"):
        with pytest.raises(Exception):
            with client.websocket_connect(path):
                pass
    # the prefixed route still answers (and refuses anonymous clients with the auth close code)
    expect_close(client, f"/api/v1/ws/{tenant_a.id}", 4401)


def test_per_user_connection_cap(client, tenants, make_user, login, monkeypatch):
    tenant_a, _ = tenants
    make_user("cash_a", R.CASHIER, tenant_a)
    headers = bearer(login("cash_a"))
    monkeypatch.setattr("app.core.websocket.MAX_CONNECTIONS_PER_USER", 1)
    with client.websocket_connect(f"/api/v1/ws/{tenant_a.id}", headers=headers):
        expect_close(client, f"/api/v1/ws/{tenant_a.id}", 4429, headers=headers)
    assert manager.active_connections.get(tenant_a.id) in (None, [])
