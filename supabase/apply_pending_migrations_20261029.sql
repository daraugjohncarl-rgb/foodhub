-- Pending schema migrations for the live database, in the required order (built 2026-10-29).
--
-- WHY: the deployed code reads columns these migrations add (e.g. transactions.refund_status,
-- transactions.customer_order_id, customer_orders.payment_method). Without them the Dashboard's
-- cash-drawer card, Profit & Loss, Transactions and Customer Orders return HTTP 500
-- ("Failed to load cashier drawer data from server.").
--
-- HOW: 1) Back up the database (Supabase: Database > Backups, or pg_dump).
--      2) Paste this whole file into the Supabase SQL Editor and run it once, preferably when the shop is
--         quiet (adding columns/indexes briefly locks the tables).
--      3) The last statement prints every required column/index with present = true/false. All must be true.
--
-- SAFETY: the three files below are copied unchanged from supabase/migrations/. They are additive only (no
-- existing row is changed or deleted), idempotent (IF NOT EXISTS / constraint checks), and the SQL Editor
-- runs the script as ONE transaction: if any step fails (for example the duplicate-data pre-flight check
-- in 20261023000002), nothing is applied. Fix the reported rows and run it again.
-- Not included: 20261023000001 (baseline), 20261023000003 (RLS) and 20261023000004 (composite FKs).


