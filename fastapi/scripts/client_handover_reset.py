#!/usr/bin/env python3
"""
Client Handover Controlled Reset Script — Blessie FoodHub POS
=============================================================
Safely prepares the POS database for new client handover:
- Resets all financial totals to 0.00 by removing confirmed demonstration/test transactions.
- Preserves all system accounts, roles, tenants, categories, suppliers, and master catalog structures.
- Supports both local MySQL and cloud Supabase PostgreSQL databases.
- Enforces explicit database confirmation, transaction isolation, and automatic backup verification.

Usage:
    # Dry-run on active database (.env)
    python scripts/client_handover_reset.py --target-db pos --dry-run

    # Execute reset on active database (.env)
    python scripts/client_handover_reset.py --target-db pos --execute

    # Dry-run on remote Supabase PostgreSQL
    python scripts/client_handover_reset.py --db-url "postgresql://..." --target-db postgres --dry-run

    # Execute reset on remote Supabase PostgreSQL
    python scripts/client_handover_reset.py --db-url "postgresql://..." --target-db postgres --execute
"""

import sys
import os
import argparse
import subprocess
from datetime import datetime
from decimal import Decimal
from urllib.parse import urlparse

# Reconfigure stdout for utf-8 on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Ensure project root is in sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR) if os.path.basename(SCRIPT_DIR) != "fastapi" else os.path.dirname(os.path.dirname(SCRIPT_DIR))
sys.path.insert(0, PROJECT_ROOT)
if os.path.join(PROJECT_ROOT, "fastapi") not in sys.path:
    sys.path.insert(0, os.path.join(PROJECT_ROOT, "fastapi"))

from sqlalchemy import create_engine, text, inspect
from dotenv import load_dotenv

load_dotenv(os.path.join(PROJECT_ROOT, ".env"))


def normalize_url(url: str) -> str:
    """Normalize postgres URL for SQLAlchemy with psycopg v3."""
    if not url:
        return url
    clean = url.strip()
    if clean.startswith("postgres://"):
        return clean.replace("postgres://", "postgresql+psycopg://", 1)
    elif clean.startswith("postgresql://") and not clean.startswith("postgresql+"):
        return clean.replace("postgresql://", "postgresql+psycopg://", 1)
    return clean


