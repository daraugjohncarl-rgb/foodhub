"""audit fixes: tenant-scoped uniqueness, payment/fulfilment split, stock ledger, auth hardening, UTC timestamps

Revision ID: 0002_audit_fixes
Revises: 0001_baseline
Create Date: 2026-10-16

What it does (see FIXES_NEEDED.md for the findings):
  * Pre-flight: aborts, before changing anything, if the database is not at the schema 0001_baseline describes
    (tables/columns added by the pre-Alembic scripts are missing), if users hold a role the code does not know
    (the legacy 'CUSTOMER' enum value), or if existing data would violate a new unique constraint
    (usernames differing only by case, duplicate table numbers per tenant).
  * Converts every naive TIMESTAMP column to TIMESTAMPTZ (M2). The old code wrote naive timestamps from three
    different clocks, so each column is interpreted in the zone of the clock that wrote it:
        db  - PostgreSQL now() defaults (and client dates PostgreSQL converted on insert): the database server's
              `timezone` setting at the time  -> LEGACY_DB_TIMEZONE   (run `SHOW timezone` on that server)
        app - Python datetime.now() in the app process: the app server's OS zone -> LEGACY_APP_TIMEZONE
        utc - Python datetime.utcnow(): always UTC (shifts.end_time)
    When the database holds any rows both variables MUST be set explicitly; there is no silent default.
    (LEGACY_TIMESTAMP_TZ is accepted as an alias of LEGACY_DB_TIMEZONE.)
  * users: token_version, must_change_password, failed_login_attempts, locked_until; case-insensitive unique username. H9/M11
  * transactions: fulfillment_status (backfilled from the legacy kitchen status, the existing status column is left
    untouched), order_type, table_number, customer_order_id, amount_tendered, change_amount; client_tx_id unique per
    tenant instead of globally. C6/C8/M1/M9
  * shifts: expected_cash, cash_variance. M3
  * inventory_items: item_type, is_active. M5/H7
  * customer_orders: order_number unique per tenant, tracking_token, status check (NOT VALID: legacy rows are not
    re-checked). C1/M9
  * restaurant_tables: unique (tenant_id, table_number). M10
  * Foreign keys from financial tables (transactions, shifts, shift_cash_movements) become ON DELETE RESTRICT so a
    deleted user or tenant can never take sales history with it. C5
  * New table stock_movements. M6/M12

Only new columns are backfilled; no existing value in any existing column is modified except the TIMESTAMP ->
TIMESTAMPTZ type conversion.
"""
import os
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002_audit_fixes"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# table -> {column: clock that wrote it in the pre-migration code}. See the module docstring.
TIMESTAMP_COLUMNS = {
    "tenants": {"created_at": "db"},
    "users": {"created_at": "db", "updated_at": "db"},
    "activity_logs": {"created_at": "db"},
    "categories": {"created_at": "db", "updated_at": "db"},
    "products": {"created_at": "db", "updated_at": "db"},
    "inventory_items": {"created_at": "db", "updated_at": "db"},
    "shifts": {"start_time": "db", "end_time": "utc", "created_at": "db", "updated_at": "db"},
    "transactions": {"created_at": "db"},
    "payments": {"created_at": "db"},
    "shift_cash_movements": {"created_at": "db"},
    "incident_reports": {"created_at": "db", "updated_at": "db"},
    "suppliers": {"created_at": "db", "updated_at": "db"},
    # expected_delivery_date arrives from the UI as an aware UTC instant, which PostgreSQL converted to the
    # session zone when storing it in a naive column; received_date came from Python's naive datetime.now().
    "purchase_orders": {"order_date": "db", "expected_delivery_date": "db", "received_date": "app",
                        "created_at": "db", "updated_at": "db"},
    "customer_orders": {"created_at": "db"},
}

# Objects the 0001 baseline describes that older databases only gained through the pre-Alembic scripts
# (migrate_customer_orders.py) or a later start-up's create_all. Stamping a database without them is wrong.
BASELINE_REQUIREMENTS = [
    ("restaurant_tables", None),
    ("customer_orders", "tenant_id"),
    ("customer_order_items", "product_id"),
    ("products", "image_url"),
]

RESTRICT_FKS = [
    # (table, column, referred table)
    ("transactions", "tenant_id", "tenants"),
    ("shifts", "tenant_id", "tenants"),
    ("shift_cash_movements", "tenant_id", "tenants"),
    ("shift_cash_movements", "shift_id", "shifts"),
    ("shift_cash_movements", "user_id", "users"),
]


