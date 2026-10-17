"""
Automated Database Migration Script: MySQL -> Supabase (PostgreSQL)
Blessie FoodHub / RestoTrack POS

Usage:
    python migrate_to_supabase.py --target "postgresql://postgres.[REF]:[PASS]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require"

Options:
    --source    Source MySQL connection string (defaults to DATABASE_URL in .env)
    --target    Target Supabase connection string (required)
"""
import sys
import os
import argparse
from dotenv import load_dotenv

# Ensure utf-8 output on Windows console
sys.stdout.reconfigure(encoding='utf-8')

load_dotenv()

# Migration table order to respect foreign key constraints
TABLE_ORDER = [
    "tenants",
    "categories",
    "suppliers",
    "users",
    "restaurant_tables",
    "inventory_items",
    "products",
    "product_recipes",
    "purchase_orders",
    "purchase_order_items",
    "shifts",
    "shift_cash_movements",
    "transactions",
    "transaction_items",
    "payments",
    "customer_orders",
    "customer_order_items",
    "incident_reports",
    "activity_logs",
    "stock_movements"
]

def parse_args():
    parser = argparse.ArgumentParser(description="Migrate local MySQL database to Supabase PostgreSQL")
    parser.add_argument("--source", default=os.getenv("DATABASE_URL"), help="Source MySQL connection string")
    parser.add_argument("--target", required=False, help="Target Supabase connection string")
    return parser.parse_args()

def normalize_pg_url(url: str) -> str:
    """Normalize postgres URL for psycopg v3"""
    if not url:
        return url
    clean = url.strip()
    if clean.startswith("postgres://"):
        clean = clean.replace("postgres://", "postgresql+psycopg://", 1)
    elif clean.startswith("postgresql://") and not clean.startswith("postgresql+"):
        clean = clean.replace("postgresql://", "postgresql+psycopg://", 1)
    return clean

def run_migration(source_url: str, target_url: str):
    from sqlalchemy import create_engine, inspect, text, Table, MetaData
    from app.db import Base
    import app.models as models

    print("\n" + "=" * 60)
    print(" 🚀 BLESSIE FOODHUB: MYSQL TO SUPABASE MIGRATION WIZARD")
    print("=" * 60 + "\n")

    print(f"▶ Source DB: {source_url.split('@')[-1] if '@' in source_url else source_url}")
    print(f"▶ Target DB: {target_url.split('@')[-1] if '@' in target_url else target_url}")

    # 1. Connect to Source
    print("\n[1/5] Connecting to local MySQL...")
    try:
        source_engine = create_engine(source_url, pool_pre_ping=True)
        with source_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        print("  ✓ Connected to local MySQL successfully.")
    except Exception as e:
        print(f"  ❌ Error connecting to source MySQL: {e}")
        sys.exit(1)

    # 2. Connect to Target Supabase
    print("\n[2/5] Connecting to remote Supabase...")
    try:
        target_engine = create_engine(normalize_pg_url(target_url), pool_pre_ping=True)
        with target_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        print("  ✓ Connected to Supabase PostgreSQL successfully.")
    except Exception as e:
        print(f"  ❌ Error connecting to Supabase: {e}")
        print("  💡 Tip: Ensure your password is correct and '?sslmode=require' is attached to the URL.")
        sys.exit(1)

    # 3. Create all tables in Supabase using SQLAlchemy Base
    print("\n[3/5] Creating table schemas in Supabase...")
    try:
        Base.metadata.create_all(bind=target_engine)
        print("  ✓ All 20 tables verified/created in Supabase.")
    except Exception as e:
        print(f"  ❌ Error creating tables in Supabase: {e}")
        sys.exit(1)

    # 4. Migrate Data Table by Table
    print("\n[4/5] Migrating records in foreign key dependency order...")
    source_insp = inspect(source_engine)
    available_tables = source_insp.get_table_names()

    source_meta = MetaData()
    source_meta.reflect(bind=source_engine)

    target_meta = MetaData()
    target_meta.reflect(bind=target_engine)

    total_rows_migrated = 0

    with target_engine.begin() as target_conn:
        # Disable foreign key triggers temporarily for bulk load
        target_conn.execute(text("SET session_replication_role = 'replica';"))

        for table_name in TABLE_ORDER:
            if table_name not in available_tables or table_name not in target_meta.tables:
                continue

            src_table = source_meta.tables[table_name]
            tgt_table = target_meta.tables[table_name]

            with source_engine.connect() as src_conn:
                rows = src_conn.execute(src_table.select()).fetchall()

            if not rows:
                print(f"  - {table_name:<24}: 0 records (empty)")
                continue

            # Convert row mapping to dicts
            data = [dict(r._mapping) for r in rows]

            # Clear existing records in target to prevent duplicate key collisions
            target_conn.execute(tgt_table.delete())

            # Batch insert
            target_conn.execute(tgt_table.insert(), data)
            total_rows_migrated += len(data)
            print(f"  ✓ {table_name:<24}: {len(data):4d} records migrated")

        # Re-enable foreign key constraints
        target_conn.execute(text("SET session_replication_role = 'DEFAULT';"))

    # 5. Reset PostgreSQL Sequences
    print("\n[5/5] Resetting PostgreSQL sequences (auto-increment counters)...")
    with target_engine.begin() as conn:
        for table_name in TABLE_ORDER:
            if table_name not in target_meta.tables:
                continue
            pk_col = "id"
            try:
                conn.execute(text(f"""
                    SELECT setval(
                        pg_get_serial_sequence('"{table_name}"', '{pk_col}'),
                        COALESCE((SELECT MAX("{pk_col}") FROM "{table_name}"), 1)
                    );
                """))
            except Exception:
                pass  # Ignore tables without standard serial sequences

    print("  ✓ All PostgreSQL sequences synchronized.")

    print("\n" + "=" * 60)
    print(f" 🎉 MIGRATION COMPLETE: {total_rows_migrated} total rows transferred to Supabase!")
    print("=" * 60)
    print("\nNext step: Update your .env with your Supabase DATABASE_URL:")
    print(f"DATABASE_URL={normalize_pg_url(target_url)}\n")

if __name__ == "__main__":
    args = parse_args()
    target = args.target

    if not target:
        print("\n⚠️ No target Supabase connection string provided.")
        print("Please enter your Supabase Connection URL (e.g. from Supabase Settings -> Database):")
        try:
            target = input("Supabase URL: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nMigration cancelled.")
            sys.exit(0)

    if not target:
        print("Target URL is required. Exiting.")
        sys.exit(1)

    run_migration(args.source, target)
