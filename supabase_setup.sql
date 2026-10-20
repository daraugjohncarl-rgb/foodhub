-- ==============================================================================
-- SUPABASE / POSTGRESQL COMPLETE DATABASE SCHEMA & DATA DUMP
-- Project: Blessie FoodHub / RestoTrack POS
-- Compatible with: Supabase Cloud SQL Editor, Local PostgreSQL, psql, pgAdmin
-- ==============================================================================

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;
SET search_path = public, pg_catalog;

BEGIN;

-- 1. Enable Required Extensions (Fault-tolerant for restricted & local environments)
DO $$ BEGIN
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
EXCEPTION WHEN OTHERS THEN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
END $$;

-- 2. Create Custom ENUM Types (Idempotent)
DO $$ BEGIN
    CREATE TYPE userrole AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'INVENTORY', 'KITCHEN', 'CUSTOMER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE reportcategory AS ENUM ('BUG', 'HARDWARE', 'INVENTORY_DISCREPANCY', 'PAYMENT_ISSUE', 'OTHER');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE reportpriority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE reportstatus AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE purchaseorderstatus AS ENUM ('Draft', 'Pending', 'Ordered', 'Partially Received', 'Received', 'Cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. Drop existing tables if re-running (Clean slate in reverse dependency order)
DROP TABLE IF EXISTS "stock_movements" CASCADE;
DROP TABLE IF EXISTS "activity_logs" CASCADE;
DROP TABLE IF EXISTS "incident_reports" CASCADE;
DROP TABLE IF EXISTS "customer_order_items" CASCADE;
DROP TABLE IF EXISTS "customer_orders" CASCADE;
DROP TABLE IF EXISTS "payments" CASCADE;
DROP TABLE IF EXISTS "transaction_items" CASCADE;
DROP TABLE IF EXISTS "transactions" CASCADE;
DROP TABLE IF EXISTS "shift_cash_movements" CASCADE;
DROP TABLE IF EXISTS "shifts" CASCADE;
DROP TABLE IF EXISTS "purchase_order_items" CASCADE;
DROP TABLE IF EXISTS "purchase_orders" CASCADE;
DROP TABLE IF EXISTS "product_recipes" CASCADE;
DROP TABLE IF EXISTS "products" CASCADE;
DROP TABLE IF EXISTS "inventory_items" CASCADE;
DROP TABLE IF EXISTS "restaurant_tables" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;
DROP TABLE IF EXISTS "suppliers" CASCADE;
DROP TABLE IF EXISTS "categories" CASCADE;
DROP TABLE IF EXISTS "tenants" CASCADE;

