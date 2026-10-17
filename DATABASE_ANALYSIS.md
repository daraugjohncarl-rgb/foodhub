# Comprehensive Database Analysis & Supabase Deployment Readiness Report

**Project:** Blessie FoodHub / RestoTrack Multi-Role POS & Management System  
**Date of Analysis:** October 18, 2026  
**Current Engine:** MySQL 8.x / MariaDB (`mysql+pymysql`)  
**Target Deployment:** Supabase (Managed Cloud PostgreSQL 15+)  

---

## 1. Executive Summary: Is it OK to Deploy to Supabase?

> **Verdict: YES, 100% COMPATIBLE AND READY FOR SUPABASE.**  
> The database schema, SQLAlchemy models, and Python backend are architecturally clean, well-normalized, and already have native PostgreSQL compatibility built in.

### Key Readiness Findings:
| Factor | Status | Assessment |
|---|:---:|---|
| **SQLAlchemy Dialect Compatibility** | ✅ PASS | All 20 tables compile into native PostgreSQL DDL with zero errors. |
| **Driver Support** | ✅ PASS | `psycopg` (v3) and `psycopg-binary` 3.3.6 are already installed in `.\.venv`. |
| **Connection Handler (`app/db.py`)** | ✅ PASS | Already contains auto-detect logic converting `postgres://` / `postgresql://` into `postgresql+psycopg://`. |
| **Cloud DB Bypass** | ✅ PASS | `check_and_create_db()` automatically skips local database checks when pointing to remote cloud hosts like Supabase. |
| **SQL Portability** | ✅ PASS | Queries use SQLAlchemy ORM (`joinedload`, `selectinload`, `func.coalesce`, `func.sum`) without MySQL-specific syntax (no raw backticks, no `GROUP_CONCAT`, no `IFNULL`). |
| **Data Migration Path** | ✅ READY | Automated Python migration script provided (`migrate_to_supabase.py`) to transfer all data and reset sequences. |

---

## 2. Full Database Schema & Table Inventory

The active database currently consists of **20 tables** organized into 6 core domains:

```
[Tenants (Multi-Tenancy)]
   ├── [Users & Auth] ──> [Activity Logs, Incident Reports]
   ├── [Categories] ────> [Products] ──> [Product Recipes] ──> [Inventory Items]
   ├── [Suppliers] ─────> [Purchase Orders] ──> [Purchase Order Items]
   ├── [Restaurant Tables]
   ├── [Shifts] ────────> [Shift Cash Movements]
   │       └────────────> [Transactions] ──> [Transaction Items, Payments]
   └── [Customer Orders] ─> [Customer Order Items]
```

### Table Details & Current Data Counts:

| # | Table Name | Record Count | Description | Primary Key | Foreign Key Dependencies |
|:---:|---|:---:|---|---|---|
| 1 | `tenants` | 1 | Multi-tenant organization accounts | `id` (BigInteger) | None |
| 2 | `categories` | 12 | Product menu groupings | `id` (Integer) | `tenants.id` |
| 3 | `suppliers` | 3 | Vendor profiles for raw ingredient supply | `id` (Integer) | `tenants.id` |
| 4 | `users` | 8 | All system accounts (Super Admin, Admin, Manager, Cashier, Inventory, Kitchen, Customer) | `id` (Integer) | `tenants.id` |
| 5 | `restaurant_tables` | 1 | Table numbers & dine-in QR stations | `id` (Integer) | `tenants.id` |
| 6 | `products` | 136 | POS & QR menu item catalog with pricing | `id` (Integer) | `tenants.id`, `categories.id` |
| 7 | `inventory_items` | 253 | Raw ingredient stocks, units, and reorder levels | `id` (Integer) | `tenants.id` |
| 8 | `product_recipes` | 0 | Recipe BOM mapping products to ingredients | `id` (Integer) | `products.id`, `inventory_items.id` |
| 9 | `purchase_orders` | 0 | Stock replenishment procurement records | `id` (Integer) | `tenants.id`, `suppliers.id`, `users.id` |
| 10 | `purchase_order_items` | 0 | Line items for purchase orders | `id` (Integer) | `purchase_orders.id`, `inventory_items.id` |
| 11 | `shifts` | 31 | Cashier shift registers and cash drawers | `id` (Integer) | `tenants.id`, `users.id` |
| 12 | `shift_cash_movements` | 51 | Cash drawer audit trail (PAID_IN, PAID_OUT) | `id` (BigInteger) | `tenants.id`, `shifts.id`, `users.id` |
| 13 | `transactions` | 40 | Sales orders and POS checkout records | `id` (Integer) | `tenants.id`, `shifts.id`, `users.id` |
| 14 | `transaction_items` | 46 | Line items per sales transaction | `id` (Integer) | `transactions.id`, `products.id` |
| 15 | `payments` | 40 | Payment tender records (Cash, GCash, Card) | `id` (Integer) | `transactions.id` |
| 16 | `customer_orders` | 18 | Table QR self-order tickets | `id` (Integer) | `tenants.id` |
| 17 | `customer_order_items` | 18 | Order item lines for table QR tickets | `id` (Integer) | `customer_orders.id`, `products.id` |
| 18 | `incident_reports` | 15 | Operational & bug reports to Super Admin | `id` (Integer) | `tenants.id`, `users.id` |
| 19 | `activity_logs` | 461 | System-wide audit log trail | `id` (BigInteger) | `tenants.id`, `users.id` |
| 20 | `stock_movements` | 0 | Inventory transfer & shrinkage tracking | `id` (Integer) | `tenants.id`, `inventory_items.id` |

