# SUPERSEDED (audit fixes): schema changes are managed by Alembic (fastapi/migrations/versions). This one-off
# script is kept only as history of what was applied to production before Alembic existed. Do not run it.
import sys as _sys
_sys.exit("Superseded by Alembic migrations; see DEPLOYMENT.md.")

from app.db import engine
from sqlalchemy import text

def migrate():
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        try:
            conn.execute(text("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'CUSTOMER';"))
            print("Successfully updated userrole enum in PostgreSQL with 'CUSTOMER'")
        except Exception as e:
            print("Migration note:", e)

if __name__ == "__main__":
    migrate()