-- ===================================================================================== 20261023000002_tenant_integrity_and_indexes.sql
-- Tenant integrity, uniqueness and index fixes (PostgreSQL / Supabase).
-- STATUS: PREPARED, NOT APPLIED. Review, rehearse on a copy/branch database, then apply once.
--
-- What it does (all additive or relaxing; no data is modified or deleted):
--   1. Case-insensitive uniqueness for users.username / users.email.
--   2. transactions.client_tx_id uniqueness becomes per tenant (was global).
--   3. Indexes for hot tenant-scoped filters.
--   4. Sanity CHECK constraints added NOT VALID (enforced for new/updated rows immediately;
--      existing rows are not scanned until you run VALIDATE CONSTRAINT after reviewing them).
--
-- Pre-flight: the first block aborts the whole migration with a clear message if existing data
-- would violate the new unique indexes. Fix those rows first (see the query in each message).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users GROUP BY lower(username) HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Duplicate usernames that differ only by case exist. Find them with: SELECT lower(username), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;';
    END IF;
    IF EXISTS (SELECT 1 FROM users WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Duplicate emails that differ only by case exist. Find them with: SELECT lower(email), count(*) FROM users WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1;';
    END IF;
    IF EXISTS (SELECT 1 FROM transactions WHERE client_tx_id IS NOT NULL GROUP BY tenant_id, client_tx_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Duplicate (tenant_id, client_tx_id) pairs exist in transactions.';
    END IF;
END $$;

-- 1. Case-insensitive identity uniqueness (login already compares lower(username)/lower(email)).
CREATE UNIQUE INDEX IF NOT EXISTS uix_users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS uix_users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;

-- 2. Per-tenant idempotency key. The old GLOBAL unique index could make one tenant's sale collide
--    with another tenant's client-generated id.
CREATE UNIQUE INDEX IF NOT EXISTS uix_transactions_tenant_client_tx ON transactions (tenant_id, client_tx_id);
DROP INDEX IF EXISTS ix_transactions_client_tx_id;
CREATE INDEX IF NOT EXISTS ix_transactions_client_tx_id ON transactions (client_tx_id);

-- 3. Indexes for tenant-scoped queries.
CREATE INDEX IF NOT EXISTS ix_inventory_items_tenant_id ON inventory_items (tenant_id);
CREATE INDEX IF NOT EXISTS ix_customer_orders_tenant_id ON customer_orders (tenant_id);
CREATE INDEX IF NOT EXISTS ix_customer_orders_tenant_status ON customer_orders (tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_customer_order_items_customer_order_id ON customer_order_items (customer_order_id);

-- 4. Sanity CHECK constraints (NOT VALID => existing rows are not rejected).
DO $$
DECLARE
    spec RECORD;
BEGIN
    FOR spec IN
        SELECT * FROM (VALUES
            ('transaction_items',    'ck_transaction_items_quantity_positive', 'quantity > 0'),
            ('transaction_items',    'ck_transaction_items_prices_nonneg',     'unit_price >= 0 AND total_price >= 0'),
            ('customer_order_items', 'ck_customer_order_items_quantity_positive', 'quantity > 0'),
            ('customer_order_items', 'ck_customer_order_items_price_nonneg',  'price >= 0'),
            ('transactions',         'ck_transactions_amounts_nonneg',        'total_amount >= 0 AND tax_amount >= 0 AND discount_amount >= 0 AND net_amount >= 0'),
            ('payments',             'ck_payments_amount_nonneg',             'amount >= 0'),
            ('products',             'ck_products_price_nonneg',              'price >= 0')
        ) AS t(tbl, cname, expr)
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec.cname) THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', spec.tbl, spec.cname, spec.expr);
        END IF;
    END LOOP;
END $$;

-- After reviewing existing data, validate (does not block writes; scans the table):
--   ALTER TABLE transaction_items VALIDATE CONSTRAINT ck_transaction_items_quantity_positive;
--   ... repeat for the other ck_* constraints above.

-- NOT done here (documented follow-up): composite foreign keys such as
-- (transaction_items -> products) that would make cross-tenant references impossible at the
-- database level. The application now enforces tenant ownership on every write; adding the
-- composite FKs needs UNIQUE (id, tenant_id) on the parent tables and a data audit first.


-- ===================================================================================== 20261024000001_manual_gcash_verification.sql
-- Manual GCash verification, customer payment choice, sale <-> online-order link, checkout fingerprint.
-- STATUS: PREPARED, NOT APPLIED. Rehearse on a copy/branch database first (see docs/DEPLOYMENT.md).
--
-- Additive only: new nullable/defaulted columns, one new table, new indexes. No existing row is changed
-- or deleted, and no existing column is altered. Old application code keeps working against this schema
-- (it simply ignores the new columns), so this migration can be applied BEFORE the new code is deployed.
--
-- Order of the migrations matters: 20261023000002 must already be applied. It makes the
-- (tenant_id, client_tx_id) unique index that the checkout idempotency guarantee relies on.
--
-- Legacy data: existing customer_orders keep payment_method = NULL (unknown; never assumed to be GCash)
-- and get payment_status = 'unpaid'. Nothing is back-filled to claim that an old order was paid.

-- 1. Customer's payment choice and the payment state (separate from the fulfilment `status`).
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid';

-- 2. Sale -> customer order link (at most one sale per order) and the checkout fingerprint.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_order_id INTEGER;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64);

-- 3. Manual GCash details on the payment row (cashier-reported; not confirmed by GCash).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference_no VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_received NUMERIC(10, 2);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_by INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITHOUT TIME ZONE;

-- 4. Append-only audit trail of verification attempts.
CREATE TABLE IF NOT EXISTS payment_verifications (
	id BIGSERIAL NOT NULL,
	tenant_id BIGINT NOT NULL,
	customer_order_id INTEGER NOT NULL,
	attempted_by INTEGER,
	attempted_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL,
	expected_amount NUMERIC(10, 2) NOT NULL,
	reported_amount NUMERIC(10, 2) NOT NULL,
	discrepancy_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
	reference_no VARCHAR(50),
	claimed_reference VARCHAR(50),
	transaction_time TIMESTAMP WITHOUT TIME ZONE,
	outcome VARCHAR(20) NOT NULL,
	resolution VARCHAR(20),
	resolved_by INTEGER,
	resolved_at TIMESTAMP WITHOUT TIME ZONE,
	resolution_note VARCHAR(255),
	PRIMARY KEY (id),
	CONSTRAINT uix_payment_verifications_tenant_reference UNIQUE (tenant_id, claimed_reference),
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
	FOREIGN KEY(customer_order_id) REFERENCES customer_orders (id) ON DELETE CASCADE,
	FOREIGN KEY(attempted_by) REFERENCES users (id) ON DELETE SET NULL,
	FOREIGN KEY(resolved_by) REFERENCES users (id) ON DELETE SET NULL
);

-- 5. Foreign keys for the new columns (idempotent).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_transactions_customer_order') THEN
        ALTER TABLE transactions ADD CONSTRAINT fk_transactions_customer_order
            FOREIGN KEY (customer_order_id) REFERENCES customer_orders (id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_verified_by') THEN
        ALTER TABLE payments ADD CONSTRAINT fk_payments_verified_by
            FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE SET NULL;
    END IF;
END $$;

-- 6. Indexes. Unique (tenant_id, customer_order_id): one POS sale per online order, enforced by the database
--    (NULLs are distinct, so ordinary walk-in sales are unaffected).
CREATE UNIQUE INDEX IF NOT EXISTS uix_transactions_tenant_customer_order ON transactions (tenant_id, customer_order_id);
CREATE INDEX IF NOT EXISTS ix_transactions_customer_order_id ON transactions (customer_order_id);
CREATE INDEX IF NOT EXISTS ix_payment_verifications_id ON payment_verifications (id);
CREATE INDEX IF NOT EXISTS ix_payment_verifications_tenant_id ON payment_verifications (tenant_id);
CREATE INDEX IF NOT EXISTS ix_payment_verifications_customer_order_id ON payment_verifications (customer_order_id);

-- 7. Value checks, added NOT VALID (enforced for new/updated rows; run VALIDATE CONSTRAINT after review).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_customer_orders_payment_method') THEN
        ALTER TABLE customer_orders ADD CONSTRAINT ck_customer_orders_payment_method
            CHECK (payment_method IS NULL OR payment_method IN ('GCASH', 'PAY_AT_COUNTER')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_customer_orders_payment_status') THEN
        ALTER TABLE customer_orders ADD CONSTRAINT ck_customer_orders_payment_status
            CHECK (payment_status IN ('unpaid', 'verified', 'discrepancy', 'invalid', 'counter_paid')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_payment_verifications_outcome') THEN
        ALTER TABLE payment_verifications ADD CONSTRAINT ck_payment_verifications_outcome
            CHECK (outcome IN ('matched', 'mismatch', 'duplicate_reference')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_payment_verifications_amounts') THEN
        ALTER TABLE payment_verifications ADD CONSTRAINT ck_payment_verifications_amounts
            CHECK (expected_amount >= 0 AND reported_amount > 0) NOT VALID;
    END IF;
END $$;

-- 8. Same deny-by-default posture as migration 3 for the new table: RLS on, no policies, no API-role access.
ALTER TABLE payment_verifications ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE payment_verifications FROM anon;
        REVOKE ALL ON SEQUENCE payment_verifications_id_seq FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE payment_verifications FROM authenticated;
        REVOKE ALL ON SEQUENCE payment_verifications_id_seq FROM authenticated;
    END IF;
END $$;

-- After reviewing existing data, validate (does not block writes):
--   ALTER TABLE customer_orders VALIDATE CONSTRAINT ck_customer_orders_payment_method;
--   ALTER TABLE customer_orders VALIDATE CONSTRAINT ck_customer_orders_payment_status;
--   ALTER TABLE payment_verifications VALIDATE CONSTRAINT ck_payment_verifications_outcome;
--   ALTER TABLE payment_verifications VALIDATE CONSTRAINT ck_payment_verifications_amounts;


-- ===================================================================================== 20261027000001_void_refund_and_stock_ledger.sql
-- Void audit + manual refund records for POS sales, and the stock ledger used by recipe-based deduction.
-- STATUS: PREPARED, NOT APPLIED. Rehearse on a disposable PostgreSQL database or a Supabase branch first.
--
-- Additive only: new nullable columns, one new table, a create-if-missing for stock_movements, new indexes.
-- No existing row is changed or deleted and no existing column is altered. The old application code ignores
-- all of it, so this migration can be applied BEFORE the new code is deployed.
--
-- Requires 20261024000001 (and therefore 20261023000001..4) to be applied first.
--
-- Legacy data:
--   * Sales voided before this migration keep refund_status = NULL ("unknown/not tracked"). Nothing is
--     back-filled to claim that their money was or was not returned. To list them for a manual review:
--       SELECT id, tenant_id, net_amount, status, created_at FROM transactions
--        WHERE status IN ('cancelled', 'rejected') AND refund_status IS NULL ORDER BY created_at;
--   * stock_movements already exists in the live schema (supabase_setup.sql). CREATE TABLE IF NOT EXISTS
--     leaves it untouched. The new unique index only covers rows with reference_type 'pos_sale' or
--     'pos_sale_void', which only this release writes. Check before applying (expected: 0 rows):
--       SELECT tenant_id, reference_type, reference_id, inventory_item_id, count(*) FROM stock_movements
--        WHERE reference_type IN ('pos_sale', 'pos_sale_void')
--        GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;
--   * Payment methods: drawer cash is now an exact match on upper(trim(payment_method)) = 'CASH'.
--     Review the distinct values first (historical data seen so far: CASH / Cash / cash):
--       SELECT payment_method, count(*) FROM payments GROUP BY 1 ORDER BY 2 DESC;

-- 1. Void audit and refund state on the sale (written once by the void / refund endpoints).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_by INTEGER;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS void_reason VARCHAR(255);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20);

-- 2. Manual refund records (one per voided sale; the POS never moves money itself).
CREATE TABLE IF NOT EXISTS sale_refunds (
	id BIGSERIAL NOT NULL,
	tenant_id BIGINT NOT NULL,
	transaction_id INTEGER NOT NULL,
	outcome VARCHAR(20) NOT NULL,
	amount NUMERIC(10, 2) NOT NULL,
	refund_method VARCHAR(20),
	reference_no VARCHAR(50),
	note VARCHAR(255) NOT NULL,
	recorded_by INTEGER,
	recorded_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uix_sale_refunds_tenant_transaction UNIQUE (tenant_id, transaction_id),
	CONSTRAINT ck_sale_refunds_outcome CHECK (outcome IN ('refunded', 'not_required')),
	CONSTRAINT ck_sale_refunds_amount CHECK (amount >= 0),
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
	FOREIGN KEY(transaction_id) REFERENCES transactions (id) ON DELETE CASCADE,
	FOREIGN KEY(recorded_by) REFERENCES users (id) ON DELETE SET NULL
);

-- 3. Stock ledger. Same definition as the live table; created only where it is missing (e.g. a fresh database).
CREATE TABLE IF NOT EXISTS stock_movements (
	id BIGSERIAL NOT NULL,
	tenant_id BIGINT NOT NULL,
	inventory_item_id INTEGER NOT NULL,
	movement_type VARCHAR(20) NOT NULL,
	quantity_delta NUMERIC(12, 3) NOT NULL,
	quantity_after NUMERIC(12, 3) NOT NULL,
	unit_cost NUMERIC(10, 2),
	reason VARCHAR(255),
	reference_type VARCHAR(30),
	reference_id BIGINT,
	user_id INTEGER,
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN ('OPENING', 'RECEIPT', 'SALE', 'ADJUSTMENT', 'WASTAGE', 'REVERSAL')),
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE SET NULL
);

-- 4. Foreign key and value check for the new transaction columns (idempotent; check added NOT VALID).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_transactions_voided_by') THEN
        ALTER TABLE transactions ADD CONSTRAINT fk_transactions_voided_by
            FOREIGN KEY (voided_by) REFERENCES users (id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_transactions_refund_status') THEN
        ALTER TABLE transactions ADD CONSTRAINT ck_transactions_refund_status
            CHECK (refund_status IS NULL OR refund_status IN ('pending', 'refunded', 'not_required')) NOT VALID;
    END IF;
END $$;

-- 5. Indexes. The partial unique index makes a sale's stock deduction (pos_sale) and its restoration
--    (pos_sale_void) happen at most once per inventory item, even under concurrent requests.
CREATE INDEX IF NOT EXISTS ix_transactions_refund_status ON transactions (refund_status);
CREATE INDEX IF NOT EXISTS ix_sale_refunds_id ON sale_refunds (id);
CREATE INDEX IF NOT EXISTS ix_sale_refunds_tenant_id ON sale_refunds (tenant_id);
CREATE INDEX IF NOT EXISTS ix_sale_refunds_transaction_id ON sale_refunds (transaction_id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_id ON stock_movements (id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_tenant_id ON stock_movements (tenant_id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_inventory_item_id ON stock_movements (inventory_item_id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_user_id ON stock_movements (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uix_stock_movements_sale_reference
    ON stock_movements (tenant_id, reference_type, reference_id, inventory_item_id)
    WHERE reference_type IN ('pos_sale', 'pos_sale_void');

-- 6. Same deny-by-default posture as migration 3: RLS on, no policies, no API-role access.
ALTER TABLE sale_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE sale_refunds, stock_movements FROM anon;
        REVOKE ALL ON SEQUENCE sale_refunds_id_seq, stock_movements_id_seq FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE sale_refunds, stock_movements FROM authenticated;
        REVOKE ALL ON SEQUENCE sale_refunds_id_seq, stock_movements_id_seq FROM authenticated;
    END IF;
END $$;

-- After reviewing existing data, validate (does not block writes):
--   ALTER TABLE transactions VALIDATE CONSTRAINT ck_transactions_refund_status;


-- ===================================================================================== verification (read-only)
SELECT 'column' AS kind, r.tbl || '.' || r.name AS object,
       EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND c.column_name = r.name) AS present
  FROM (VALUES ('customer_orders', 'payment_method'), ('customer_orders', 'payment_status'),
               ('transactions', 'customer_order_id'), ('transactions', 'request_fingerprint'),
               ('transactions', 'voided_at'), ('transactions', 'voided_by'),
               ('transactions', 'void_reason'), ('transactions', 'refund_status'),
               ('payments', 'reference_no'), ('payments', 'amount_received'),
               ('payments', 'verified_by'), ('payments', 'verified_at')) AS r(tbl, name)
UNION ALL
SELECT 'index', r.name, EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = r.name)
  FROM (VALUES ('uix_transactions_tenant_client_tx'), ('uix_transactions_tenant_customer_order'),
               ('uix_stock_movements_sale_reference')) AS r(name)
UNION ALL
SELECT 'table', r.name, EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_name = r.name)
  FROM (VALUES ('payment_verifications'), ('sale_refunds'), ('stock_movements')) AS r(name)
ORDER BY 1, 2;
