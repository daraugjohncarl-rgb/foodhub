"""Authentication hardening (C4, H9, M11) and the role/tenant permission matrix (C2, H8, H11)."""
from datetime import timedelta

import jwt
import pytest

import app.models as m
from app.core.security import SECRET_KEY
from app.core.timeutils import utcnow
from conftest import PASSWORD


def _token(client, username, password=PASSWORD):
    return client.post("/api/v1/auth/login", data={"username": username, "password": password})


# ── Tokens ───────────────────────────────────────────────────────────────────

def test_token_signed_with_old_fallback_secret_is_rejected(client, world):
    forged = jwt.encode({"sub": str(world.users["superadmin"].id), "ver": 0, "exp": utcnow() + timedelta(hours=1)},
                        "super_secret_fallback_key_for_pos_inbox_2026", algorithm="HS256")
    assert client.get("/api/v1/users", headers={"Authorization": f"Bearer {forged}"}).status_code == 401


def test_expired_and_garbage_tokens_are_rejected(client, world):
    expired = jwt.encode({"sub": str(world.users["admin"].id), "ver": 0, "exp": utcnow() - timedelta(minutes=1)},
                         SECRET_KEY, algorithm="HS256")
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {expired}"}).status_code == 401
    assert client.get("/api/v1/auth/me", headers={"Authorization": "Bearer not-a-jwt"}).status_code == 401
    assert client.get("/api/v1/auth/me").status_code == 401


def test_password_change_revokes_existing_tokens(client, world, login):
    old = login("cashier")
    r = client.put("/api/v1/auth/change-password", headers=old,
                   json={"current_password": PASSWORD, "new_password": "A-new-strong-pass-1"})
    assert r.status_code == 200
    assert client.get("/api/v1/auth/me", headers=old).status_code == 401
    fresh = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/api/v1/auth/me", headers=fresh).status_code == 200


def test_admin_password_reset_and_deactivation_revoke_tokens(client, world, login):
    victim = login("cashier")
    cashier_id = world.users["cashier"].id
    r = client.put(f"/api/v1/users/{cashier_id}/password", headers=login("admin"), json={"new_password": "Reset-by-admin-1"})
    assert r.status_code == 200
    assert client.get("/api/v1/auth/me", headers=victim).status_code == 401

    manager_headers = login("manager")
    assert client.put(f"/api/v1/users/{world.users['manager'].id}/status", headers=login("admin")).status_code == 200
    assert client.get("/api/v1/auth/me", headers=manager_headers).status_code == 401


def test_weak_passwords_are_rejected(client, world, login):
    r = client.put("/api/v1/auth/change-password", headers=login("cashier"),
                   json={"current_password": PASSWORD, "new_password": "123456"})
    assert r.status_code == 422
    r = client.post("/api/v1/users", headers=login("admin"), json={"username": "weak", "password": "short", "role": "CASHIER"})
    assert r.status_code == 422


# ── Login throttling ─────────────────────────────────────────────────────────

def test_account_locks_after_repeated_failures(client, world, db):
    for _ in range(5):
        assert _token(client, "manager", "wrong-password").status_code == 401
    r = _token(client, "manager")          # correct password, but locked
    assert r.status_code == 429
    db.expire_all()
    user = db.query(m.User).filter_by(username="manager").one()
    assert user.locked_until is not None
    user.locked_until = utcnow() - timedelta(seconds=1)   # cooldown elapsed
    db.commit()
    assert _token(client, "manager").status_code == 200


def test_ip_throttle_after_many_failures(client, world):
    statuses = [_token(client, f"nobody{i}", "x").status_code for i in range(25)]
    assert statuses[:20] == [401] * 20
    assert 429 in statuses[20:]


def test_login_is_case_insensitive_and_usernames_normalized(client, world, login):
    assert _token(client, "ADMIN").status_code == 200
    r = client.post("/api/v1/users", headers=login("admin"),
                    json={"username": "Admin", "password": "Long-enough-pass-1", "role": "CASHIER"})
    assert r.status_code == 201
    assert r.json()["username"] == "admin1"   # 'admin' is taken case-insensitively


