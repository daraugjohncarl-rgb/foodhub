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