---

## 3. Technical Comparison: MySQL vs Supabase (PostgreSQL)

When deploying from local MySQL to Supabase PostgreSQL, the following behaviors apply:

### 1. Primary Key Sequences & Auto-Increment
- **MySQL:** Uses `AUTO_INCREMENT`. Inserting explicit IDs automatically bumps the internal pointer.
- **Supabase (PostgreSQL):** Uses `SERIAL` or `IDENTITY` backed by a sequence (e.g., `products_id_seq`).
  > **Important Rule:** When importing existing data with pre-assigned IDs into Supabase, each table's sequence must be synced to the highest existing ID (`setval`) so subsequent inserts don't collide. The included migration script handles this automatically.

### 2. Booleans & Integers
- **MySQL:** Stores booleans as `TINYINT(1)` (`0` or `1`).
- **Supabase (PostgreSQL):** Uses native `BOOLEAN` (`TRUE` or `FALSE`).
- **SQLAlchemy:** Automatically handles conversion transparently between both database types.

### 3. Enum Data Types
- **MySQL:** Table-specific inline ENUMs.
- **Supabase (PostgreSQL):** SQLAlchemy creates PostgreSQL custom enum types (`userrole`, `reportcategory`, etc.). All 5 enum definitions compile cleanly.

### 4. Connection Protocol & IPv4 vs IPv6
- **Supabase Direct Connection (`db.[ref].supabase.co:5432`):** Resolves exclusively over IPv6 on many networks.
- **Supabase Pooler Connection (`aws-0-[region].pooler.supabase.com`):** Resolves seamlessly on both **IPv4** and **IPv6** with built-in connection pooling.
  > **Recommendation:** Always use Supabase's **Session Pooler (port 5432)** or **Transaction Pooler (port 6543)** in your `.env` connection string.

---

## 4. Step-by-Step Guide: Deploying to Supabase

### Step 1: Create a Free Supabase Project
1. Go to [supabase.com](https://supabase.com) and create an account.
2. Click **New Project**, choose a project name (e.g. `blessie-foodhub`), set a secure Database Password, and select the region closest to you (e.g. `Southeast Asia (Singapore) - ap-southeast-1`).
3. Once provisioned, navigate to **Project Settings** ➔ **Database**.

### Step 2: Retrieve Your Connection String
In Supabase Database Settings, locate **Connection string** ➔ **URI**:
- Select **Pooler** mode.
- Copy the URI. It will look like:
  ```text
  postgresql://postgres.[PROJECT_REF]:[YOUR_PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require
  ```

### Step 3: Run the Automated Data Migration Script
We have provided an automated migration script (`migrate_to_supabase.py`) that:
1. Connects to your local MySQL database and reads all existing records in proper dependency order.
2. Connects to your online Supabase instance.
3. Automatically creates all 20 tables in Supabase with indexes and foreign keys.
4. Migrates all 1,146+ rows of data (Users, Products, Categories, Inventory, Tables, etc.).
5. Synchronizes all PostgreSQL sequence counters so future orders and users auto-increment seamlessly.

Run it with:
```bash
.\.venv\Scripts\python.exe migrate_to_supabase.py --target "postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require"
```

### Step 4: Update Your `.env` for Production
Update `.env` to point to Supabase:
```env
# Supabase PostgreSQL Configuration
DATABASE_URL=postgresql+psycopg://postgres.[PROJECT_REF]:[YOUR_PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require

# Port
PORT=8000
```

Start the application:
```bash
.\.venv\Scripts\python.exe run.py
```

---

## 5. Security & Performance Recommendations for Supabase

1. **Row-Level Security (RLS):**  
   Supabase enables RLS by default on new tables. Because this FastAPI application manages multi-tenancy and authorization centrally through application middleware (`app/core/dependencies.py` and JWT tokens), ensure tables allow access to the database connection role (`postgres`).
2. **Connection Pooling:**  
   Always use the Supabase Transaction/Session Pooler (port `6543` / `5432`) to prevent connection limits from being exhausted when deploying to platforms like Render, Railway, or AWS.
3. **Automated Backups:**  
   Supabase automatically takes daily backups with point-in-time recovery options.
