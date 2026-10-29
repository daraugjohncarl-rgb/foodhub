-- Rollback for 20261024000001_manual_gcash_verification.sql
-- Refuses to run if it would destroy audit or payment data. Export that data first, decide what to keep,
-- then re-run. Roll back the APPLICATION code first; the old code ignores these columns, so leaving the
-- schema in place is also a safe choice.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM payment_verifications) THEN
        RAISE EXCEPTION 'payment_verifications contains verification history. Export it (e.g. COPY payment_verifications TO ...) before rolling back.';
    END IF;
    IF EXISTS (SELECT 1 FROM transactions WHERE customer_order_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Sales are linked to online orders (transactions.customer_order_id). Export the links before rolling back.';
    END IF;
    IF EXISTS (SELECT 1 FROM payments WHERE reference_no IS NOT NULL OR verified_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Payments carry GCash verification data. Export it before rolling back.';
    END IF;
    IF EXISTS (SELECT 1 FROM customer_orders WHERE payment_method IS NOT NULL) THEN
        RAISE EXCEPTION 'Customer orders carry a payment choice. Export it before rolling back.';
    END IF;
END $$;

DROP TABLE IF EXISTS payment_verifications;

ALTER TABLE customer_orders DROP CONSTRAINT IF EXISTS ck_customer_orders_payment_method;
ALTER TABLE customer_orders DROP CONSTRAINT IF EXISTS ck_customer_orders_payment_status;
DROP INDEX IF EXISTS uix_transactions_tenant_customer_order;
DROP INDEX IF EXISTS ix_transactions_customer_order_id;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS fk_transactions_customer_order;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS fk_payments_verified_by;

ALTER TABLE payments DROP COLUMN IF EXISTS verified_at;
ALTER TABLE payments DROP COLUMN IF EXISTS verified_by;
ALTER TABLE payments DROP COLUMN IF EXISTS amount_received;
ALTER TABLE payments DROP COLUMN IF EXISTS reference_no;
ALTER TABLE transactions DROP COLUMN IF EXISTS request_fingerprint;
ALTER TABLE transactions DROP COLUMN IF EXISTS customer_order_id;
ALTER TABLE customer_orders DROP COLUMN IF EXISTS payment_status;
ALTER TABLE customer_orders DROP COLUMN IF EXISTS payment_method;
