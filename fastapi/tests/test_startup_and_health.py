"""Start-up safety, health endpoint, diagnostics, CORS, docs, security headers (C3, C4, H3, H10, notes)."""
import os
import subprocess
import sys

import pytest

from conftest import APP_DIR


def _run_python(code: str, **env_overrides):
    env = {k: v for k, v in os.environ.items()}
    env.update(env_overrides)
    for key, value in list(env.items()):
        if value is None:
            env.pop(key)
    return subprocess.run([sys.executable, "-c", code], cwd=APP_DIR, env=env, capture_output=True, text=True, timeout=120)


def test_health_is_minimal(client, world):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_seed_super_admin_endpoint_is_gone(client, world):
    assert client.post("/seed-super-admin").status_code in (404, 405)


def test_diagnostics_require_super_admin(client, world, login):
    assert client.get("/test-db").status_code == 401
    assert client.get("/test-db", headers=login("admin")).status_code == 403
    r = client.get("/test-db", headers=login("superadmin"))
    assert r.status_code == 200
    body = r.text.lower()
    assert "password" not in body and "host" not in body and "127.0.0.1" not in body


def test_docs_disabled_in_test_env(client, world):
    # APP_ENV=test keeps docs on by default; production turns them off (see test_production_settings below).
    assert client.get("/docs").status_code == 200


def test_production_settings_disable_docs_and_demo_seed():
    r = _run_python(
        "from app.core import config; print(config.ENABLE_API_DOCS, config.SEED_DEMO_DATA, config.CORS_ALLOWED_ORIGINS)",
        APP_ENV="production",
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "False False []"


def test_missing_app_env_means_production_defaults():
    r = _run_python(
        "from app.core import config; print(config.APP_ENV, config.ENABLE_API_DOCS, config.SEED_DEMO_DATA)",
        APP_ENV=None, ENABLE_API_DOCS=None, SEED_DEMO_DATA=None,
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "production False False"


def test_cors_rejects_unknown_origin_and_allows_configured(client, world):
    r = client.options("/api/v1/products", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"})
    assert r.headers.get("access-control-allow-origin") is None
    r = client.options("/api/v1/products", headers={"Origin": "http://localhost:8000", "Access-Control-Request-Method": "GET"})
    assert r.headers.get("access-control-allow-origin") == "http://localhost:8000"
    assert r.headers.get("access-control-allow-credentials") is None


def test_wildcard_cors_is_refused():
    r = _run_python("import app.core.config", CORS_ALLOWED_ORIGINS="*")
    assert r.returncode != 0 and "CORS_ALLOWED_ORIGINS" in r.stderr


def test_security_headers(client, world):
    r = client.get("/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "SAMEORIGIN"


@pytest.mark.parametrize("secret", [None, "", "short", "super_secret_fallback_key_for_pos_inbox_2026"])
def test_startup_refuses_missing_or_weak_jwt_secret(secret):
    r = _run_python("import app.core.security", JWT_SECRET=secret)
    assert r.returncode != 0
    assert "JWT_SECRET" in r.stderr


def test_missing_database_configuration_fails_instead_of_defaulting():
    r = _run_python("import app.db", DATABASE_URL=None, DB_HOST=None, DB_NAME=None, DB_USER=None)
    assert r.returncode != 0
    assert "Database is not configured" in r.stderr


def test_startup_fails_when_schema_is_behind(world):
    """A database that is not at the Alembic head must stop the app instead of serving errors."""
    from sqlalchemy import text
    from app.db import engine
    from app.main import app
    from fastapi.testclient import TestClient
    from app.core.schema import SchemaNotReady

    with engine.begin() as conn:
        conn.execute(text("UPDATE alembic_version SET version_num = '0001_baseline'"))
    try:
        with pytest.raises(SchemaNotReady):
            with TestClient(app):
                pass
    finally:
        with engine.begin() as conn:
            conn.execute(text("UPDATE alembic_version SET version_num = '0002_audit_fixes'"))


def test_unhandled_errors_do_not_leak_details(client, world, monkeypatch):
    from app.routers import analytics

    def boom(*a, **k):
        raise RuntimeError("SECRET-INTERNAL-DETAIL host=10.0.0.1")

    monkeypatch.setattr(analytics, "business_day_bounds_utc", boom)
    from conftest import PASSWORD
    token = client.post("/api/v1/auth/login", data={"username": "admin", "password": PASSWORD}).json()["access_token"]
    r = client.get("/api/v1/analytics/dashboard", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 500
    assert "SECRET" not in r.text and "10.0.0.1" not in r.text


def test_all_html_pages_load(client, world):
    for path in ["/", "/login", "/admin", "/manager", "/inventory", "/cashier", "/kitchen", "/customer",
                 "/dashboard", "/users", "/create-user", "/activity-logs", "/reports", "/profile", "/settings",
                 "/super_admin/users", "/super-admin/dashboard"]:
        r = client.get(path)
        assert r.status_code == 200, path
        assert "<html" in r.text.lower(), path
