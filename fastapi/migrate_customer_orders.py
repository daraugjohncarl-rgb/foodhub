import os
import sys
import traceback
from sqlalchemy import text
from app.db import engine

def run_migration():
    print("Starting safe migration for customer_orders.tenant_id...")
    
    # We use a raw connection to ensure we aren't relying on ORM reflection that might be out of date
    with engine.begin() as conn:
        dialect_name = conn.dialect.name
        
        if dialect_name != "postgresql":
            print(f"WARNING: The database dialect is '{dialect_name}', not 'postgresql'.")
            print("This migration script is specifically designed for PostgreSQL.")
            if dialect_name == "sqlite":
                print("SQLite doesn't fully support these ALTER TABLE commands for foreign keys.")
                # We'll just exit gracefully for SQLite rather than failing, but for Postgres we proceed.
                return
            
        print("1. Checking if tenants table exists...")
        result = conn.execute(text("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'tenants')")).scalar()
        if not result:
            print("ERROR: 'tenants' table does not exist. Aborting migration.")
            sys.exit(1)
            
        print("2. Verifying tenant ID 1 exists...")
        result = conn.execute(text("SELECT EXISTS (SELECT 1 FROM tenants WHERE id = 1)")).scalar()
        if not result:
            print("ERROR: Tenant ID 1 does not exist in 'tenants' table. Aborting migration to prevent foreign key errors.")
            sys.exit(1)
            
        print("3. Checking if customer_orders.tenant_id column exists...")
        column_exists = conn.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name='customer_orders' AND column_name='tenant_id'
            )
        """)).scalar()
        
        if not column_exists:
            print("4. Column 'tenant_id' is missing. Adding it as BIGINT...")
            conn.execute(text("ALTER TABLE customer_orders ADD COLUMN tenant_id BIGINT"))
            print("Column added successfully.")
        else:
            print("4. Column 'tenant_id' already exists.")
            
        print("5. Populating existing NULL rows with tenant_id = 1...")
        result = conn.execute(text("UPDATE customer_orders SET tenant_id = 1 WHERE tenant_id IS NULL"))
        print(f"Updated {result.rowcount} rows.")
        
        print("6. Verifying no NULL tenant_id rows remain...")
        null_count = conn.execute(text("SELECT COUNT(*) FROM customer_orders WHERE tenant_id IS NULL")).scalar()
        if null_count > 0:
            print(f"ERROR: Found {null_count} rows with NULL tenant_id after update. Aborting.")
            sys.exit(1)
            
        print("7. Setting tenant_id to NOT NULL...")
        # In PostgreSQL, we can safely apply SET NOT NULL even if it's already NOT NULL
        conn.execute(text("ALTER TABLE customer_orders ALTER COLUMN tenant_id SET NOT NULL"))
        
        print("8. Checking for existing foreign key to tenants...")
        fk_exists = conn.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'FOREIGN KEY' 
                  AND tc.table_name = 'customer_orders'
                  AND kcu.column_name = 'tenant_id'
            )
        """)).scalar()
        
        if not fk_exists:
            print("Foreign key constraint missing. Adding foreign key on tenant_id -> tenants(id) ON DELETE CASCADE...")
            # Use an explicit name, but since we verified via column usage it won't duplicate 
            # if a random constraint name already existed on that column.
            conn.execute(text("""
                ALTER TABLE customer_orders 
                ADD CONSTRAINT fk_customer_orders_tenant_id 
                FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            """))
            print("Foreign key added successfully.")
        else:
            print("8. Foreign key constraint already exists on customer_orders.tenant_id.")
            
        print("9. Checking if customer_order_items.product_id column exists...")
        product_id_exists = conn.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name='customer_order_items' AND column_name='product_id'
            )
        """)).scalar()
        
        if not product_id_exists:
            print("10. Column 'product_id' is missing from customer_order_items. Adding it as INTEGER (nullable)...")
            conn.execute(text("ALTER TABLE customer_order_items ADD COLUMN product_id INTEGER"))
            print("Column added successfully.")
        else:
            print("10. Column 'product_id' already exists in customer_order_items.")
            
        print("11. Checking for existing foreign key on customer_order_items.product_id to products...")
        product_fk_exists = conn.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'FOREIGN KEY' 
                  AND tc.table_name = 'customer_order_items'
                  AND kcu.column_name = 'product_id'
            )
        """)).scalar()
        
        if not product_fk_exists:
            print("Foreign key constraint missing. Adding foreign key on product_id -> products(id) ON DELETE SET NULL...")
            conn.execute(text("""
                ALTER TABLE customer_order_items 
                ADD CONSTRAINT fk_customer_order_items_product_id 
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
            """))
            print("Foreign key added successfully.")
        else:
            print("11. Foreign key constraint already exists on customer_order_items.product_id.")
            
        print("12. Transaction will commit upon exiting context manager.")
        
    print("13. SUCCESS: Migration completed safely.")

if __name__ == "__main__":
    try:
        run_migration()
    except Exception as e:
        print(f"FAILED: Migration encountered an unexpected error:")
        traceback.print_exc()
        sys.exit(1)
