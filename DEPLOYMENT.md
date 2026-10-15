# Deploying the audit fixes

This release changes the database schema and tightens security. **Nothing here runs automatically**: the app no
longer creates or alters tables on start-up, and it refuses to start while the database schema is older than the
code. Follow the steps in order. Every command below is meant to be run by a person, after reading it.

Commands run from the `fastapi/` directory with the production `DATABASE_URL` (or `DB_*`) set in the shell, never
committed to a file.

## 0. Which database does this apply to?

This repository (`main`) is the **PostgreSQL** application (psycopg driver, Render managed PostgreSQL). The
`backup-before-pull` branch is a separate, unrelated **MariaDB/MySQL** application (PyMySQL, port 3307,
`db_guard.py`). These migrations and this guide do **not** apply to a MariaDB database. Confirm which system holds
the live sales before going further.

## 1. Before you start

1. **Backup** the production database and check you can restore it:
   ```bash
   pg_dump --format=custom --no-owner "$DATABASE_URL" > inbox_pos_$(date +%Y%m%d_%H%M).dump
   pg_restore --list inbox_pos_*.dump | head          # sanity check
   ```
   Keep the dump outside the repository (`*.dump` and `backups/` are git-ignored).
2. **Read-only checks that the database matches the 0001 baseline** (run these with a read-only session; every
   query must return the stated result, otherwise stop — stamping a database that is older than the baseline is
   wrong, and migration 0002 refuses to run on it):
   ```sql
   SELECT to_regclass('restaurant_tables') IS NOT NULL;                                     -- t
   SELECT count(*) FROM information_schema.columns
    WHERE (table_name, column_name) IN (('customer_orders','tenant_id'), ('customer_order_items','product_id'),
                                        ('products','image_url'));                          -- 3
   SELECT role::text, count(*) FROM users
    WHERE role::text NOT IN ('SUPER_ADMIN','ADMIN','MANAGER','CASHIER','INVENTORY','KITCHEN') GROUP BY 1;  -- no rows
   SELECT lower(username), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;            -- no rows
   SELECT tenant_id, table_number, count(*) FROM restaurant_tables GROUP BY 1, 2 HAVING count(*) > 1;  -- no rows
   SELECT to_regclass('alembic_version');                                                  -- NULL (never stamped)
   ```
   The local backup from 2026-09-05 does **not** pass the first two checks (it predates `restaurant_tables` and the
   customer-order columns), and its `userrole` type has an extra `CUSTOMER` value. Users with that role must be
   reassigned or deactivated first (a business decision).
