-- Rollback for 20261023000003_enable_rls_deny_by_default.sql
-- Disables RLS again. It deliberately does NOT re-grant privileges to anon / authenticated:
-- restoring public API access to private tables is a security decision, not a rollback step.
-- Re-grant explicitly and narrowly if (and only if) some client really needs it.

DO $$
DECLARE
    t text;
    app_tables text[] := ARRAY[
        'tenants', 'users', 'activity_logs', 'categories', 'products', 'inventory_items',
        'product_recipes', 'shifts', 'transactions', 'transaction_items', 'payments',
        'shift_cash_movements', 'incident_reports', 'suppliers', 'purchase_orders',
        'purchase_order_items', 'customer_orders', 'customer_order_items', 'restaurant_tables',
        'expenses',
        'stock_movements' -- present in supabase_setup.sql / the live schema, not modelled by the app
    ];
BEGIN
    FOREACH t IN ARRAY app_tables LOOP
        IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
        END IF;
    END LOOP;
END $$;
