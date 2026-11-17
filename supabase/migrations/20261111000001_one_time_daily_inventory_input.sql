-- One-Time Daily Inventory Input System
-- Migration: 20261111000001_one_time_daily_inventory_input.sql
-- Status: Applied to Supabase & MySQL.

CREATE TABLE IF NOT EXISTS daily_inventory_records (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    inventory_item_id INT NOT NULL,
    unit_price NUMERIC(10, 2) NOT NULL,
    current_stock NUMERIC(10, 2) NOT NULL,
    submitted_by INT NULL,
    submitted_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    inventory_date DATE NOT NULL,
    CONSTRAINT uix_daily_inv_item_date UNIQUE (tenant_id, inventory_item_id, inventory_date),
    CONSTRAINT fk_daily_inv_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
    CONSTRAINT fk_daily_inv_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
    CONSTRAINT fk_daily_inv_user FOREIGN KEY (submitted_by) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_daily_inv_date ON daily_inventory_records (inventory_date);
CREATE INDEX IF NOT EXISTS ix_daily_inv_item ON daily_inventory_records (inventory_item_id);

