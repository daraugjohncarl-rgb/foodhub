-- Rollback for 20261023000002_tenant_integrity_and_indexes.sql
-- Restores the previous (global) client_tx_id uniqueness only if no cross-tenant duplicates exist.

DROP INDEX IF EXISTS uix_users_username_lower;
DROP INDEX IF EXISTS uix_users_email_lower;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM transactions WHERE client_tx_id IS NOT NULL GROUP BY client_tx_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Cannot restore global uniqueness of client_tx_id: duplicates exist across tenants.';
    END IF;
END $$;
DROP INDEX IF EXISTS ix_transactions_client_tx_id;
CREATE UNIQUE INDEX IF NOT EXISTS ix_transactions_client_tx_id ON transactions (client_tx_id);
DROP INDEX IF EXISTS uix_transactions_tenant_client_tx;

DROP INDEX IF EXISTS ix_inventory_items_tenant_id;
DROP INDEX IF EXISTS ix_customer_orders_tenant_id;
DROP INDEX IF EXISTS ix_customer_orders_tenant_status;
DROP INDEX IF EXISTS ix_customer_order_items_customer_order_id;

ALTER TABLE transaction_items    DROP CONSTRAINT IF EXISTS ck_transaction_items_quantity_positive;
ALTER TABLE transaction_items    DROP CONSTRAINT IF EXISTS ck_transaction_items_prices_nonneg;
ALTER TABLE customer_order_items DROP CONSTRAINT IF EXISTS ck_customer_order_items_quantity_positive;
ALTER TABLE customer_order_items DROP CONSTRAINT IF EXISTS ck_customer_order_items_price_nonneg;
ALTER TABLE transactions         DROP CONSTRAINT IF EXISTS ck_transactions_amounts_nonneg;
ALTER TABLE payments             DROP CONSTRAINT IF EXISTS ck_payments_amount_nonneg;
ALTER TABLE products             DROP CONSTRAINT IF EXISTS ck_products_price_nonneg;
