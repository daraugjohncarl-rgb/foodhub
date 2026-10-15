import os
import sys
import logging

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import declarative_base, sessionmaker

# Ensure sys.path includes the fastapi directory
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import app.core.env  # noqa: E402,F401  (loads .env)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pos_db")


def _resolve_database_url() -> str:
    """
    DATABASE_URL wins (Render, Neon, Supabase, Railway, Docker). Otherwise DB_HOST / DB_NAME / DB_USER / DB_PASS
    must all be set explicitly: there are deliberately no default credentials or database name, so a missing .env
    can never silently connect to (and seed) whatever database happens to be running on localhost.
    """
    raw = os.getenv("DATABASE_URL")
    if raw:
        # Render and Heroku use 'postgres://' which SQLAlchemy 1.4+ deprecated in favour of 'postgresql://'
        if raw.startswith("postgres://"):
            return raw.replace("postgres://", "postgresql+psycopg://", 1)
        if raw.startswith("postgresql://") and not raw.startswith("postgresql+"):
            return raw.replace("postgresql://", "postgresql+psycopg://", 1)
        return raw

    missing = [name for name in ("DB_HOST", "DB_NAME", "DB_USER") if not os.getenv(name)]
    if missing:
        raise RuntimeError(
            "Database is not configured: set DATABASE_URL, or DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASS "
            f"(missing: {', '.join(missing)}). See fastapi/.env.example."
        )
    from sqlalchemy.engine import URL

    return URL.create(
        "postgresql+psycopg",
        username=os.getenv("DB_USER"),
        password=os.getenv("DB_PASS") or os.getenv("DB_PASSWORD") or None,
        host=os.getenv("DB_HOST"),
        port=int(os.getenv("DB_PORT", "5432")),
        database=os.getenv("DB_NAME"),
    ).render_as_string(hide_password=False)


DATABASE_URL = _resolve_database_url()
_url = make_url(DATABASE_URL)

_connect_args = {}
if _url.get_backend_name() == "postgresql":
    # Every session runs in UTC so server-side now() and Python's utcnow() agree.
    _connect_args["options"] = "-c timezone=UTC"

# pool_pre_ping=True verifies connections before using them, preventing disconnected socket errors
# pool_recycle=300 prevents timeouts on managed cloud databases (Render, Neon, Supabase)
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=300,
    connect_args=_connect_args,
)

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Declarative base for ORM models
Base = declarative_base()


def describe_database() -> str:
    """Engine, host and database name only; never the credentials."""
    return f"engine={_url.get_backend_name()} host={_url.host} database={_url.database}"


def get_db():
    """
    Dependency generator for FastAPI endpoints to get a DB session.
    Ensures that the connection is properly closed when the request is done.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
