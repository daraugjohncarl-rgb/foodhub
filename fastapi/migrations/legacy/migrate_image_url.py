# SUPERSEDED (audit fixes): schema changes are managed by Alembic (fastapi/migrations/versions). This one-off
# script is kept only as history of what was applied to production before Alembic existed. Do not run it.
import sys as _sys
_sys.exit("Superseded by Alembic migrations; see DEPLOYMENT.md.")

import os
from sqlalchemy import text
from app.db import engine

def migrate():
    with engine.begin() as conn:
        print("Checking if image_url exists...")
        conn.execute(text("ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;"))
        print("Migration complete. Added image_url column to products table.")

if __name__ == "__main__":
    migrate()
