-- Database-level tenant isolation for the relations that carry tenant_id on both sides.
-- STATUS: PREPARED, NOT APPLIED. Requires PostgreSQL 15+ (Supabase default) for ON DELETE SET NULL (column).
--
-- Honest scope: the application already checks tenant ownership on every request. These constraints are a
-- second line of defence against application bugs and direct SQL. They do NOT cover tables without a
-- tenant_id column (transaction_items, payments, product_recipes, customer_order_items,
-- purchase_order_items); those inherit their tenant through the parent row and remain protected by
-- application checks only. Row Level Security does not apply to the backend's privileged role.
--
-- Safety:
--   * Pre-flight audit aborts with a count if any existing row already crosses tenants.
--   * Parent keys are additive UNIQUE (id, tenant_id) indexes (ids are already unique, so no data can violate them).
--   * Foreign keys are added NOT VALID: enforced for new/updated rows immediately, existing rows are not
--     scanned until VALIDATE CONSTRAINT (run it in a quiet period after the audit passes).

DO $$
DECLARE
    bad bigint;
BEGIN
    SELECT count(*) INTO bad FROM transactions t JOIN shifts s ON s.id = t.shift_id WHERE s.tenant_id <> t.tenant_id;
    IF bad > 0 THEN RAISE EXCEPTION '% transactions reference a shift of another tenant', bad; END IF;

    SELECT count(*) INTO bad FROM products p JOIN categories c ON c.id = p.category_id WHERE c.tenant_id <> p.tenant_id;
    IF bad > 0 THEN RAISE EXCEPTION '% products reference a category of another tenant', bad; END IF;

    SELECT count(*) INTO bad FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE s.tenant_id <> po.tenant_id;
    IF bad > 0 THEN RAISE EXCEPTION '% purchase orders reference a supplier of another tenant', bad; END IF;

    SELECT count(*) INTO bad FROM shift_cash_movements m JOIN shifts s ON s.id = m.shift_id WHERE s.tenant_id <> m.tenant_id;
    IF bad > 0 THEN RAISE EXCEPTION '% cash movements reference a shift of another tenant', bad; END IF;
END $$;

-- Parent keys (ids are unique already, so these indexes cannot fail)
CREATE UNIQUE INDEX IF NOT EXISTS uix_shifts_id_tenant ON shifts (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uix_categories_id_tenant ON categories (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uix_suppliers_id_tenant ON suppliers (id, tenant_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_transactions_shift_same_tenant') THEN
        ALTER TABLE transactions ADD CONSTRAINT fk_transactions_shift_same_tenant
            FOREIGN KEY (shift_id, tenant_id) REFERENCES shifts (id, tenant_id) ON DELETE RESTRICT NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_products_category_same_tenant') THEN
        -- MATCH SIMPLE: a NULL category_id is allowed; deleting a category only nulls category_id (not tenant_id)
        ALTER TABLE products ADD CONSTRAINT fk_products_category_same_tenant
            FOREIGN KEY (category_id, tenant_id) REFERENCES categories (id, tenant_id) ON DELETE SET NULL (category_id) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_orders_supplier_same_tenant') THEN
        ALTER TABLE purchase_orders ADD CONSTRAINT fk_purchase_orders_supplier_same_tenant
            FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers (id, tenant_id) ON DELETE RESTRICT NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_cash_movements_shift_same_tenant') THEN
        ALTER TABLE shift_cash_movements ADD CONSTRAINT fk_cash_movements_shift_same_tenant
            FOREIGN KEY (shift_id, tenant_id) REFERENCES shifts (id, tenant_id) ON DELETE CASCADE NOT VALID;
    END IF;
END $$;

-- After the audit above passes in production, validate (does not block writes):
--   ALTER TABLE transactions         VALIDATE CONSTRAINT fk_transactions_shift_same_tenant;
--   ALTER TABLE products             VALIDATE CONSTRAINT fk_products_category_same_tenant;
--   ALTER TABLE purchase_orders      VALIDATE CONSTRAINT fk_purchase_orders_supplier_same_tenant;
--   ALTER TABLE shift_cash_movements VALIDATE CONSTRAINT fk_cash_movements_shift_same_tenant;
