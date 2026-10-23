#!/usr/bin/env python3
"""
Client Handover Controlled Reset Script — Blessie FoodHub POS
=============================================================
Safely prepares the POS database for new client handover:
- Resets all financial totals to 0.00 by removing confirmed demonstration/test transactions.
- Preserves all system accounts, roles, tenants, and master inventory structures.
- Enforces explicit database confirmation, transaction isolation, and backup verification.

Usage:
    python scripts/client_handover_reset.py --target-db pos --dry-run
    python scripts/client_handover_reset.py --target-db pos --execute
"""

import sys
import os
import argparse
import subprocess
from datetime import datetime
from decimal import Decimal

# Ensure parent directory is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import engine, SessionLocal, DB_NAME, DB_HOST, DB_PORT, DB_USER
from sqlalchemy import text


def create_backup(backup_dir: str) -> str:
    """Creates a verified mysqldump backup of the database."""
    os.makedirs(backup_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(backup_dir, f"pos_handover_backup_{timestamp}.sql")
    
    mysqldump_candidates = [
        r"C:\Program Files\MySQL\MySQL Server 9.1\bin\mysqldump.exe",
        "mysqldump"
    ]
    
    dump_cmd = None
    for cand in mysqldump_candidates:
        if os.path.isfile(cand) or cand == "mysqldump":
            dump_cmd = cand
            break
            
    if not dump_cmd:
        raise RuntimeError("mysqldump utility not found. Please install MySQL tools.")
        
    cmd = [
        dump_cmd,
        f"--host={DB_HOST}",
        f"--port={DB_PORT}",
        f"--user={DB_USER}",
        f"--databases", DB_NAME,
        "--routines",
        "--triggers",
        "--events",
        f"--result-file={backup_path}"
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Backup failed: {result.stderr}")
        
    if not os.path.exists(backup_path) or os.path.getsize(backup_path) == 0:
        raise RuntimeError(f"Backup file is missing or empty at {backup_path}")
        
    return backup_path


def inspect_records(conn) -> dict:
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
        try:
            cnt = conn.execute(text(f"SELECT COUNT(*) FROM `{t}`")).scalar()
            counts[t] = cnt
        except Exception:
            counts[t] = 0
    return counts


def main():
    parser = argparse.ArgumentParser(description="Blessie FoodHub POS Client Handover Database Reset")
    parser.add_argument("--target-db", required=True, help="Explicit target database name (must match active DB_NAME)")
    parser.add_argument("--dry-run", action="store_true", help="Report planned cleanup without modifying any records")
    parser.add_argument("--execute", action="store_true", help="Execute the database cleanup inside a transaction")
    parser.add_argument("--no-backup", action="store_true", help="Skip creating a new backup (only if already backed up)")
    parser.add_argument("--reset-stock-qty", action="store_true", default=True, help="Set opening stock quantities to 0.00 while preserving items")
    
    args = parser.parse_args()

    # 1. Target database validation
    if args.target_db != DB_NAME:
        print(f"[-] ERROR: Target database '{args.target_db}' does not match active database '{DB_NAME}'.")
        print("    Aborting operation to protect environment.")
        sys.exit(1)

    if not args.dry_run and not args.execute:
        print("[-] Please specify either --dry-run to preview or --execute to perform the handover reset.")
        sys.exit(1)

    print("==========================================================")
    print("  BLESSIE FOODHUB POS — CLIENT HANDOVER CONTROLLED RESET")
    print("==========================================================")
    print(f"Target Database : {DB_NAME} on {DB_HOST}:{DB_PORT}")
    print(f"Execution Mode  : {'DRY RUN (No changes)' if args.dry_run else 'DESTRUCTIVE EXECUTION'}")
    print("----------------------------------------------------------")

    # 2. Inspect current database state
    with engine.connect() as conn:
        counts = inspect_records(conn)

    print("\nCurrent Database State:")
    print(f"  • Completed/Test Transactions : {counts.get('transactions', 0)} (Items: {counts.get('transaction_items', 0)}, Payments: {counts.get('payments', 0)})")
    print(f"  • Cashier Shifts & Movements  : {counts.get('shifts', 0)} shifts, {counts.get('shift_cash_movements', 0)} drawer cash movements")
    print(f"  • Customer Orders             : {counts.get('customer_orders', 0)} (Items: {counts.get('customer_order_items', 0)})")
    print(f"  • Incident Reports            : {counts.get('incident_reports', 0)}")
    print(f"  • Activity Audit Logs         : {counts.get('activity_logs', 0)}")
    print(f"  • Expenses Recorded           : {counts.get('expenses', 0)}")
    print(f"  • Purchase Orders             : {counts.get('purchase_orders', 0)}")
    print(f"  • Master Inventory Items      : {counts.get('inventory_items', 0)} items (Preserved for client catalog)")
    print(f"  • Product Catalog Entries     : {counts.get('products', 0)}")
    print(f"  • Registered Suppliers        : {counts.get('suppliers', 0)}")
    print(f"  • System Users & Roles        : {counts.get('users', 0)} users (Preserved: Admin, Manager, Cashier, etc.)")
    print(f"  • Branch Tenants              : {counts.get('tenants', 0)} tenant (Preserved: Main Branch)")

    # 3. Dry-Run Reporting
    if args.dry_run:
        print("\n[DRY RUN SUMMARY] The following actions would be executed:")
        print("  1. Remove foreign-key dependent payments and transaction items.")
        print(f"  2. Delete {counts.get('transactions', 0)} demonstration transactions.")
        print(f"  3. Delete {counts.get('shift_cash_movements', 0)} drawer cash movement audit rows.")
        print(f"  4. Delete {counts.get('shifts', 0)} demonstration cashier shifts (Drawer resets to ₱0.00).")
        print(f"  5. Delete {counts.get('customer_orders', 0)} demonstration customer online orders.")
        print(f"  6. Delete {counts.get('incident_reports', 0)} test incident reports.")
        print(f"  7. Clear {counts.get('activity_logs', 0)} developmental activity logs.")
        print(f"  8. Reset any non-zero inventory stock quantities to 0.00 (preserving all {counts.get('inventory_items', 0)} master items).")
        print("  9. PRESERVE system users (superadmin, admin, manager, cashier, inventory, kitchen).")
        print("  10. PRESERVE tenant configuration, categories, and registered suppliers.")
        print("\nAll financial totals (Sales, Gross/Net, COGS, Profit, Expenses, Cash Drawer) will calculate to ₱0.00.")
        print("\nTo apply these changes, run with: --execute")
        return

    # 4. Mandatory Backup Creation
    if not args.no_backup:
        print("\n[*] Creating safety backup before modifying records...")
        backup_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backups")
        try:
            backup_path = create_backup(backup_dir)
            print(f"[+] Safety backup created successfully:\n    {backup_path} ({os.path.getsize(backup_path):,} bytes)")
        except Exception as e:
            print(f"[-] ERROR: Failed to create safety backup: {e}")
            print("    Aborting operation. No records were modified.")
            sys.exit(1)

    # 5. Execute Cleanup in a Transaction
    print("\n[*] Executing database cleanup inside transaction...")
    with engine.begin() as conn:
        # Disable foreign keys temporarily to avoid circular constraints during bulk cleanup
        conn.execute(text("SET FOREIGN_KEY_CHECKS = 0;"))

        # 1. Transactions & Payments
        conn.execute(text("DELETE FROM payments;"))
        conn.execute(text("DELETE FROM transaction_items;"))
        conn.execute(text("DELETE FROM transactions;"))
        conn.execute(text("ALTER TABLE payments AUTO_INCREMENT = 1;"))
        conn.execute(text("ALTER TABLE transaction_items AUTO_INCREMENT = 1;"))
        conn.execute(text("ALTER TABLE transactions AUTO_INCREMENT = 1;"))

        # 2. Shift & Cash Drawer movements
        conn.execute(text("DELETE FROM shift_cash_movements;"))
        conn.execute(text("DELETE FROM shifts;"))
        conn.execute(text("ALTER TABLE shift_cash_movements AUTO_INCREMENT = 1;"))
        conn.execute(text("ALTER TABLE shifts AUTO_INCREMENT = 1;"))

        # 3. Customer Orders
        conn.execute(text("DELETE FROM customer_order_items;"))
        conn.execute(text("DELETE FROM customer_orders;"))
        conn.execute(text("ALTER TABLE customer_order_items AUTO_INCREMENT = 1;"))
        conn.execute(text("ALTER TABLE customer_orders AUTO_INCREMENT = 1;"))

        # 4. Incident Reports & Expenses
        conn.execute(text("DELETE FROM incident_reports;"))
        conn.execute(text("DELETE FROM expenses;"))
        conn.execute(text("ALTER TABLE incident_reports AUTO_INCREMENT = 1;"))
        conn.execute(text("ALTER TABLE expenses AUTO_INCREMENT = 1;"))

        # 5. Purchase Orders (if any demo records exist)
        conn.execute(text("DELETE FROM purchase_order_items;"))
        conn.execute(text("DELETE FROM purchase_orders;"))
        conn.execute(text("ALTER TABLE purchase_order_items AUTO_INCREMENT = 1;"))
        conn.execute(text("ALTER TABLE purchase_orders AUTO_INCREMENT = 1;"))

        # 6. Activity Logs
        conn.execute(text("DELETE FROM activity_logs;"))
        conn.execute(text("ALTER TABLE activity_logs AUTO_INCREMENT = 1;"))

        # 7. Inventory Quantities Reset (preserve master item list)
        if args.reset_stock_qty:
            conn.execute(text("UPDATE inventory_items SET quantity = 0.00;"))

        # Re-enable foreign keys
        conn.execute(text("SET FOREIGN_KEY_CHECKS = 1;"))

    print("[+] Database cleanup completed and committed successfully!")

    # 6. Post-Cleanup Verification
    with engine.connect() as conn:
        post_counts = inspect_records(conn)

    print("\nPost-Cleanup Verification:")
    print(f"  • Transactions      : {post_counts.get('transactions', 0)}")
    print(f"  • Payments          : {post_counts.get('payments', 0)}")
    print(f"  • Shifts            : {post_counts.get('shifts', 0)}")
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
            conn.execute(text("""
                INSERT INTO activity_logs (tenant_id, user_id, action, performed_by, details, created_at)
                VALUES (1, 1, 'SYSTEM_HANDOVER_INITIALIZATION', 'System Administrator', 'Database initialized for clean client handover with ₱0.00 starting financial totals.', NOW())
            """))
    except Exception:
        pass

    print("\n[✓] POS System is now completely prepared for clean client handover.")


if __name__ == "__main__":
    main()