def _has_rows(bind) -> bool:
    for table in TIMESTAMP_COLUMNS:
        if bind.execute(sa.text(f'SELECT EXISTS (SELECT 1 FROM "{table}")')).scalar():
            return True
    return False


def _legacy_zones(bind) -> dict:
    """{'db': zone, 'app': zone, 'utc': 'UTC'}; explicit configuration is required when there is data."""
    db_zone = os.getenv("LEGACY_DB_TIMEZONE") or os.getenv("LEGACY_TIMESTAMP_TZ")
    app_zone = os.getenv("LEGACY_APP_TIMEZONE")
    if not (db_zone and app_zone):
        if _has_rows(bind):
            raise RuntimeError(
                "Migration 0002 aborted before making any change: this database contains data, so set both\n"
                "  LEGACY_DB_TIMEZONE  = the PostgreSQL server's timezone when the data was written (SHOW timezone)\n"
                "  LEGACY_APP_TIMEZONE = the OS timezone of the machine that ran the old app (Render: UTC)\n"
                "See DEPLOYMENT.md, 'Decide the legacy timezones'."
            )
        db_zone = db_zone or "UTC"
        app_zone = app_zone or "UTC"
    for name, zone in (("LEGACY_DB_TIMEZONE", db_zone), ("LEGACY_APP_TIMEZONE", app_zone)):
        known = bind.execute(sa.text("SELECT 1 FROM pg_timezone_names WHERE name = :n"), {"n": zone}).scalar()
        if not known and zone != "UTC":
            raise RuntimeError(f"{name}='{zone}' is not a PostgreSQL timezone name.")
    return {"db": db_zone, "app": app_zone, "utc": "UTC"}


def _column_type(bind, table: str, column: str):
    return bind.execute(
        sa.text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :t AND column_name = :c"
        ),
        {"t": table, "c": column},
    ).scalar()


def _has_column(bind, table: str, column: str) -> bool:
    return _column_type(bind, table, column) is not None


def _fk_name(bind, table: str, column: str, referred: str):
    return bind.execute(
        sa.text(
            """
            SELECT tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()
              AND tc.table_name = :t AND kcu.column_name = :c AND ccu.table_name = :r
            """
        ),
        {"t": table, "c": column, "r": referred},
    ).scalar()


def _unique_indexes_on(bind, table: str, column: str):
    """Names of single-column UNIQUE indexes (not constraints) on table(column)."""
    rows = bind.execute(
        sa.text(
            """
            SELECT i.relname
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_class t ON t.oid = x.indrelid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(x.indkey)
            WHERE t.relname = :t AND a.attname = :c AND x.indisunique AND NOT x.indisprimary
              AND array_length(x.indkey, 1) = 1
              AND NOT EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conindid = x.indexrelid)
            """
        ),
        {"t": table, "c": column},
    ).fetchall()
    return [r[0] for r in rows]


def _unique_constraints_on(bind, table: str, column: str):
    rows = bind.execute(
        sa.text(
            """
            SELECT pc.conname
            FROM pg_constraint pc
            JOIN pg_class t ON t.oid = pc.conrelid
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(pc.conkey)
            WHERE t.relname = :t AND a.attname = :c AND pc.contype = 'u' AND array_length(pc.conkey, 1) = 1
            """
        ),
        {"t": table, "c": column},
    ).fetchall()
    return [r[0] for r in rows]


def _index_exists(bind, name: str) -> bool:
    return bool(bind.execute(sa.text("SELECT 1 FROM pg_class WHERE relname = :n AND relkind = 'i'"), {"n": name}).scalar())


def _constraint_exists(bind, name: str) -> bool:
    return bool(bind.execute(sa.text("SELECT 1 FROM pg_constraint WHERE conname = :n"), {"n": name}).scalar())


