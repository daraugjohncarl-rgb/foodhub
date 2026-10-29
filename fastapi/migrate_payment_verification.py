"""
Local-development schema upgrade for manual GCash verification (MySQL / XAMPP, PostgreSQL or SQLite).

`create_all()` creates new tables but never adds columns to existing ones, so a developer database
created before this feature needs the new columns once. Production uses the reviewed SQL in
supabase/migrations/20261024000001_manual_gcash_verification.sql and
supabase/migrations/20261027000001_void_refund_and_stock_ledger.sql instead; do not use this script there.
New tables (payment_verifications, sale_refunds, stock_movements) are created from the models.

Usage (from the fastapi/ folder, with the same .env the app uses):
    python migrate_payment_verification.py            # dry run: prints what would change
    python migrate_payment_verification.py --apply    # applies it
"""
import sys

from sqlalchemy import inspect, text

from app.db import engine, Base
import app.models  # noqa: F401  (registers the tables)

NEW_COLUMNS = {
    "customer_orders": [
        ("payment_method", "VARCHAR(20) NULL"),
        ("payment_status", "VARCHAR(20) NOT NULL DEFAULT 'unpaid'"),
    ],
    "transactions": [
        ("customer_order_id", "INTEGER NULL"),
        ("request_fingerprint", "VARCHAR(64) NULL"),
        ("voided_at", "TIMESTAMP NULL"),
        ("voided_by", "INTEGER NULL"),
        ("void_reason", "VARCHAR(255) NULL"),
        ("refund_status", "VARCHAR(20) NULL"),
    ],
    "payments": [
        ("reference_no", "VARCHAR(50) NULL"),
        ("amount_received", "NUMERIC(10, 2) NULL"),
        ("verified_by", "INTEGER NULL"),
        ("verified_at", "TIMESTAMP NULL"),
    ],
}

NEW_INDEXES = [
    ("uix_transactions_tenant_customer_order", "CREATE UNIQUE INDEX uix_transactions_tenant_customer_order ON transactions (tenant_id, customer_order_id)"),
    ("ix_transactions_customer_order_id", "CREATE INDEX ix_transactions_customer_order_id ON transactions (customer_order_id)"),
]


def main(apply: bool) -> int:
    if engine.dialect.name == "postgresql" and "supabase" in str(engine.url.host or ""):
        print("Refusing to run against a hosted Supabase database. Apply the reviewed SQL migration instead.")
        return 2
    inspector = inspect(engine)
    plan = []
    for table, columns in NEW_COLUMNS.items():
        if not inspector.has_table(table):
            continue
        existing = {c["name"] for c in inspector.get_columns(table)}
        plan += [(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}") for name, ddl in columns if name not in tuple(existing)]
    for name, ddl in NEW_INDEXES:
        if inspector.has_table("transactions") and name not in {i["name"] for i in inspector.get_indexes("transactions")}:
            plan.append(ddl)
    for table in ("payment_verifications", "sale_refunds", "stock_movements"):
        if not inspector.has_table(table):
            plan.append(f"(create table {table} via SQLAlchemy metadata)")

    if not plan:
        print("Schema is already up to date.")
        return 0
    print("Planned changes:" if not apply else "Applying:")
    for step in plan:
        print("  -", step)
    if not apply:
        print("\nDry run only. Re-run with --apply to execute.")
        return 0
    with engine.begin() as conn:
        for step in plan:
            if not step.startswith("("):
                conn.execute(text(step))
    Base.metadata.create_all(bind=engine)   # creates payment_verifications / sale_refunds / stock_movements if missing
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
