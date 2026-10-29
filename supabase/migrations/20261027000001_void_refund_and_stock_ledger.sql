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