def _preflight(bind) -> None:
    problems = []
    for table, column in BASELINE_REQUIREMENTS:
        exists = (bind.execute(sa.text("SELECT to_regclass(:t)"), {"t": table}).scalar() is not None
                  if column is None else _has_column(bind, table, column))
        if not exists:
            problems.append(
                f"{table}{'.' + column if column else ''} is missing: this database is older than the 0001 baseline "
                "(it was stamped too early). Do not continue; see DEPLOYMENT.md."
            )
    if problems:   # the checks below need these objects
        raise RuntimeError("Migration 0002 aborted before making any change:\n  - " + "\n  - ".join(problems))
    unknown_roles = bind.execute(sa.text(
        "SELECT role::text, count(*) FROM users WHERE role::text NOT IN "
        "('SUPER_ADMIN','ADMIN','MANAGER','CASHIER','INVENTORY','KITCHEN') GROUP BY 1"
    )).fetchall()
    if unknown_roles:
        problems.append(
            "users with roles this code does not support: "
            + ", ".join(f"{r} ({n})" for r, n in unknown_roles)
            + ". Reassign or deactivate them first."
        )
    dup_users = bind.execute(
        sa.text("SELECT lower(username), count(*) FROM users GROUP BY lower(username) HAVING count(*) > 1")
    ).fetchall()
    if dup_users:
        problems.append(
            f"{len(dup_users)} username(s) differ only by letter case (e.g. 'Admin' and 'admin'). Rename them first."
        )
    dup_tables = bind.execute(
        sa.text(
            "SELECT tenant_id, table_number, count(*) FROM restaurant_tables "
            "GROUP BY tenant_id, table_number HAVING count(*) > 1"
        )
    ).fetchall()
    if dup_tables:
        problems.append(f"{len(dup_tables)} duplicate table number(s) within a branch. Remove the duplicates first.")
    if problems:
        raise RuntimeError("Migration 0002 aborted before making any change:\n  - " + "\n  - ".join(problems))


