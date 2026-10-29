"""Deployment hardening: secrets, startup behaviour, diagnostics, headers and error handling."""
import os
import subprocess
import sys

import pytest

from conftest import R

FASTAPI_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_python(code, **env):
    """Run code in a clean interpreter with a controlled environment (never inherits real secrets)."""
    clean = {k: v for k, v in os.environ.items() if k not in (
        "DATABASE_URL", "JWT_SECRET", "APP_ENV", "DB_ENGINE", "DB_HOST", "DB_PASSWORD", "ALLOWED_ORIGINS",
        "ENABLE_API_DOCS", "SEED_DEMO_DATA", "DB_AUTO_CREATE_TABLES")}
    clean.update(env)  # empty strings are deliberate: they stop python-dotenv from filling in values from a local .env
    prelude = "import sys; sys.path.insert(0, %r)" % FASTAPI_DIR + chr(10)
    return subprocess.run([sys.executable, "-c", prelude + code], cwd=FASTAPI_DIR, env=clean,
                          capture_output=True, text=True, timeout=120)


def test_production_refuses_missing_or_weak_jwt_secret():
    for secret in (None, "short"):
        env = {"APP_ENV": "production", "DATABASE_URL": "sqlite:///unused.db", "JWT_SECRET": secret or ""}
        result = run_python("import app.core.security", **env)
        assert result.returncode != 0 and "JWT_SECRET" in result.stderr


def test_production_accepts_a_strong_secret_and_uses_it():
    result = run_python("import app.core.security as s; print(len(s.SECRET_KEY))", APP_ENV="production", JWT_SECRET="s" * 40, DATABASE_URL="sqlite:///unused.db")
    assert result.returncode == 0 and result.stdout.strip() == "40"


def test_development_never_uses_a_hardcoded_secret():
    code = "import app.core.security as a; print(a.SECRET_KEY)"
    one = run_python(code, DATABASE_URL="sqlite:///unused.db", JWT_SECRET="").stdout.strip()
    two = run_python(code, DATABASE_URL="sqlite:///unused.db", JWT_SECRET="").stdout.strip()
    assert one and two and one != two and "super_secret_fallback" not in one


def test_production_requires_explicit_database_url():
    result = run_python("import app.db", APP_ENV="production", JWT_SECRET="s" * 40, DATABASE_URL="")
    assert result.returncode != 0 and "DATABASE_URL" in result.stderr


def test_wildcard_cors_origin_is_refused():
    result = run_python("import app.main", DATABASE_URL="sqlite:///unused.db", JWT_SECRET="s" * 40, ALLOWED_ORIGINS="*")
    assert result.returncode != 0 and "ALLOWED_ORIGINS" in result.stderr


def test_startup_fails_clearly_when_database_is_unreachable(tmp_path):
    missing = (tmp_path / "does-not-exist" / "db.sqlite3").as_posix()
    code = "from fastapi.testclient import TestClient\nimport app.main as m\nwith TestClient(m.app): pass"
    result = run_python(code, DATABASE_URL=f"sqlite:///{missing}", JWT_SECRET="s" * 40, DB_AUTO_CREATE_TABLES="false")
    assert result.returncode != 0 and "Database connection failed" in result.stderr


def test_production_disables_api_docs_and_demo_seeding():
    code = (
        "import app.main as m\n"
        "print(m.app.docs_url, m.app.openapi_url, m.SEED_DEMO_DATA, m.AUTO_CREATE_TABLES)"
    )
    result = run_python(code, APP_ENV="production", JWT_SECRET="s" * 40, DATABASE_URL="sqlite:///unused.db", SEED_DEMO_DATA="true")
    assert result.stdout.split() == ["None", "None", "False", "False"], result.stderr


def test_removed_diagnostic_and_seeding_endpoints(client):
    assert client.get("/test-db").status_code == 404
    assert client.post("/seed-super-admin").status_code in (404, 405)
    assert client.get("/api/v1/seed-super-admin").status_code == 404


def test_health_endpoints_disclose_nothing(client):
    live = client.get("/healthz")
    ready = client.get("/readyz")
    assert live.status_code == 200 and live.json() == {"status": "ok"}
    assert ready.status_code == 200 and ready.json() == {"status": "ok"}