-- 4. Create Tables (PostgreSQL DDL)
CREATE TABLE tenants (
	id BIGSERIAL NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	subdomain_or_code VARCHAR(100) NOT NULL, 
	is_active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE categories (
	id SERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	description VARCHAR(255), 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uix_tenant_category_name UNIQUE (tenant_id, name), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE customer_orders (
	id SERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	order_number VARCHAR(50) NOT NULL, 
	customer_name VARCHAR(100) NOT NULL, 
	order_type VARCHAR(50) NOT NULL, 
	table_number VARCHAR(50), 
	notes TEXT, 
	total_amount NUMERIC(10, 2) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	tracking_token VARCHAR(64), 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE inventory_items (
	id SERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	category VARCHAR(100), 
	sku VARCHAR(50), 
	quantity NUMERIC(10, 2) NOT NULL, 
	unit VARCHAR(20) NOT NULL, 
	min_stock NUMERIC(10, 2) NOT NULL, 
	unit_price NUMERIC(10, 2) NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uix_tenant_inventory_name UNIQUE (tenant_id, name), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE restaurant_tables (
	id SERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	table_number VARCHAR(50) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE suppliers (
	id BIGSERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	supplier_name VARCHAR(150) NOT NULL, 
	contact_number VARCHAR(50), 
	category VARCHAR(100), 
	contact_person VARCHAR(100), 
	email VARCHAR(100), 
	address TEXT, 
	products_supplied VARCHAR(255), 
	status VARCHAR(50) NOT NULL, 
	notes TEXT, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uix_tenant_supplier_name UNIQUE (tenant_id, supplier_name), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE users (
	id SERIAL NOT NULL, 
	tenant_id BIGINT, 
	username VARCHAR(50) NOT NULL, 
	first_name VARCHAR(50), 
	last_name VARCHAR(50), 
	email VARCHAR(100), 
	phone VARCHAR(30), 
	password_hash VARCHAR(255) NOT NULL, 
	role userrole NOT NULL, 
	is_active BOOLEAN NOT NULL, 
	token_version INTEGER NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE activity_logs (
	id BIGSERIAL NOT NULL, 
	tenant_id BIGINT, 
	user_id INTEGER, 
	action VARCHAR(50) NOT NULL, 
	performed_by VARCHAR(100) NOT NULL, 
	target_user VARCHAR(100), 
	role VARCHAR(50), 
	details VARCHAR(255), 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE, 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE incident_reports (
	id BIGSERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	user_id INTEGER, 
	title VARCHAR(150) NOT NULL, 
	category reportcategory NOT NULL, 
	priority reportpriority NOT NULL, 
	status reportstatus NOT NULL, 
	description TEXT NOT NULL, 
	admin_notes TEXT, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE, 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE products (
	id SERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	category_id INTEGER, 
	name VARCHAR(100) NOT NULL, 
	sku VARCHAR(50) NOT NULL, 
	barcode VARCHAR(100), 
	price NUMERIC(10, 2) NOT NULL, 
	cost NUMERIC(10, 2) NOT NULL, 
	is_active BOOLEAN NOT NULL, 
	image_url TEXT, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uix_tenant_product_sku UNIQUE (tenant_id, sku), 
	CONSTRAINT uix_tenant_product_name UNIQUE (tenant_id, name), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE, 
	FOREIGN KEY(category_id) REFERENCES categories (id) ON DELETE SET NULL
);

CREATE TABLE purchase_orders (
	id BIGSERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	po_number VARCHAR(50) NOT NULL, 
	supplier_id BIGINT NOT NULL, 
	order_date TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	expected_delivery_date TIMESTAMP WITHOUT TIME ZONE, 
	received_date TIMESTAMP WITHOUT TIME ZONE, 
	status purchaseorderstatus NOT NULL, 
	subtotal NUMERIC(10, 2) NOT NULL, 
	total_amount NUMERIC(10, 2) NOT NULL, 
	notes TEXT, 
	created_by INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uix_tenant_po_number UNIQUE (tenant_id, po_number), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE, 
	FOREIGN KEY(supplier_id) REFERENCES suppliers (id) ON DELETE RESTRICT, 
	FOREIGN KEY(created_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE shifts (
	id SERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	user_id INTEGER NOT NULL, 
	start_time TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	end_time TIMESTAMP WITHOUT TIME ZONE, 
	start_cash NUMERIC(10, 2) NOT NULL, 
	end_cash NUMERIC(10, 2), 
	status VARCHAR(20) NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE, 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE customer_order_items (
	id SERIAL NOT NULL, 
	customer_order_id INTEGER NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	variant VARCHAR(100), 
	price NUMERIC(10, 2) NOT NULL, 
	quantity INTEGER NOT NULL, 
	product_id INTEGER, 
	PRIMARY KEY (id), 
	FOREIGN KEY(customer_order_id) REFERENCES customer_orders (id) ON DELETE CASCADE, 
	FOREIGN KEY(product_id) REFERENCES products (id) ON DELETE SET NULL
);

CREATE TABLE product_recipes (
	id SERIAL NOT NULL, 
	product_id INTEGER NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	quantity NUMERIC(10, 2) NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uix_product_inventory UNIQUE (product_id, inventory_item_id), 
	FOREIGN KEY(product_id) REFERENCES products (id) ON DELETE CASCADE, 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id) ON DELETE CASCADE
);

CREATE TABLE purchase_order_items (
	id BIGSERIAL NOT NULL, 
	purchase_order_id BIGINT NOT NULL, 
	inventory_item_id INTEGER NOT NULL, 
	quantity NUMERIC(10, 2) NOT NULL, 
	unit_cost NUMERIC(10, 2) NOT NULL, 
	total_cost NUMERIC(10, 2) NOT NULL, 
	notes TEXT, 
	PRIMARY KEY (id), 
	FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders (id) ON DELETE CASCADE, 
	FOREIGN KEY(inventory_item_id) REFERENCES inventory_items (id) ON DELETE RESTRICT
);

CREATE TABLE shift_cash_movements (
	id BIGSERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	shift_id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	type VARCHAR(20) NOT NULL, 
	amount NUMERIC(10, 2) NOT NULL, 
	reason VARCHAR(255), 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT check_movement_type CHECK (type IN ('PAID_IN', 'PAID_OUT')), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE, 
	FOREIGN KEY(shift_id) REFERENCES shifts (id) ON DELETE CASCADE, 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE transactions (
	id SERIAL NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	shift_id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	client_tx_id VARCHAR(36), 
	total_amount NUMERIC(10, 2) NOT NULL, 
	tax_amount NUMERIC(10, 2) NOT NULL, 
	discount_amount NUMERIC(10, 2) NOT NULL, 
	net_amount NUMERIC(10, 2) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	fulfillment_status VARCHAR(20) NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tenant_id) REFERENCES tenants (id) ON DELETE CASCADE, 
	FOREIGN KEY(shift_id) REFERENCES shifts (id) ON DELETE RESTRICT, 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE payments (
	id SERIAL NOT NULL, 
	transaction_id INTEGER NOT NULL, 
	payment_method VARCHAR(50) NOT NULL, 
	amount NUMERIC(10, 2) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(transaction_id) REFERENCES transactions (id) ON DELETE CASCADE
);

CREATE TABLE transaction_items (
	id SERIAL NOT NULL, 
	transaction_id INTEGER NOT NULL, 
	product_id INTEGER NOT NULL, 
	quantity INTEGER NOT NULL, 
	unit_price NUMERIC(10, 2) NOT NULL, 
	total_price NUMERIC(10, 2) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(transaction_id) REFERENCES transactions (id) ON DELETE CASCADE, 
	FOREIGN KEY(product_id) REFERENCES products (id) ON DELETE RESTRICT
);

CREATE TABLE "stock_movements" (
    "id" BIGSERIAL PRIMARY KEY,
    "tenant_id" BIGINT NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
    "inventory_item_id" INTEGER NOT NULL REFERENCES "inventory_items" ("id") ON DELETE CASCADE,
    "movement_type" VARCHAR(20) NOT NULL CHECK ("movement_type" IN ('OPENING','RECEIPT','SALE','ADJUSTMENT','WASTAGE','REVERSAL')),
    "quantity_delta" NUMERIC(12, 3) NOT NULL,
    "quantity_after" NUMERIC(12, 3) NOT NULL,
    "unit_cost" NUMERIC(10, 2) DEFAULT NULL,
    "reason" VARCHAR(255) DEFAULT NULL,
    "reference_type" VARCHAR(30) DEFAULT NULL,
    "reference_id" BIGINT DEFAULT NULL,
    "user_id" INTEGER DEFAULT NULL REFERENCES "users" ("id") ON DELETE SET NULL,
    "created_at" TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX "ix_stock_movements_tenant_id" ON "stock_movements" ("tenant_id");
CREATE INDEX "ix_stock_movements_inventory_item_id" ON "stock_movements" ("inventory_item_id");
CREATE INDEX "ix_stock_movements_user_id" ON "stock_movements" ("user_id");
CREATE INDEX "ix_stock_movements_tenant_type_created" ON "stock_movements" ("tenant_id", "movement_type", "created_at");

-- 5. Insert Existing Records
-- Records for: tenants [Supabase (1 rows)]
INSERT INTO "tenants" ("id", "name", "subdomain_or_code", "is_active", "created_at") VALUES (1, 'Main Branch - Blessie FoodHub', 'main-branch', TRUE, '2026-08-24 20:20:52') ON CONFLICT DO NOTHING;
-- Records for: users [Supabase (8 rows)]
INSERT INTO "users" ("id", "tenant_id", "username", "first_name", "last_name", "email", "phone", "password_hash", "role", "is_active", "token_version", "created_at", "updated_at") VALUES (1, NULL, 'superadmin', NULL, NULL, 'superadmin@inboxpos.com', NULL, '$2b$12$67bNSDGZ7W3J.sfl/6pJfOqERxeiEfNqI3zGzLeWfET7.faImFwjm', 'SUPER_ADMIN', TRUE, 5, '2026-08-24 20:20:52', '2026-10-18 07:48:32.417543') ON CONFLICT DO NOTHING;
INSERT INTO "users" ("id", "tenant_id", "username", "first_name", "last_name", "email", "phone", "password_hash", "role", "is_active", "token_version", "created_at", "updated_at") VALUES (2, 1, 'admin', NULL, NULL, 'admin@inboxpos.com', NULL, '$2b$12$8Xt/UtrY3X/Mor6sQF5QfO6V2lSFulbqlm7U9gWatBtSBJPVz7Z6S', 'ADMIN', TRUE, 18, '2026-08-24 20:20:52', '2026-10-18 07:58:16.744571') ON CONFLICT DO NOTHING;
INSERT INTO "users" ("id", "tenant_id", "username", "first_name", "last_name", "email", "phone", "password_hash", "role", "is_active", "token_version", "created_at", "updated_at") VALUES (3, 1, 'Manager', 'Nazarhene', 'Yee', 'nazarheneyee@gmail.com', '09837463821', '$2b$12$t7uXVZ4u9BNf.2lDro8LXeXKRrC1Pj.6DaXOqNOIhNqBucn.9g7Fu', 'MANAGER', TRUE, 2, '2026-08-24 21:24:32', '2026-10-17 23:27:08') ON CONFLICT DO NOTHING;
INSERT INTO "users" ("id", "tenant_id", "username", "first_name", "last_name", "email", "phone", "password_hash", "role", "is_active", "token_version", "created_at", "updated_at") VALUES (4, 1, 'Inventory', 'rex', 'gastador', 'inventory@gmail.com', '09746373831', '$2b$12$zQNQCOAyBXw1/qz01uTnO.rMxyF3fQENqJ57D8UdVsaqgi5WYWkYW', 'INVENTORY', TRUE, 2, '2026-08-24 21:26:26', '2026-10-17 23:27:09') ON CONFLICT DO NOTHING;
INSERT INTO "users" ("id", "tenant_id", "username", "first_name", "last_name", "email", "phone", "password_hash", "role", "is_active", "token_version", "created_at", "updated_at") VALUES (5, 1, 'cashier', 'elaiza', 'cezar', 'cashier@gmail.com', '0974527383', '$2b$12$ATUkcdj889W1WnegmQ.b4.v4EaKOfKSSGpnhByLQco1zY4kcbtMCG', 'CASHIER', TRUE, 13, '2026-08-24 22:21:10', '2026-10-18 07:48:44.626521') ON CONFLICT DO NOTHING;
INSERT INTO "users" ("id", "tenant_id", "username", "first_name", "last_name", "email", "phone", "password_hash", "role", "is_active", "token_version", "created_at", "updated_at") VALUES (6, 1, 'kitchen', 'jojo', 'banes', 'kitchen@gmail.com', '09846473821', '$2b$12$.CRT1Xx.ZLM7OhGrV9iiNOM6u8gvkIEb94HLRAQGYM2EwzsE4jz6u', 'KITCHEN', TRUE, 5, '2026-08-24 22:22:58', '2026-10-18 07:48:50.694460') ON CONFLICT DO NOTHING;
INSERT INTO "users" ("id", "tenant_id", "username", "first_name", "last_name", "email", "phone", "password_hash", "role", "is_active", "token_version", "created_at", "updated_at") VALUES (13, 1, 'manager', NULL, NULL, 'manager@inboxpos.com', NULL, '$2b$12$/XILaolR40Y7hLyHFWrtyOpMGtAoDe9s0CG6.8G/VFCnHli9tEFae', 'MANAGER', TRUE, 3, '2026-10-18 02:12:44.131460', '2026-10-18 07:48:39.304373') ON CONFLICT DO NOTHING;
INSERT INTO "users" ("id", "tenant_id", "username", "first_name", "last_name", "email", "phone", "password_hash", "role", "is_active", "token_version", "created_at", "updated_at") VALUES (14, 1, 'inventory', NULL, NULL, 'inventory@inboxpos.com', NULL, '$2b$12$QoqZtAQWMWo3KDG/u3Oq8usZHJ8ALhauQsjhb58SJ5U1kzpylXfSO', 'INVENTORY', TRUE, 4, '2026-10-18 02:12:47.345609', '2026-10-18 07:48:47.651294') ON CONFLICT DO NOTHING;
-- 6. Synchronize Auto-Increment Sequences (Robust Procedural Block)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_default LIKE 'nextval%' OR is_identity = 'YES')
    ) LOOP
        BEGIN
            EXECUTE format(
                'SELECT setval(pg_get_serial_sequence(%L, %L), coalesce(max(%I), 1), max(%I) IS NOT NULL) FROM %I',
                r.table_name, r.column_name, r.column_name, r.column_name, r.table_name
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;
END $$;

-- 7. Grant Privileges for Supabase Roles (Safe across both Supabase Cloud & Local Postgres)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
        GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    END IF;
END $$;

COMMIT;

-- 8. Reload PostgREST Schema Cache (Notifies Supabase API to immediately see changes)
NOTIFY pgrst, 'reload schema';
