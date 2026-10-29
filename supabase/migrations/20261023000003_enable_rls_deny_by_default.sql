-- Row Level Security: deny-by-default for Supabase's public API roles.
-- STATUS: PREPARED, NOT APPLIED. Read the pre-flight notes before applying.
--
-- Why: Inbox POS talks to PostgreSQL directly through SQLAlchemy using DATABASE_URL (a privileged
-- database role). It does NOT use supabase-js, PostgREST, Supabase Auth or Realtime, so no public
-- API role (anon / authenticated) needs any access to these tables. Supabase still exposes the
-- `public` schema through its REST API by default, so without RLS anyone holding the project's
-- publishable (anon) key could read or write staff, transaction and customer data.
--
-- What it does:
--   * ENABLE ROW LEVEL SECURITY on every application table, with NO policies. For anon /
--     authenticated that means "no rows visible, no writes allowed".
--   * REVOKE table and sequence privileges from anon / authenticated as a second layer.
--   * Does NOT use FORCE ROW LEVEL SECURITY, so the table owner (the role the backend connects as,
--     normally `postgres`) keeps working exactly as before.
--
-- PRE-FLIGHT (run these first; apply only if the backend role bypasses RLS):
--   SELECT current_user;                                    -- the role used by this migration
--   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '<role in DATABASE_URL>';
--   SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public';
--   The backend role must be a table owner, a superuser, or have BYPASSRLS. If it is a restricted
--   custom role, create explicit policies for it BEFORE enabling RLS or the app will be locked out.
--
-- Verification after applying:
--   SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';
--   SET ROLE anon; SELECT count(*) FROM users;  -- expect 0 rows or permission denied
--   RESET ROLE;
--
-- Supabase Storage: the application stores uploads on its own filesystem (static/images/products),
-- not in Supabase Storage, so there are no storage policies to review. Revisit if that changes.

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
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        END IF;
    END LOOP;

    -- Only Supabase projects have these roles; plain PostgreSQL (CI, local) skips this part.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    END IF;
END $$;

-- Report (do not change) any other table in `public` that still has RLS off, for manual review.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.relname FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT c.relrowsecurity
    LOOP
        RAISE NOTICE 'Table public.% has Row Level Security disabled; review it manually.', r.relname;
    END LOOP;
END $$;