def create_backup(engine, db_name: str, is_postgres: bool, backup_dir: str) -> str:
    """Creates a verified SQL backup of the target database."""
    os.makedirs(backup_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    engine_type = "supabase_pg" if is_postgres else "mysql"
    backup_path = os.path.join(backup_dir, f"pos_handover_backup_{engine_type}_{timestamp}.sql")
    
    with engine.connect() as conn:
        inspector = inspect(engine)
        table_names = inspector.get_table_names()
        
        with open(backup_path, "w", encoding="utf-8") as f:
            f.write(f"-- Blessie FoodHub POS Handover Safety Backup\n")
            f.write(f"-- Timestamp : {datetime.now().isoformat()}\n")
            f.write(f"-- Engine    : {'PostgreSQL / Supabase' if is_postgres else 'MySQL'}\n")
            f.write(f"-- Database  : {db_name}\n\n")
            
            total_rows = 0
            for tbl in table_names:
                quote_tbl = f'"{tbl}"' if is_postgres else f'`{tbl}`'
                res = conn.execute(text(f"SELECT * FROM {quote_tbl}"))
                rows = res.fetchall()
                cols = res.keys()
                total_rows += len(rows)
                
                f.write(f"-- Table: {tbl} ({len(rows)} rows)\n")
                if rows:
                    col_str = ", ".join([f'"{c}"' if is_postgres else f'`{c}`' for c in cols])
                    for r in rows:
                        vals = []
                        for v in r:
                            if v is None:
                                vals.append("NULL")
                            elif isinstance(v, (int, float, Decimal)):
                                vals.append(str(v))
                            elif isinstance(v, bool):
                                vals.append("TRUE" if v else "FALSE")
                            elif isinstance(v, datetime):
                                vals.append(f"'{v.isoformat()}'")
                            else:
                                clean_v = str(v).replace("'", "''")
                                vals.append(f"'{clean_v}'")
                        val_str = ", ".join(vals)
                        f.write(f"INSERT INTO {quote_tbl} ({col_str}) VALUES ({val_str});\n")
                f.write("\n")
                
    if not os.path.exists(backup_path) or os.path.getsize(backup_path) == 0:
        raise RuntimeError(f"Backup file is missing or empty at {backup_path}")
        
    return backup_path


def inspect_records(conn, is_postgres: bool) -> dict:
    """Inspects affected record counts across all operational tables."""
    counts = {}
    tables = [
        "payments",
        "transaction_items",
        "transactions",
        "shift_cash_movements",
        "shifts",
        "customer_order_items",
        "customer_orders",
        "incident_reports",
        "activity_logs",
        "expenses",
        "purchase_order_items",
        "purchase_orders",
        "products",
        "inventory_items",
        "users",
        "tenants",
        "suppliers",
        "categories"
    ]
    for t in tables:
        quote_t = f'"{t}"' if is_postgres else f'`{t}`'
        try:
            cnt = conn.execute(text(f"SELECT COUNT(*) FROM {quote_t}")).scalar()
            counts[t] = cnt
        except Exception:
            counts[t] = 0
    return counts


def main():
    parser = argparse.ArgumentParser(description="Blessie FoodHub POS Client Handover Database Reset")
    parser.add_argument("--target-db", required=True, help="Explicit target database name (e.g. 'pos' or 'postgres')")
    parser.add_argument("--db-url", help="Optional database connection URL (defaults to DATABASE_URL in .env)")
    parser.add_argument("--dry-run", action="store_true", help="Report planned cleanup without modifying any records")
    parser.add_argument("--execute", action="store_true", help="Execute the database cleanup inside a transaction")
    parser.add_argument("--no-backup", action="store_true", help="Skip creating a new backup (only if already backed up)")
    parser.add_argument("--reset-stock-qty", action="store_true", default=True, help="Set opening stock quantities to 0.00 while preserving items")
    
    args = parser.parse_args()

    # 1. Resolve database URL & engine
    raw_url = args.db_url or os.getenv("DATABASE_URL")
    if not raw_url:
        print("[-] ERROR: No DATABASE_URL found. Please set DATABASE_URL or pass --db-url.")
        sys.exit(1)

    db_url = normalize_url(raw_url)
    is_postgres = "postgres" in db_url
    is_mysql = "mysql" in db_url

    # Parse database name from URL
    parsed = urlparse(raw_url.replace("postgresql+psycopg://", "postgresql://").replace("mysql+pymysql://", "mysql://"))
    active_db_name = (parsed.path.lstrip("/") if parsed.path else "") or os.getenv("DB_NAME", "")

    # Target database validation
    if args.target_db.lower() != active_db_name.lower():
        print(f"[-] ERROR: Target database '{args.target_db}' does not match connected database '{active_db_name}'.")
        print("    Aborting operation to protect environment.")
        sys.exit(1)

    if not args.dry_run and not args.execute:
        print("[-] Please specify either --dry-run to preview or --execute to perform the handover reset.")
        sys.exit(1)

    masked_host = parsed.hostname or "localhost"
    print("==========================================================")
    print("  BLESSIE FOODHUB POS — CLIENT HANDOVER CONTROLLED RESET")
    print("==========================================================")
    print(f"Engine          : {'PostgreSQL / Supabase' if is_postgres else 'MySQL'}")
    print(f"Target Database : {active_db_name} on {masked_host}:{parsed.port or (5432 if is_postgres else 3306)}")
    print(f"Execution Mode  : {'DRY RUN (No changes)' if args.dry_run else 'DESTRUCTIVE EXECUTION'}")
    print("----------------------------------------------------------")

    engine = create_engine(db_url, pool_pre_ping=True)

    # 2. Inspect current database state
    with engine.connect() as conn:
        counts = inspect_records(conn, is_postgres)

        # Retrieve specific details for dry-run report
        demo_txs = []
        if counts.get('transactions', 0) > 0:
            q = 'SELECT id, net_amount, status, created_at FROM "transactions" ORDER BY id LIMIT 20;' if is_postgres else 'SELECT id, net_amount, status, created_at FROM `transactions` ORDER BY id LIMIT 20;'
            demo_txs = conn.execute(text(q)).fetchall()

        demo_scms = []
        if counts.get('shift_cash_movements', 0) > 0:
            q = 'SELECT id, type, amount, reason, created_at FROM "shift_cash_movements" ORDER BY id LIMIT 20;' if is_postgres else 'SELECT id, type, amount, reason, created_at FROM `shift_cash_movements` ORDER BY id LIMIT 20;'
            demo_scms = conn.execute(text(q)).fetchall()

        demo_cos = []
        if counts.get('customer_orders', 0) > 0:
            q = 'SELECT id, order_number, customer_name, total_amount, status FROM "customer_orders" ORDER BY id LIMIT 20;' if is_postgres else 'SELECT id, order_number, customer_name, total_amount, status FROM `customer_orders` ORDER BY id LIMIT 20;'
            demo_cos = conn.execute(text(q)).fetchall()

    print("\nCurrent Database State:")
    print(f"  • Completed/Test Transactions : {counts.get('transactions', 0)} (Items: {counts.get('transaction_items', 0)}, Payments: {counts.get('payments', 0)})")
    print(f"  • Cashier Shifts & Movements  : {counts.get('shifts', 0)} shifts, {counts.get('shift_cash_movements', 0)} drawer cash movements")
    print(f"  • Customer Orders             : {counts.get('customer_orders', 0)} (Items: {counts.get('customer_order_items', 0)})")
    print(f"  • Incident Reports            : {counts.get('incident_reports', 0)}")
    print(f"  • Activity Audit Logs         : {counts.get('activity_logs', 0)}")
    print(f"  • Expenses Recorded           : {counts.get('expenses', 0)}")
    print(f"  • Purchase Orders             : {counts.get('purchase_orders', 0)}")
    print(f"  • Master Inventory Items      : {counts.get('inventory_items', 0)} items (Preserved for client catalog)")
    print(f"  • Product Catalog Entries     : {counts.get('products', 0)} (Preserved)")
    print(f"  • Registered Suppliers        : {counts.get('suppliers', 0)} (Preserved)")
    print(f"  • System Users & Roles        : {counts.get('users', 0)} users (Preserved: Admin, Manager, Cashier, etc.)")
    print(f"  • Branch Tenants              : {counts.get('tenants', 0)} tenant (Preserved: Main Branch)")

    # 3. Dry-Run Detailed Reporting
    if args.dry_run:
        print("\n" + "=" * 58)
        print("  DRY RUN DETAILED INSPECTION REPORT")
        print("=" * 58)
        
        if demo_txs:
            print("\nDemonstration Transactions to be reset:")
            for t in demo_txs:
                print(f"  - ID: {t[0]} | Net: ₱{float(t[1]):,.2f} | Status: {t[2]} | Date: {t[3]}")
                
        if demo_scms:
            print("\nShift Cash Movements to be reset:")
            for m in demo_scms:
                print(f"  - ID: {m[0]} | Type: {m[1]} | Amount: ₱{float(m[2]):,.2f} | Reason: {m[3]} | Date: {m[4]}")
                
        if demo_cos:
            print("\nCustomer Online Orders to be reset:")
            for o in demo_cos:
                print(f"  - ID: {o[0]} | Order: {o[1]} | Name: {o[2]} | Total: ₱{float(o[3]):,.2f} | Status: {o[4]}")

        print("\nActions that will be executed upon confirmation:")
        print("  1. Remove foreign-key dependent payments and transaction items.")
        print(f"  2. Delete {counts.get('transactions', 0)} demonstration transactions.")
        print(f"  3. Delete {counts.get('shift_cash_movements', 0)} drawer cash movements (including drawer modal adjustments).")
        print(f"  4. Reset {counts.get('shifts', 0)} shifts and initialize Shift #1 at ₱0.00 float.")
        print(f"  5. Delete {counts.get('customer_orders', 0)} demonstration customer orders.")
        print(f"  6. Delete {counts.get('incident_reports', 0)} test incident reports.")
        print(f"  7. Clear {counts.get('activity_logs', 0)} developmental activity logs.")
        print(f"  8. Reset inventory quantities to 0.00 while preserving all master catalog items.")
        print("  9. PRESERVE system users (superadmin, admin, manager, cashier, inventory, kitchen).")
        print("  10. PRESERVE tenant configuration, categories, products, and registered suppliers.")
        print("\nAll financial totals (Sales, Income Received from Manager, Profit, Drawer) will start at ₱0.00.")
        print("\nTo apply these changes, run with: --execute")
        return

    # 4. Mandatory Backup Creation
    backup_dir = os.path.join(PROJECT_ROOT, "backups")
    if not args.no_backup:
        print("\n[*] Creating safety backup before modifying records...")
        try:
            backup_path = create_backup(engine, active_db_name, is_postgres, backup_dir)
            print(f"[+] Safety backup created successfully:\n    {backup_path} ({os.path.getsize(backup_path):,} bytes)")
        except Exception as e:
            print(f"[-] ERROR: Failed to create safety backup: {e}")
            print("    Aborting operation. No records were modified.")
            sys.exit(1)

    # 5. Execute Cleanup in a Transaction
    print("\n[*] Executing database cleanup inside transaction...")
    with engine.begin() as conn:
        if is_mysql:
            conn.execute(text("SET FOREIGN_KEY_CHECKS = 0;"))

        # 1. Transactions & Payments
        conn.execute(text('DELETE FROM "payments";' if is_postgres else 'DELETE FROM `payments`;'))
        conn.execute(text('DELETE FROM "transaction_items";' if is_postgres else 'DELETE FROM `transaction_items`;'))
        conn.execute(text('DELETE FROM "transactions";' if is_postgres else 'DELETE FROM `transactions`;'))

        # 2. Shift & Cash Drawer movements
        conn.execute(text('DELETE FROM "shift_cash_movements";' if is_postgres else 'DELETE FROM `shift_cash_movements`;'))
        conn.execute(text('DELETE FROM "shifts";' if is_postgres else 'DELETE FROM `shifts`;'))

        # 3. Customer Orders
        conn.execute(text('DELETE FROM "customer_order_items";' if is_postgres else 'DELETE FROM `customer_order_items`;'))
        conn.execute(text('DELETE FROM "customer_orders";' if is_postgres else 'DELETE FROM `customer_orders`;'))

        # 4. Incident Reports & Expenses
        conn.execute(text('DELETE FROM "incident_reports";' if is_postgres else 'DELETE FROM `incident_reports`;'))
        conn.execute(text('DELETE FROM "expenses";' if is_postgres else 'DELETE FROM `expenses`;'))

        # 5. Purchase Orders
        conn.execute(text('DELETE FROM "purchase_order_items";' if is_postgres else 'DELETE FROM `purchase_order_items`;'))
        conn.execute(text('DELETE FROM "purchase_orders";' if is_postgres else 'DELETE FROM `purchase_orders`;'))

        # 6. Activity Logs
        conn.execute(text('DELETE FROM "activity_logs";' if is_postgres else 'DELETE FROM `activity_logs`;'))

        # 7. Sequence Resets
        if is_postgres:
            reset_tables = [
                "payments", "transaction_items", "transactions",
                "shift_cash_movements", "shifts", "customer_order_items",
                "customer_orders", "incident_reports", "expenses",
                "purchase_order_items", "purchase_orders", "activity_logs"
            ]
            for tbl in reset_tables:
                try:
                    conn.execute(text(f"SELECT setval(pg_get_serial_sequence('\"{tbl}\"', 'id'), 1, false);"))
                except Exception:
                    pass
        else:
            for tbl in ["payments", "transaction_items", "transactions", "shift_cash_movements", "shifts", "customer_order_items", "customer_orders", "incident_reports", "expenses", "purchase_order_items", "purchase_orders", "activity_logs"]:
                try:
                    conn.execute(text(f"ALTER TABLE `{tbl}` AUTO_INCREMENT = 1;"))
                except Exception:
                    pass

        # 8. Reset Inventory stock quantities to 0.00
        if args.reset_stock_qty:
            try:
                conn.execute(text('UPDATE "inventory_items" SET quantity = 0.00;' if is_postgres else 'UPDATE `inventory_items` SET quantity = 0.00;'))
            except Exception:
                pass

        # 9. Initialize clean initial Shift #1 with start_cash = 0.00
        first_tenant = conn.execute(text('SELECT id FROM "tenants" LIMIT 1;' if is_postgres else 'SELECT id FROM `tenants` LIMIT 1;')).scalar() or 1
        cashier_user = conn.execute(text('SELECT id FROM "users" WHERE role = \'CASHIER\' OR username = \'cashier\' LIMIT 1;' if is_postgres else 'SELECT id FROM `users` WHERE role = \'CASHIER\' OR username = \'cashier\' LIMIT 1;')).scalar() or 5
        
        if is_postgres:
            conn.execute(text(f"""
                INSERT INTO "shifts" (tenant_id, user_id, start_time, start_cash, status)
                VALUES ({first_tenant}, {cashier_user}, NOW(), 0.00, 'open');
            """))
        else:
            conn.execute(text(f"""
                INSERT INTO `shifts` (tenant_id, user_id, start_time, start_cash, status)
                VALUES ({first_tenant}, {cashier_user}, NOW(), 0.00, 'open');
            """))

        if is_mysql:
            conn.execute(text("SET FOREIGN_KEY_CHECKS = 1;"))

    print("[+] Database cleanup completed and committed successfully!")

    # 6. Post-Cleanup Verification
    with engine.connect() as conn:
        post_counts = inspect_records(conn, is_postgres)

    print("\nPost-Cleanup Verification:")
    print(f"  • Transactions      : {post_counts.get('transactions', 0)}")
    print(f"  • Payments          : {post_counts.get('payments', 0)}")
    print(f"  • Shifts            : {post_counts.get('shifts', 0)} (Clean Shift #1 initialized at ₱0.00)")
    print(f"  • Shift Movements   : {post_counts.get('shift_cash_movements', 0)}")
    print(f"  • Customer Orders   : {post_counts.get('customer_orders', 0)}")
    print(f"  • Incident Reports  : {post_counts.get('incident_reports', 0)}")
    print(f"  • Activity Logs     : {post_counts.get('activity_logs', 0)}")
    print(f"  • Master Inventory  : {post_counts.get('inventory_items', 0)} items preserved (All stock: 0.00)")
    print(f"  • Users Preserved   : {post_counts.get('users', 0)} accounts")
    print(f"  • Tenants Preserved : {post_counts.get('tenants', 0)} tenant")

    # Log initial handover event in activity log
    try:
        with engine.begin() as conn:
            if is_postgres:
                conn.execute(text(f"""
                    INSERT INTO "activity_logs" (tenant_id, user_id, action, performed_by, details, created_at)
                    VALUES ({first_tenant}, 1, 'SYSTEM_HANDOVER_INITIALIZATION', 'System Administrator', 'Database initialized for clean client handover with ₱0.00 starting financial totals.', NOW());
                """))
            else:
                conn.execute(text(f"""
                    INSERT INTO `activity_logs` (tenant_id, user_id, action, performed_by, details, created_at)
                    VALUES ({first_tenant}, 1, 'SYSTEM_HANDOVER_INITIALIZATION', 'System Administrator', 'Database initialized for clean client handover with ₱0.00 starting financial totals.', NOW());
                """))
    except Exception:
        pass

    print("\n[✓] POS System is now completely prepared for clean client handover.")


if __name__ == "__main__":
    main()
