import sys
import os
from dotenv import load_dotenv
load_dotenv('.env')
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable
from app.db import Base
import app.models as models

sys.stdout.reconfigure(encoding='utf-8')
engine = create_engine(os.getenv('DATABASE_URL'))

TABLE_ORDER = [
    'tenants',
    'categories',
    'suppliers',
    'users',
    'restaurant_tables',
    'inventory_items',
    'products',
    'product_recipes',
    'purchase_orders',
    'purchase_order_items',
    'shifts',
    'shift_cash_movements',
    'transactions',
    'transaction_items',
    'payments',
    'customer_orders',
    'customer_order_items',
    'incident_reports',
    'activity_logs',
    'stock_movements'
]

sql_statements = []
sql_statements.append('-- =========================================================')
sql_statements.append('-- Supabase (PostgreSQL) Complete Schema & Data Dump')
sql_statements.append('-- Project: Blessie FoodHub / RestoTrack POS')
sql_statements.append('-- Safe to run & rerun directly in Supabase SQL Editor')
sql_statements.append('-- =========================================================\n')

sql_statements.append('-- 1. Enable Required Extensions')
sql_statements.append('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\n')

sql_statements.append('-- 2. Create Custom ENUM Types (Idempotent)')
enums_def = [
    ('userrole', ["'SUPER_ADMIN'", "'ADMIN'", "'MANAGER'", "'CASHIER'", "'INVENTORY'", "'KITCHEN'", "'CUSTOMER'"]),
    ('reportcategory', ["'BUG'", "'HARDWARE'", "'INVENTORY_DISCREPANCY'", "'PAYMENT_ISSUE'", "'OTHER'"]),
    ('reportpriority', ["'LOW'", "'MEDIUM'", "'HIGH'", "'CRITICAL'"]),
    ('reportstatus', ["'OPEN'", "'IN_PROGRESS'", "'RESOLVED'", "'REJECTED'"]),
    ('purchaseorderstatus', ["'Draft'", "'Pending'", "'Ordered'", "'Partially Received'", "'Received'", "'Cancelled'"])
]

for type_name, values in enums_def:
    vals_str = ', '.join(values)
    sql_statements.append(f"""DO $$ BEGIN
    CREATE TYPE {type_name} AS ENUM ({vals_str});
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;\n""")

sql_statements.append('-- 3. Drop existing tables if re-running (Clean slate in reverse dependency order)')
for table_name in reversed(TABLE_ORDER):
    sql_statements.append(f'DROP TABLE IF EXISTS "{table_name}" CASCADE;')
sql_statements.append('')

# Add DDL in sorted table order
sql_statements.append('-- 4. Create Tables (PostgreSQL DDL)')
for table in Base.metadata.sorted_tables:
    ddl = str(CreateTable(table).compile(dialect=postgresql.dialect())).strip()
    sql_statements.append(f'{ddl};\n')

# stock_movements table definition (present in MySQL)
sql_statements.append("""CREATE TABLE "stock_movements" (
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
""")

sql_statements.append('-- 5. Insert Existing Records')

inserted_ids = {}

with engine.connect() as conn:
    for table_name in TABLE_ORDER:
        table = Base.metadata.tables.get(table_name)
        if table is None:
            continue
        rows = conn.execute(text(f'SELECT * FROM `{table_name}`')).fetchall()
        if not rows:
            inserted_ids[table_name] = set()
            continue
        
        sql_statements.append(f'-- Records for: {table_name} ({len(rows)} rows)')
        cols = [c.name for c in table.columns]
        col_names_str = ', '.join([f'"{c}"' for c in cols])
        
        current_table_ids = set()
        for r in rows:
            r_dict = dict(r._mapping)
            if 'id' in r_dict and r_dict['id'] is not None:
                current_table_ids.add(r_dict['id'])
                
            vals = []
            skip_row = False
            for c in cols:
                col_obj = table.columns[c]
                v = r_dict.get(c)
                
                # Check foreign key integrity
                if v is not None and col_obj.foreign_keys:
                    for fk in col_obj.foreign_keys:
                        target_table = fk.column.table.name
                        target_col = fk.column.name
                        if target_col == 'id' and target_table in inserted_ids:
                            if v not in inserted_ids[target_table]:
                                if col_obj.nullable:
                                    v = None
                                else:
                                    skip_row = True
                                    break
                    if skip_row:
                        break
                
                if v is None:
                    vals.append('NULL')
                elif isinstance(col_obj.type, models.Boolean) or c == 'is_active':
                    vals.append('TRUE' if bool(v) else 'FALSE')
                elif isinstance(v, bool):
                    vals.append('TRUE' if v else 'FALSE')
                elif isinstance(v, (int, float)):
                    vals.append(str(v))
                else:
                    escaped = str(v).replace("'", "''")
                    vals.append(f"'{escaped}'")
                    
            if not skip_row:
                vals_str = ', '.join(vals)
                sql_statements.append(f'INSERT INTO "{table_name}" ({col_names_str}) VALUES ({vals_str}) ON CONFLICT DO NOTHING;')
                
        inserted_ids[table_name] = current_table_ids

sql_statements.append('-- 6. Synchronize Auto-Increment Sequences')
for table_name in TABLE_ORDER:
    sql_statements.append(f"""SELECT setval(pg_get_serial_sequence('"{table_name}"', 'id'), coalesce(max(id), 1), max(id) IS NOT NULL) FROM "{table_name}";""")

out_path = 'c:/pos/supabase_setup.sql'
with open(out_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(sql_statements))

print(f'Successfully generated {out_path} ({len(sql_statements)} lines)!')
