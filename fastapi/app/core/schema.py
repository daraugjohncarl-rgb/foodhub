"""
Start-up schema check. The application never creates or alters tables itself any more: schema changes are applied
by a person with `alembic upgrade head` (see DEPLOYMENT.md). If the database is behind the code, start-up fails with
an explanation instead of serving errors.
"""
import os

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

_APP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # .../fastapi


class SchemaNotReady(RuntimeError):
    pass


def expected_head() -> str:
    config = Config(os.path.join(_APP_DIR, "alembic.ini"))
    config.set_main_option("script_location", os.path.join(_APP_DIR, "migrations"))
    return ScriptDirectory.from_config(config).get_current_head()


def current_revision(engine: Engine):
    with engine.connect() as conn:
        if not inspect(conn).has_table("alembic_version"):
            return None
        return conn.execute(text("SELECT version_num FROM alembic_version")).scalar()


def assert_schema_current(engine: Engine) -> str:
    head = expected_head()
    current = current_revision(engine)
    if current == head:
        return current
    with engine.connect() as conn:
        has_app_tables = inspect(conn).has_table("users")
    if current is None and has_app_tables:
        hint = (
            "This database predates Alembic. After taking a backup, run from the fastapi/ directory:\n"
            "  alembic stamp 0001_baseline\n  alembic upgrade head"
        )
    elif current is None:
        hint = "Empty database. Run from the fastapi/ directory:  alembic upgrade head"
    else:
        hint = "Run from the fastapi/ directory (after taking a backup):  alembic upgrade head"
    raise SchemaNotReady(
        f"Database schema is at revision {current!r} but this code needs {head!r}.\n{hint}"
    )
