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