def upgrade() -> None:
    from alembic import context
    if context.is_offline_mode():
        raise RuntimeError("Migration 0002 inspects the live schema and cannot be rendered with --sql. "
                           "Rehearse it on a staging copy of the database instead (DEPLOYMENT.md).")
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        raise RuntimeError("Migration 0002 supports PostgreSQL only.")

    _preflight(bind)
    zones = _legacy_zones(bind)

    # 1. Timestamps -> TIMESTAMPTZ (M2): each column in the zone of the clock that wrote it.
    for table, columns in TIMESTAMP_COLUMNS.items():
        for column, clock in columns.items():
            if _column_type(bind, table, column) == "timestamp without time zone":
                op.execute(
                    sa.text(
                        f'ALTER TABLE "{table}" ALTER COLUMN "{column}" TYPE TIMESTAMPTZ '
                        f"USING \"{column}\" AT TIME ZONE '{zones[clock]}'"
                    )
                )

    # 2. users (H9, M11)
    if not _has_column(bind, "users", "token_version"):
        op.add_column("users", sa.Column("token_version", sa.Integer(), server_default="0", nullable=False))
    if not _has_column(bind, "users", "must_change_password"):
        op.add_column("users", sa.Column("must_change_password", sa.Boolean(), server_default=sa.false(), nullable=False))
    if not _has_column(bind, "users", "failed_login_attempts"):
        op.add_column("users", sa.Column("failed_login_attempts", sa.Integer(), server_default="0", nullable=False))
    if not _has_column(bind, "users", "locked_until"):
        op.add_column("users", sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True))
    if not _index_exists(bind, "uix_users_username_lower"):
        op.execute("CREATE UNIQUE INDEX uix_users_username_lower ON users (lower(username))")

    # 3. inventory_items (H7, M5)
    if not _has_column(bind, "inventory_items", "item_type"):
        op.add_column(
            "inventory_items", sa.Column("item_type", sa.String(20), server_default="consumable", nullable=False)
        )
    if not _has_column(bind, "inventory_items", "is_active"):
        op.add_column("inventory_items", sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False))
    if not _constraint_exists(bind, "check_inventory_item_type"):
        op.create_check_constraint(
            "check_inventory_item_type", "inventory_items", "item_type IN ('consumable', 'equipment')"
        )

    # 4. shifts (M3)
    if not _has_column(bind, "shifts", "expected_cash"):
        op.add_column("shifts", sa.Column("expected_cash", sa.Numeric(10, 2), nullable=True))
    if not _has_column(bind, "shifts", "cash_variance"):
        op.add_column("shifts", sa.Column("cash_variance", sa.Numeric(10, 2), nullable=True))

    # 5. customer_orders (C1, M9)
    if not _has_column(bind, "customer_orders", "tracking_token"):
        op.add_column("customer_orders", sa.Column("tracking_token", sa.String(64), nullable=True))
        op.create_unique_constraint("uix_customer_orders_tracking_token", "customer_orders", ["tracking_token"])
    for name in _unique_indexes_on(bind, "customer_orders", "order_number"):
        op.drop_index(name, table_name="customer_orders")
    for name in _unique_constraints_on(bind, "customer_orders", "order_number"):
        op.drop_constraint(name, "customer_orders", type_="unique")
    if not _index_exists(bind, "ix_customer_orders_order_number"):
        op.create_index("ix_customer_orders_order_number", "customer_orders", ["order_number"])
    if not _constraint_exists(bind, "uix_tenant_customer_order_number"):
        op.create_unique_constraint(
            "uix_tenant_customer_order_number", "customer_orders", ["tenant_id", "order_number"]
        )
    if not _index_exists(bind, "ix_customer_orders_tenant_id"):
        op.create_index("ix_customer_orders_tenant_id", "customer_orders", ["tenant_id"])
    if not _constraint_exists(bind, "check_customer_order_status"):
        op.execute(
            "ALTER TABLE customer_orders ADD CONSTRAINT check_customer_order_status "
            "CHECK (status IN ('pending', 'accepted', 'rejected', 'completed')) NOT VALID"
        )

    # 6. transactions (C6, C8, M1, M9)
    new_tx_columns = [
        sa.Column("amount_tendered", sa.Numeric(10, 2), nullable=True),
        sa.Column("change_amount", sa.Numeric(10, 2), nullable=True),
        sa.Column("fulfillment_status", sa.String(20), server_default="pending", nullable=False),
        sa.Column("order_type", sa.String(20), nullable=True),
        sa.Column("table_number", sa.String(50), nullable=True),
        sa.Column("customer_order_id", sa.Integer(), nullable=True),
    ]
    added_fulfillment = False
    for column in new_tx_columns:
        if not _has_column(bind, "transactions", column.name):
            op.add_column("transactions", column)
            added_fulfillment = added_fulfillment or column.name == "fulfillment_status"
    if added_fulfillment:
        # Backfill the NEW column from the legacy kitchen state; transactions.status itself is not modified.
        op.execute(
            "UPDATE transactions SET fulfillment_status = lower(status) "
            "WHERE lower(status) IN ('preparing', 'ready', 'completed', 'cancelled')"
        )
    if not _fk_name(bind, "transactions", "customer_order_id", "customer_orders"):
        op.create_foreign_key(
            "fk_transactions_customer_order_id", "transactions", "customer_orders",
            ["customer_order_id"], ["id"], ondelete="SET NULL",
        )
    if not _index_exists(bind, "ix_transactions_customer_order_id"):
        op.create_index("ix_transactions_customer_order_id", "transactions", ["customer_order_id"])
    for name in _unique_indexes_on(bind, "transactions", "client_tx_id"):
        op.drop_index(name, table_name="transactions")
    for name in _unique_constraints_on(bind, "transactions", "client_tx_id"):
        op.drop_constraint(name, "transactions", type_="unique")
    if not _index_exists(bind, "ix_transactions_client_tx_id"):
        op.create_index("ix_transactions_client_tx_id", "transactions", ["client_tx_id"])
    if not _constraint_exists(bind, "uix_tenant_client_tx_id"):
        op.create_unique_constraint("uix_tenant_client_tx_id", "transactions", ["tenant_id", "client_tx_id"])
    if not _index_exists(bind, "ix_transactions_tenant_created"):
        op.create_index("ix_transactions_tenant_created", "transactions", ["tenant_id", "created_at"])
    if not _constraint_exists(bind, "check_transaction_fulfillment_status"):
        op.create_check_constraint(
            "check_transaction_fulfillment_status", "transactions",
            "fulfillment_status IN ('pending', 'preparing', 'ready', 'completed', 'cancelled')",
        )

    # 7. restaurant_tables (M10)
    if not _constraint_exists(bind, "uix_tenant_table_number"):
        op.create_unique_constraint("uix_tenant_table_number", "restaurant_tables", ["tenant_id", "table_number"])

    # 8. Financial foreign keys -> RESTRICT (C5)
    for table, column, referred in RESTRICT_FKS:
        name = _fk_name(bind, table, column, referred)
        if name:
            op.drop_constraint(name, table, type_="foreignkey")
        op.create_foreign_key(f"{table}_{column}_fkey", table, referred, [column], ["id"], ondelete="RESTRICT")

    # 9. stock_movements (M6, M12)
    if not bind.execute(sa.text("SELECT to_regclass('stock_movements')")).scalar():
        op.create_table(
            "stock_movements",
            sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
            sa.Column("tenant_id", sa.BigInteger(), nullable=False),
            sa.Column("inventory_item_id", sa.Integer(), nullable=False),
            sa.Column("movement_type", sa.String(20), nullable=False),
            sa.Column("quantity_delta", sa.Numeric(12, 3), nullable=False),
            sa.Column("quantity_after", sa.Numeric(12, 3), nullable=False),
            sa.Column("unit_cost", sa.Numeric(10, 2), nullable=True),
            sa.Column("reason", sa.String(255), nullable=True),
            sa.Column("reference_type", sa.String(30), nullable=True),
            sa.Column("reference_id", sa.BigInteger(), nullable=True),
            sa.Column("user_id", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.CheckConstraint(
                "movement_type IN ('OPENING', 'RECEIPT', 'SALE', 'ADJUSTMENT', 'WASTAGE', 'REVERSAL')",
                name="check_stock_movement_type",
            ),
            sa.ForeignKeyConstraint(["inventory_item_id"], ["inventory_items.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_stock_movements_id", "stock_movements", ["id"])
        op.create_index("ix_stock_movements_tenant_id", "stock_movements", ["tenant_id"])
        op.create_index("ix_stock_movements_inventory_item_id", "stock_movements", ["inventory_item_id"])
        op.create_index(
            "ix_stock_movements_tenant_type_created", "stock_movements", ["tenant_id", "movement_type", "created_at"]
        )


def downgrade() -> None:
    """
    Reverses the schema changes. Data written into the new columns/table after the upgrade is lost, and
    per-tenant order numbers / client_tx_ids that collide across tenants will block re-adding the global unique
    indexes. Take a backup first; never run this against production without a reviewed plan.
    """
    bind = op.get_bind()
    zones = _legacy_zones(bind)

    op.drop_table("stock_movements")

    for table, column, referred in RESTRICT_FKS:
        name = _fk_name(bind, table, column, referred)
        if name:
            op.drop_constraint(name, table, type_="foreignkey")
        op.create_foreign_key(f"{table}_{column}_fkey", table, referred, [column], ["id"], ondelete="CASCADE")

    op.drop_constraint("uix_tenant_table_number", "restaurant_tables", type_="unique")

    op.drop_constraint("check_transaction_fulfillment_status", "transactions", type_="check")
    op.drop_index("ix_transactions_tenant_created", table_name="transactions")
    op.drop_constraint("uix_tenant_client_tx_id", "transactions", type_="unique")
    op.drop_index("ix_transactions_client_tx_id", table_name="transactions")
    op.create_index("ix_transactions_client_tx_id", "transactions", ["client_tx_id"], unique=True)
    op.drop_index("ix_transactions_customer_order_id", table_name="transactions")
    op.drop_constraint("fk_transactions_customer_order_id", "transactions", type_="foreignkey")
    for column in ("customer_order_id", "table_number", "order_type", "fulfillment_status", "change_amount",
                   "amount_tendered"):
        op.drop_column("transactions", column)

    op.drop_constraint("check_customer_order_status", "customer_orders", type_="check")
    op.drop_index("ix_customer_orders_tenant_id", table_name="customer_orders")
    op.drop_constraint("uix_tenant_customer_order_number", "customer_orders", type_="unique")
    op.drop_index("ix_customer_orders_order_number", table_name="customer_orders")
    op.create_index("ix_customer_orders_order_number", "customer_orders", ["order_number"], unique=True)
    op.drop_constraint("uix_customer_orders_tracking_token", "customer_orders", type_="unique")
    op.drop_column("customer_orders", "tracking_token")

    op.drop_column("shifts", "cash_variance")
    op.drop_column("shifts", "expected_cash")

    op.drop_constraint("check_inventory_item_type", "inventory_items", type_="check")
    op.drop_column("inventory_items", "is_active")
    op.drop_column("inventory_items", "item_type")

    op.execute("DROP INDEX IF EXISTS uix_users_username_lower")
    for column in ("locked_until", "failed_login_attempts", "must_change_password", "token_version"):
        op.drop_column("users", column)

    for table, columns in TIMESTAMP_COLUMNS.items():
        for column, clock in columns.items():
            op.execute(
                sa.text(
                    f'ALTER TABLE "{table}" ALTER COLUMN "{column}" TYPE TIMESTAMP '
                    f"USING \"{column}\" AT TIME ZONE '{zones[clock]}'"
                )
            )