def test_readiness_reports_unavailable_without_internals(client, monkeypatch):
    from app.db import get_db
    from app.main import app

    class BrokenSession:
        def execute(self, *a, **k):
            raise RuntimeError("connection to server at secret-host.supabase.co failed: password authentication failed")

    app.dependency_overrides[get_db] = lambda: BrokenSession()
    try:
        resp = client.get("/readyz")
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 503 and resp.json() == {"status": "unavailable"}
    assert "secret-host" not in resp.text


def test_unhandled_errors_return_generic_message_with_request_id(client):
    from app.main import app

    @app.get("/__boom", include_in_schema=False)
    def boom():
        raise RuntimeError("SELECT * FROM users -- /srv/app/secret.py")

    from fastapi.testclient import TestClient
    resp = TestClient(app, raise_server_exceptions=False).get("/__boom")
    assert resp.status_code == 500
    body = resp.json()
    assert body["detail"] == "Internal server error." and body["request_id"] == resp.headers["X-Request-ID"]
    assert "SELECT" not in resp.text and "secret.py" not in resp.text


def test_security_headers_are_present(client):
    resp = client.get("/healthz")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in resp.headers["Content-Security-Policy"]
    assert resp.headers["X-Request-ID"]


def test_protected_html_cannot_be_fetched_through_the_static_mount(client):
    for path in ("/static/pages/admin.html", "/static/admin/admin.html", "/static/super_admin/dashboard.html", "/static/cashier.html", "/static/manager.html"):
        assert client.get(path).status_code == 404, path
    assert client.get("/static/customer.html").status_code == 200
    assert client.get("/static/assets/js/utils.js").status_code == 200


def test_dashboard_pages_still_enforce_roles(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("cust", R.CUSTOMER, tenant_a)
    resp = client.get("/admin", follow_redirects=False)
    assert resp.status_code == 302 and resp.headers["location"].startswith("/login")


def test_cross_site_cookie_write_is_blocked(client, tenants, make_user, login):
    tenant_a, _ = tenants
    make_user("mgr", R.MANAGER, tenant_a)
    token = login("mgr")["Authorization"].split()[1]
    client.cookies.set("session_token", token)
    blocked = client.post("/api/v1/users", json={}, headers={"Origin": "https://evil.example"})
    assert blocked.status_code == 403 and blocked.json()["detail"] == "Cross-site request blocked."
    allowed = client.post("/api/v1/users", json={}, headers={"Origin": "http://testserver"})
    assert allowed.status_code == 422  # reached the handler (validation error), not blocked


def test_session_cookie_flags(client, tenants, make_user):
    tenant_a, _ = tenants
    make_user("cash", R.CASHIER, tenant_a)
    resp = client.post("/api/v1/auth/login", data={"username": "cash", "password": "Passw0rd!test"})
    cookie = resp.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_production_cookie_is_secure():
    code = (
        "import os\nfrom fastapi.testclient import TestClient\nimport app.main as m\n"
        "from app.db import SessionLocal, Base, engine\nimport app.models as models\n"
        "from app.core.security import get_password_hash\n"
        "from sqlalchemy import BigInteger\nfrom sqlalchemy.ext.compiler import compiles\n"
        "@compiles(BigInteger,'sqlite')\ndef _b(t,c,**k): return 'INTEGER'\n"
        "Base.metadata.create_all(engine)\n"
        "db=SessionLocal(); t=models.Tenant(name='t',subdomain_or_code='t'); db.add(t); db.commit()\n"
        "db.add(models.User(username='u',password_hash=get_password_hash('Passw0rd!test'),role=models.UserRole.CASHIER,tenant_id=t.id)); db.commit()\n"
        "with TestClient(m.app, base_url='https://testserver') as c:\n"
        "    r=c.post('/api/v1/auth/login',data={'username':'u','password':'Passw0rd!test'})\n"
        "    print('SECURE' if 'secure' in r.headers['set-cookie'].lower() else 'INSECURE')\n"
        "    print('HSTS' if 'strict-transport-security' in r.headers else 'NOHSTS')\n"
    )
    import tempfile
    db_path = os.path.join(tempfile.mkdtemp(), "prod.db").replace("\\", "/")
    result = run_python(code, APP_ENV="production", JWT_SECRET="s" * 40, DATABASE_URL=f"sqlite:///{db_path}")
    assert result.stdout.split() == ["SECURE", "HSTS"], result.stderr[-800:]