def test_new_accounts_must_change_password(client, world, login):
    r = client.post("/api/v1/users", headers=login("admin"),
                    json={"username": "newbie", "password": "Initial-pass-123", "role": "CASHIER"})
    assert r.status_code == 201
    t = _token(client, "newbie", "Initial-pass-123")
    assert t.status_code == 200 and t.json()["must_change_password"] is True
    headers = {"Authorization": f"Bearer {t.json()['access_token']}"}
    blocked = client.get("/api/v1/products", headers=headers)
    assert blocked.status_code == 403 and blocked.headers.get("x-password-change-required") == "1"
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 200
    r = client.put("/api/v1/auth/change-password", headers=headers,
                   json={"current_password": "Initial-pass-123", "new_password": "My-own-pass-456"})
    assert r.status_code == 200
    assert client.get("/api/v1/products", headers={"Authorization": f"Bearer {r.json()['access_token']}"}).status_code == 200


def test_profile_username_change_requires_current_password(client, world, login):
    h = login("cashier")
    assert client.put("/api/v1/auth/me", headers=h, json={"username": "renamed"}).status_code == 403
    r = client.put("/api/v1/auth/me", headers=h, json={"username": "renamed", "current_password": PASSWORD})
    assert r.status_code == 200 and r.json()["username"] == "renamed"
    assert client.put("/api/v1/auth/me", headers=h, json={"first_name": "Ana"}).status_code == 200


# ── C2: user management ─────────────────────────────────────────────────────

@pytest.mark.parametrize("role", ["cashier", "kitchen", "inventory"])
def test_operational_staff_cannot_manage_users(client, world, login, role):
    h = login(role)
    target = world.users["manager"].id
    assert client.get("/api/v1/users", headers=h).status_code == 403
    assert client.get("/api/v1/users/stats", headers=h).status_code == 403
    assert client.post("/api/v1/users", headers=h, json={"username": "x1", "password": "Long-enough-1", "role": "MANAGER"}).status_code == 403
    assert client.put(f"/api/v1/users/{target}/password", headers=h, json={"new_password": "Hacked-pass-1"}).status_code == 403
    assert client.put(f"/api/v1/users/{target}/status", headers=h).status_code == 403
    assert client.delete(f"/api/v1/users/{target}", headers=h).status_code == 403


def test_manager_has_read_only_user_access(client, world, login):
    h = login("manager")
    r = client.get("/api/v1/users", headers=h)
    assert r.status_code == 200
    assert {u["username"] for u in r.json()} == {"cashier", "inventory", "kitchen"}
    assert client.post("/api/v1/users", headers=h, json={"username": "x2", "password": "Long-enough-1", "role": "CASHIER"}).status_code == 403


def test_branch_admin_cannot_escalate_or_cross_tenant(client, world, login):
    h = login("admin")
    assert client.post("/api/v1/users", headers=h, json={"username": "boss", "password": "Long-enough-1", "role": "ADMIN"}).status_code == 403
    assert client.put(f"/api/v1/users/{world.users['cashier'].id}", headers=h, json={"role": "SUPER_ADMIN"}).status_code == 403
    other = world.users["cashier2"].id
    assert client.get(f"/api/v1/users/{other}", headers=h).status_code == 404
    assert client.put(f"/api/v1/users/{other}/password", headers=h, json={"new_password": "Long-enough-1"}).status_code == 404


def test_user_create_validation(client, world, login):
    h = login("admin")
    r = client.post("/api/v1/users", headers=h, json={"password": "Long-enough-1", "role": "CASHIER"})
    assert r.status_code == 201 and r.json()["username"].startswith("user_")          # H5: no more 500
    assert client.post("/api/v1/users", headers=h, json={"email": "not-an-email", "password": "Long-enough-1"}).status_code == 422
    r = client.post("/api/v1/users", headers=login("superadmin"),
                    json={"username": "ghost", "password": "Long-enough-1", "role": "CASHIER", "tenant_id": 999999})
    assert r.status_code == 422
    assert client.put(f"/api/v1/users/{world.users['cashier'].id}", headers=h, json={"username": None}).status_code == 422


# ── H8: audit log ─────────────────────────────────────────────────────────────

