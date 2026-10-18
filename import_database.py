"""
Universal Database Importer Script
Blessie FoodHub / RestoTrack POS

Usage:
    python import_database.py                     # Automatically imports based on active DATABASE_URL in .env
    python import_database.py --target supabase   # Imports supabase_setup.sql to Supabase Cloud PostgreSQL
    python import_database.py --target mysql      # Imports local_mysql_setup.sql to local MySQL / MariaDB
    python import_database.py --file <path.sql>   # Imports a specific SQL file
"""

import os
import sys
import argparse
from urllib.parse import urlparse
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding='utf-8')
load_dotenv('c:/pos/.env')

def parse_args():
    parser = argparse.ArgumentParser(description="Universal Database Importer")
    parser.add_argument("--target", choices=["auto", "supabase", "postgres", "mysql", "local"], default="auto",
                        help="Target database (defaults to auto-detect from .env)")
    parser.add_argument("--file", help="Custom SQL file to import")
    return parser.parse_args()

def run_import():
    args = parse_args()
    raw_url = os.getenv("DATABASE_URL", "")

    if args.target in ("supabase", "postgres"):
        is_postgres = True
        sql_file = args.file or "c:/pos/supabase_setup.sql"
        db_url = raw_url
    elif args.target in ("mysql", "local"):
        is_postgres = False
        sql_file = args.file or "c:/pos/local_mysql_setup.sql"
        db_url = "mysql+pymysql://root:@127.0.0.1:3306/pos?charset=utf8mb4"
    else:  # auto
        is_postgres = "postgres" in raw_url.lower()
        sql_file = args.file or ("c:/pos/supabase_setup.sql" if is_postgres else "c:/pos/local_mysql_setup.sql")
        db_url = raw_url

    print("\n" + "=" * 65)
    print(" 🚀 BLESSIE FOODHUB: UNIVERSAL DATABASE IMPORTER")
    print("=" * 65)
    print(f"▶ Target Type : {'PostgreSQL / Supabase' if is_postgres else 'MySQL / MariaDB'}")
    print(f"▶ SQL Script  : {sql_file}")
    print(f"▶ Connection  : {db_url.split('@')[-1] if '@' in db_url else db_url}")
    print("-" * 65)

    if not os.path.exists(sql_file):
        print(f"❌ Error: SQL file '{sql_file}' not found.")
        sys.exit(1)

    with open(sql_file, "r", encoding="utf-8") as f:
        sql_content = f.read()

    print("▶ [1/2] Connecting to target database...")
    if is_postgres:
        import psycopg
        # Clean postgres url
        clean_url = db_url.replace("postgresql+psycopg://", "postgresql://").replace("postgres://", "postgresql://")
        try:
            conn = psycopg.connect(clean_url, autocommit=True)
            print("  ✓ Connected to PostgreSQL / Supabase successfully!")
            print("▶ [2/2] Executing supabase_setup.sql...")
            with conn.cursor() as cur:
                cur.execute(sql_content)
            conn.close()
            print("  ✓ All tables, indexes, data, and sequences created and synchronized!")
        except Exception as e:
            print(f"❌ PostgreSQL import error: {e}")
            sys.exit(1)
    else:
        import pymysql
        from pymysql.constants import CLIENT
        try:
            # Parse MySQL credentials
            clean_url = db_url.replace("mysql+pymysql://", "mysql://")
            parsed = urlparse(clean_url)
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or 3306
            user = parsed.username or "root"
            password = parsed.password or ""
            database = (parsed.path or "/pos").lstrip("/")

            conn = pymysql.connect(
                host=host,
                port=port,
                user=user,
                password=password,
                database=database,
                charset="utf8mb4",
                client_flag=CLIENT.MULTI_STATEMENTS
            )
            print(f"  ✓ Connected to local MySQL ({host}:{port}/{database}) successfully!")
            print("▶ [2/2] Executing local_mysql_setup.sql...")
            cur = conn.cursor()
            cur.execute(sql_content)
            while conn.next_result():
                pass
            conn.commit()
            conn.close()
            print("  ✓ All tables, foreign keys, and records imported successfully!")
        except Exception as e:
            print(f"❌ MySQL import error: {e}")
            sys.exit(1)

    print("\n" + "=" * 65)
    print(" 🎉 DATABASE IMPORT COMPLETED SUCCESSFULLY!")
    print("=" * 65 + "\n")

if __name__ == "__main__":
    run_import()
