"""
Shared fixtures for the Inbox POS backend tests.

Every test runs against a throwaway SQLite database created in a temp directory. The suite never
reads .env files for its database settings and refuses to run if the engine points anywhere else,
so it cannot touch a local MySQL or a Supabase/PostgreSQL project.
"""
import os
import sys
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="inboxpos_test_")
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(_TMP_DIR, "test.db").replace("\\", "/")
os.environ["JWT_SECRET"] = "test-secret-" + "x" * 40
os.environ["APP_ENV"] = "development"
os.environ["SEED_DEMO_DATA"] = "false"
os.environ["DB_AUTO_CREATE_TABLES"] = "true"
os.environ["RATE_LIMIT_ENABLED"] = "false"
os.environ.pop("ALLOWED_ORIGINS", None)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import pytest
from sqlalchemy import BigInteger
from sqlalchemy.ext.compiler import compiles


@compiles(BigInteger, "sqlite")
def _bigint_as_integer(type_, compiler, **kw):
    # SQLite only auto-increments INTEGER PRIMARY KEY columns.
    return "INTEGER"


from fastapi.testclient import TestClient

from app.db import SessionLocal, Base, engine
import app.models as models
from app.core.security import get_password_hash
from app.core.rate_limit import reset_all_limiters
from app.main import app

# Cheap bcrypt cost for tests only (production keeps the library default).
import bcrypt as _bcrypt
_real_gensalt = _bcrypt.gensalt
_bcrypt.gensalt = lambda rounds=4, prefix=b"2b": _real_gensalt(rounds=rounds, prefix=prefix)

assert str(engine.url).startswith("sqlite"), "Tests must only ever run against the disposable SQLite database."

PASSWORD = "Passw0rd!test"


@pytest.fixture(autouse=True)
def fresh_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    reset_all_limiters()
    os.environ["RATE_LIMIT_ENABLED"] = "false"
    yield


@pytest.fixture
def client(fresh_database):
    with TestClient(app) as c:
        c.headers["Origin"] = "http://testserver"  # browsers always send Origin on writes
        yield c


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _make_tenant(db, name):
    tenant = models.Tenant(name=name, subdomain_or_code=name.lower().replace(" ", "-"), is_active=True)
    db.add(tenant)
    db.commit()
    db.refresh(tenant)
    return tenant


@pytest.fixture
def tenants(db):
    """Two independent tenants."""
    return _make_tenant(db, "Tenant A"), _make_tenant(db, "Tenant B")


@pytest.fixture
def make_user(db):
    def factory(username, role, tenant=None, password=PASSWORD, **extra):
        user = models.User(
            username=username,
            email=extra.pop("email", f"{username}@example.test"),
            password_hash=get_password_hash(password),
            role=role,
            tenant_id=tenant.id if tenant is not None else None,
            is_active=extra.pop("is_active", True),
            **extra,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    return factory


@pytest.fixture
def login(client):
    def do_login(username, password=PASSWORD):
        resp = client.post("/api/v1/auth/login", data={"username": username, "password": password})
        assert resp.status_code == 200, resp.text
        return {"Authorization": f"Bearer {resp.json()['access_token']}"}
    return do_login


@pytest.fixture
def make_product(db):
    def factory(tenant, name, price, active=True, sku=None, station="none"):
        product = models.Product(
            tenant_id=tenant.id,
            name=name,
            sku=sku or name.upper().replace(" ", "-"),
            price=price,
            cost=0,
            is_active=active,
            preparation_station=station,
        )
        db.add(product)
        db.commit()
        db.refresh(product)
        return product
    return factory


R = models.UserRole