def test_audit_log_access_and_tenant_attribution(client, world, login):
    client.post("/api/v1/users", headers=login("admin"), json={"username": "audited", "password": "Long-enough-1", "role": "CASHIER"})
    login("cashier")
    assert client.get("/api/v1/activity-logs", headers=login("cashier")).status_code == 403
    assert client.get("/api/v1/activity-logs", headers=login("kitchen")).status_code == 403
    r = client.get("/api/v1/activity-logs?limit=200", headers=login("admin"))
    assert r.status_code == 200
    actions = {e["action"] for e in r.json()}
    assert {"Login", "User Created"} <= actions
    assert all(e["tenant_id"] == world.t1.id for e in r.json())
    r2 = client.get("/api/v1/activity-logs?limit=200", headers=login("admin2"))
    assert all(e["tenant_id"] == world.t2.id for e in r2.json())


def test_audit_log_cannot_be_forged_or_wiped(client, world, login, db):
    forged = client.post("/api/v1/activity-logs", headers=login("cashier"),
                         json={"action": "Fake", "performed_by": "superadmin", "role": "SUPER_ADMIN"})
    assert forged.status_code == 405
    assert client.delete("/api/v1/activity-logs?older_than_days=365", headers=login("admin")).status_code == 403
    assert client.delete("/api/v1/activity-logs?older_than_days=1", headers=login("superadmin")).status_code == 422
    old = m.ActivityLog(tenant_id=world.t1.id, action="Old", performed_by="x", created_at=utcnow() - timedelta(days=400))
    db.add(old)
    db.commit()
    r = client.delete("/api/v1/activity-logs?older_than_days=365", headers=login("superadmin"))
    assert r.status_code == 200 and r.json()["deleted"] == 1
    assert db.query(m.ActivityLog).filter_by(action="Audit Log Purge").count() == 1


# ── H11: permission matrix ───────────────────────────────────────────────────

MATRIX = [
    # (method, path, roles allowed (2xx/4xx-but-not-403), roles forbidden)
    ("GET", "/api/v1/analytics/dashboard", {"admin", "manager", "superadmin"}, {"cashier", "kitchen", "inventory"}),
    ("GET", "/api/v1/transactions", {"admin", "manager", "cashier", "superadmin"}, {"kitchen", "inventory"}),
    ("GET", "/api/v1/kitchen/orders", {"admin", "manager", "cashier", "kitchen", "superadmin"}, {"inventory"}),
    ("GET", "/api/v1/customer-orders/pending", {"admin", "manager", "cashier", "superadmin"}, {"kitchen", "inventory"}),
    ("GET", "/api/v1/customer-orders/history", {"admin", "manager", "cashier", "superadmin"}, {"kitchen", "inventory"}),
    ("GET", "/api/v1/inventory", {"admin", "manager", "inventory", "kitchen", "superadmin"}, {"cashier"}),
    ("GET", "/api/v1/suppliers", {"admin", "manager", "inventory", "superadmin"}, {"cashier", "kitchen"}),
    ("GET", "/api/v1/purchase-orders", {"admin", "manager", "inventory", "superadmin"}, {"cashier", "kitchen"}),
    ("GET", "/api/v1/tables", {"admin", "manager", "cashier", "superadmin"}, {"kitchen", "inventory"}),
    ("GET", "/api/v1/products", {"admin", "manager", "cashier", "kitchen", "inventory", "superadmin"}, set()),
    ("GET", "/api/v1/activity-logs", {"admin", "manager", "superadmin"}, {"cashier", "kitchen", "inventory"}),
    ("GET", "/api/v1/super-admin/reports", {"superadmin"}, {"admin", "manager", "cashier"}),
]


@pytest.mark.parametrize("method,path,allowed,forbidden", MATRIX)
def test_permission_matrix(client, world, login, method, path, allowed, forbidden):
    assert client.request(method, path).status_code == 401
    for role in allowed:
        assert client.request(method, path, headers=login(role)).status_code != 403, (role, path)
    for role in forbidden:
        assert client.request(method, path, headers=login(role)).status_code == 403, (role, path)


def test_branch_user_cannot_request_another_tenant(client, world, login):
    r = client.get(f"/api/v1/products?tenant_id={world.t2.id}", headers=login("cashier"))
    assert r.status_code == 403
    r = client.get(f"/api/v1/products?tenant_id={world.t2.id}", headers=login("superadmin"))
    assert r.status_code == 200 and [p["name"] for p in r.json()] == ["Branch Two Secret"]