3. **Decide the legacy timezones, from evidence** (migration 0002 converts every timestamp to `TIMESTAMPTZ` and
   refuses to run on a database with data unless both are set):
   * `LEGACY_DB_TIMEZONE` — the PostgreSQL server's zone, which `now()` defaults used. Evidence:
     `SHOW timezone;` on that server, and `SELECT now()::timestamp, now() AT TIME ZONE 'UTC';` to see the offset.
     If the setting could have changed over time, compare a recent row's `created_at` with a sale you can date
     from a receipt.
   * `LEGACY_APP_TIMEZONE` — the OS zone of the machine that ran the old app (`purchase_orders.received_date` came
     from Python's local clock). Render containers run in UTC; this Windows PC is UTC+8 (Singapore Standard Time).
   * `shifts.end_time` was written in UTC by the old code and is converted as UTC regardless.
   * Typical values: Render-hosted app and database → `UTC` / `UTC`. Local PostgreSQL on this PC with the app
     also running here → `Asia/Singapore` (or `Asia/Manila`, same offset) for both. Verify; do not guess.
4. Migration 0002 inspects the live schema (constraint names differ between databases), so it cannot be
   previewed with `--sql`. Rehearse it on a staging copy instead (section 2).

## 2. Staging rehearsal (strongly recommended)

1. Restore the production dump into a **staging** database (never the other way round):
   ```bash
   createdb inbox_pos_staging
   pg_restore --no-owner --dbname=inbox_pos_staging inbox_pos_YYYYMMDD_HHMM.dump
   ```
2. Point a shell at staging and migrate it:
   ```bash
   export DATABASE_URL=postgresql+psycopg://USER@HOST/inbox_pos_staging
   alembic stamp 0001_baseline          # once: marks the pre-Alembic schema as the baseline
   LEGACY_DB_TIMEZONE=<from step 1.3> LEGACY_APP_TIMEZONE=<from step 1.3> alembic upgrade head
   alembic check                        # must print "No new upgrade operations detected."
   ```
3. Start the app against staging with `APP_ENV=staging` and a strong `JWT_SECRET`, then verify:
   * `GET /health` returns `{"status":"ok"}`.
   * Log in as each role; managers/admins see today's sales on the dashboard; a cashier can only see their own sales.
   * Ring up a sale: the POS asks for the opening cash once, the sale appears immediately in the dashboard revenue.
   * Kitchen: tickets show "Table N" / "Take Out"; marking READY does not change revenue.
   * Customer QR page (`/customer?tenant_id=1&table=1`) loads the menu and can place an order.
   * Purchases: Draft → Mark Ordered → Receive (stock increases once); Wastage records persist and deduct stock.
   * Old sales still show the right local time (spot-check a few receipts against the paper trail).
4. Run the automated suite against a **separate** disposable database:
   `TEST_DATABASE_URL=postgresql+psycopg://USER@HOST/inbox_pos_test python -m pytest`.

## 3. Production

1. Announce a maintenance window. **The old code must be stopped before the migration and must never run against
   the migrated database**: rehearsal showed it can still delete a user together with their sales (its ORM cascade
   removes the transactions before the new RESTRICT foreign key is checked) and it writes naive local/UTC times
   into the new TIMESTAMPTZ columns. The new code refuses to start on the old schema, so the only safe order is:
   stop old service -> backup -> migrate -> deploy new code -> start.
   `render.yaml` sets `autoDeploy: false` so a push to `main` cannot deploy before the migration; if the Render
   service is not managed by the blueprint, switch Auto-Deploy off in its settings by hand.
2. Set the new environment variables on the service (Render → Environment):
   * `APP_ENV=production` (an unset `APP_ENV` is also treated as production)
   * `JWT_SECRET` — **rotate it now** (new random value, ≥ 32 chars). The old hard-coded fallback secret was
     public; any token signed with it is forged. Rotating logs everyone out once.
   * Optional: `CORS_ALLOWED_ORIGINS` (only if another site calls the API), `TAX_RATE`, `BUSINESS_TIMEZONE`.
   * If there is no SUPER_ADMIN yet: `INITIAL_SUPERADMIN_PASSWORD` for one start-up, then delete it.
3. Stop the service (Render: suspend), take the backup from step 1.1 again, then:
   ```bash
   alembic current                      # expect: nothing (pre-Alembic database)
   alembic stamp 0001_baseline        # only after every check in step 1.2 passed
   LEGACY_DB_TIMEZONE=<zone> LEGACY_APP_TIMEZONE=<zone> alembic upgrade head
   alembic current                      # expect: 0002_audit_fixes (head)
   ```
4. Deploy the new code and resume the service. Start-up logs show `APP_ENV=production` and the database
   engine/host/name (never credentials). If the schema is behind, start-up stops with instructions instead of
   serving errors.
5. Smoke test: `/health`, one login per role, one sale, one kitchen status change, the customer menu.
6. Tell staff:
   * Everyone must log in again (secret rotated).
   * Accounts created or reset by an admin must choose a new password (≥ 10 characters) at first login.
   * Cashiers start each shift with the opening cash and close it with the counted cash (END SHIFT button).
   * Old default passwords (`admin123`, `cashier123`, …): change them now if those accounts still exist.

## 4. Rollback

* Code only, schema untouched: redeploy the previous release **and** restore the pre-migration backup (the old
  code cannot read the new schema).
* `alembic downgrade 0001_baseline` exists for the schema changes, but it drops the new columns and table (wastage
  records, stock ledger, shift reconciliation). Prefer restoring the backup.

## 5. Things this release deliberately does not do

* It does not modify existing sales: `transactions.status` keeps its legacy values. Revenue counts every sale that is
  not voided/cancelled/refunded, which includes legacy `pending`/`preparing`/`ready` rows (they were all paid when
  they were rung up). The new `fulfillment_status` column is backfilled from the legacy kitchen state.
* It does not rename existing products. The seed menu renamed only the copies that the old seeding always skipped
  (e.g. "Mango Frappe — 16 oz"); demo/menu seeding is off in production unless `SEED_DEMO_DATA=true`.
* It does not change product images (see FIXES_NEEDED.md, L5).
