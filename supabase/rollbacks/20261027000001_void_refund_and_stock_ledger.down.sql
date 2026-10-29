-- Rollback for 20261027000001_void_refund_and_stock_ledger.sql
-- Refuses to run if it would destroy void/refund audit data or the app's stock ledger rows. Export that
-- data first, decide what to keep, then re-run. Roll back the APPLICATION code first; the old code ignores
-- these objects, so leaving the schema in place is also a safe choice.
-- stock_movements itself is NOT dropped: it existed in the live schema before this migration.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM sale_refunds) THEN
        RAISE EXCEPTION 'sale_refunds contains refund records. Export them before rolling back.';
    END IF;
    IF EXISTS (SELECT 1 FROM transactions WHERE voided_at IS NOT NULL OR refund_status IS NOT NULL) THEN
        RAISE EXCEPTION 'Sales carry void/refund audit data. Export it before rolling back.';
    END IF;
    IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_type IN ('pos_sale', 'pos_sale_void')) THEN
        RAISE EXCEPTION 'stock_movements contains sale deductions. Export them (and reconcile stock) before rolling back.';
    END IF;
END $$;

DROP INDEX IF EXISTS uix_stock_movements_sale_reference;
DROP TABLE IF EXISTS sale_refunds;

DROP INDEX IF EXISTS ix_transactions_refund_status;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS ck_transactions_refund_status;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS fk_transactions_voided_by;
ALTER TABLE transactions DROP COLUMN IF EXISTS refund_status;
ALTER TABLE transactions DROP COLUMN IF EXISTS void_reason;
ALTER TABLE transactions DROP COLUMN IF EXISTS voided_by;
ALTER TABLE transactions DROP COLUMN IF EXISTS voided_at;
