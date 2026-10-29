-- Rollback for 20261023000004_tenant_composite_foreign_keys.sql (drops only what that migration added).
ALTER TABLE transactions         DROP CONSTRAINT IF EXISTS fk_transactions_shift_same_tenant;
ALTER TABLE products             DROP CONSTRAINT IF EXISTS fk_products_category_same_tenant;
ALTER TABLE purchase_orders      DROP CONSTRAINT IF EXISTS fk_purchase_orders_supplier_same_tenant;
ALTER TABLE shift_cash_movements DROP CONSTRAINT IF EXISTS fk_cash_movements_shift_same_tenant;
DROP INDEX IF EXISTS uix_shifts_id_tenant;
DROP INDEX IF EXISTS uix_categories_id_tenant;
DROP INDEX IF EXISTS uix_suppliers_id_tenant;
