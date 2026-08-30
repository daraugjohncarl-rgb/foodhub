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
