"""
Test harness for Inbox POS.

SAFETY: the suite only runs against a disposable PostgreSQL database given in TEST_DATABASE_URL.
  * The database name must end in "_test" and must not be "inbox_pos".
  * The host must be localhost/127.0.0.1 unless ALLOW_REMOTE_TEST_DB=1.
  * .env files are never read (INBOX_POS_SKIP_DOTENV=1), and DATABASE_URL/DB_* are overwritten, so the suite can
    never fall back to the application's real database.
The schema is dropped and rebuilt with Alembic at the start of the session; every test starts from empty tables.

    TEST_DATABASE_URL=postgresql+psycopg://user@127.0.0.1:5432/inbox_pos_test python -m pytest
"""
import os
import secrets
import sys
from decimal import Decimal

import pytest
from sqlalchemy.engine import make_url

_RAW = os.getenv("TEST_DATABASE_URL", "")
if not _RAW:
    pytest.exit("TEST_DATABASE_URL is not set; refusing to run (the suite needs a disposable *_test database).", returncode=2)

_URL = make_url(_RAW)
if _URL.get_backend_name() != "postgresql":
    pytest.exit("TEST_DATABASE_URL must be a PostgreSQL URL.", returncode=2)
if not (_URL.database or "").endswith("_test") or _URL.database == "inbox_pos":
    pytest.exit(f"Refusing to run against database '{_URL.database}': the name must end in '_test'.", returncode=2)
if _URL.host not in ("localhost", "127.0.0.1", "::1") and os.getenv("ALLOW_REMOTE_TEST_DB") != "1":
    pytest.exit(f"Refusing to run against remote host '{_URL.host}' (set ALLOW_REMOTE_TEST_DB=1 to override).", returncode=2)

os.environ["INBOX_POS_SKIP_DOTENV"] = "1"
os.environ["DATABASE_URL"] = _RAW
for _name in ("DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASS", "DB_PASSWORD"):
    os.environ.pop(_name, None)
os.environ["APP_ENV"] = "test"
os.environ["JWT_SECRET"] = secrets.token_urlsafe(48)
os.environ["SEED_DEMO_DATA"] = "0"
os.environ.setdefault("TAX_RATE", "0")
os.environ.pop("INITIAL_SUPERADMIN_PASSWORD", None)

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, APP_DIR)

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import engine, SessionLocal  # noqa: E402
import app.models as m  # noqa: E402
from app.core.security import get_password_hash  # noqa: E402

PASSWORD = "Correct-Horse-9"
_PASSWORD_HASH = get_password_hash(PASSWORD)

print(f"\n[tests] database: engine=postgresql host={_URL.host} database={_URL.database} (disposable test DB)\n")


def alembic_config() -> Config:
    cfg = Config(os.path.join(APP_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(APP_DIR, "migrations"))
    return cfg


@pytest.fixture(scope="session", autouse=True)
def _schema():
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    command.upgrade(alembic_config(), "head")
    yield


@pytest.fixture(autouse=True)
def _clean_tables():
    with engine.begin() as conn:
        tables = [r[0] for r in conn.execute(text(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
        ))]
        conn.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " RESTART IDENTITY CASCADE"))
    from app.routers.auth import login_ip_limiter
    from app.routers.customer_orders import order_ip_limiter
    login_ip_limiter.reset()
    order_ip_limiter.reset()
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


class World:
    """Two branches with one account per role each, a small menu, stock and an open shift per POS user."""

    def __init__(self, session):
        self.db = session
        self.t1 = m.Tenant(name="Branch One", subdomain_or_code="b1")
        self.t2 = m.Tenant(name="Branch Two", subdomain_or_code="b2")
        session.add_all([self.t1, self.t2])
        session.flush()
        self.users = {}
        self.add_user("superadmin", m.UserRole.SUPER_ADMIN, None)
        for tenant, suffix in ((self.t1, ""), (self.t2, "2")):
            for role in ("admin", "manager", "cashier", "inventory", "kitchen"):
                self.add_user(f"{role}{suffix}", m.UserRole[role.upper()], tenant.id)
        self.cat1 = m.Category(tenant_id=self.t1.id, name="Drinks")
        self.cat2 = m.Category(tenant_id=self.t2.id, name="Drinks")
        session.add_all([self.cat1, self.cat2])
        session.flush()
        self.coke = self.add_product(self.t1, self.cat1, "Coke", "C-1", "25.00")
        self.burger = self.add_product(self.t1, self.cat1, "Burger", "B-1", "95.50")
        self.t2_product = self.add_product(self.t2, self.cat2, "Branch Two Secret", "S-2", "10.00")
        self.rice = m.InventoryItem(tenant_id=self.t1.id, name="Rice", unit="kg", quantity=Decimal("10"), min_stock=Decimal("2"))
        session.add(self.rice)
        self.supplier = m.Supplier(tenant_id=self.t1.id, supplier_name="Rice Co", status="Active")
        session.add(self.supplier)
        session.commit()

    def add_user(self, username, role, tenant_id, **extra):
        user = m.User(username=username, password_hash=_PASSWORD_HASH, role=role, tenant_id=tenant_id,
                      email=f"{username}@test.local", **extra)
        self.db.add(user)
        self.db.flush()
        self.users[username] = user
        return user

    def add_product(self, tenant, category, name, sku, price):
        product = m.Product(tenant_id=tenant.id, category_id=category.id, name=name, sku=sku,
                            price=Decimal(price), cost=Decimal("1.00"))
        self.db.add(product)
        self.db.flush()
        return product

    def open_shift(self, username, start_cash="0"):
        user = self.users[username]
        shift = m.Shift(tenant_id=user.tenant_id or self.t1.id, user_id=user.id, start_cash=Decimal(start_cash), status="open")
        self.db.add(shift)
        self.db.commit()
        return shift


@pytest.fixture
def world(db):
    return World(db)


@pytest.fixture
def client(world):
    # Depends on `world` so the test branches exist before start-up runs (start-up creates a default branch only
    # when there is none).
    from app.main import app
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture
def login(client):
    cache = {}

    def _login(username, password=PASSWORD):
        if (username, password) not in cache:
            r = client.post("/api/v1/auth/login", data={"username": username, "password": password})
            assert r.status_code == 200, r.text
            cache[(username, password)] = {"Authorization": f"Bearer {r.json()['access_token']}"}
        return cache[(username, password)]

    return _login
