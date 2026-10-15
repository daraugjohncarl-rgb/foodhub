# Inbox POS — System Audit & Fixes Needed

## Status — 2026-10-16 (fixes implemented, not yet deployed)

Verified on a disposable PostgreSQL 18 database: **118 pytest tests passed** (`fastapi/tests`), **27 headless-Edge
browser checks passed** (`tools/browser_checks`), migrations tested fresh, on a legacy-schema copy (UTC and
Asia/Manila data) and through downgrade/upgrade. Production has **not** been migrated or deployed — see `DEPLOYMENT.md`.

| Finding | Status | Finding | Status | Finding | Status |
|---|---|---|---|---|---|
| C1 | ✅ fixed + tested | H5 | ✅ fixed + tested | M9 | ✅ fixed + tested |
| C2 | ✅ fixed + tested | H6 | ✅ fixed + tested | M10 | ✅ fixed + tested |
| C3 | ✅ fixed + tested | H7 | ✅ fixed + tested | M11 | ✅ fixed + tested |
| C4 | ✅ fixed + tested (secret rotation is a deploy step) | H8 | ✅ fixed + tested | M12 | ✅ fixed + tested (API + UI) |
| C5 | ✅ fixed + tested | H9 | ✅ fixed + tested | L1 | ✅ done |
| C6 | ✅ fixed + tested | H10 | ✅ fixed + tested | L2 | ✅ done |
| C7 | ✅ fixed + tested | H11 | ✅ fixed + tested (matrix test) | L3 | ✅ done |
| C8 | ✅ fixed + tested (incl. concurrency) | M1 | ✅ fixed + tested | L4 | ✅ done |
| C9 | ✅ fixed + tested | M2 | ✅ fixed + tested | L5 | ⏸ partial — needs a decision (see below) |
| H1 | ✅ fixed + browser-tested | M3 | ✅ fixed + tested | L6 | ✅ done |
| H2 | ✅ fixed + tested | M4 | ✅ fixed + tested | L7 | ✅ fixed + browser-tested |
| H3 | ✅ fixed + tested | M5 | ✅ fixed + tested | L8 | ✅ done |
| H4 | ✅ fixed + tested | M6 | ✅ fixed + tested (incl. concurrency) | L9 | ✅ done (Alembic) |
| | | M7 | ✅ fixed + tested | L10 | ✅ done (pytest + CI workflow) |
| | | M8 | ✅ fixed + tested (inline-image cap) | | |

**Corrections to this audit found while fixing**
* L6 was partly wrong: `static/js/*` is used by the super-admin pages (users, logs, dashboard, reports, profile,
  settings). Only the files no served page references were removed.
* New finding: `static/assets/js/suppliers.js` and `purchase_orders.js` were syntactically invalid (escaped
  backticks), so browsers never loaded them, and `views.js` showed **hard-coded mock purchase orders** instead. Both
  modules are repaired and now used; the mock sections were removed.
* New finding: `customer.html` had a stray inline-handler fragment rendered as visible text. Removed.
* L5: removing the duplicate root `static/` copy took ~60 MB of images out of the tree; 33 images (68 MB) remain.
  Converting them to WebP would change file names that production `products.image_url` values may point to, so it
  waits for a decision.

---

Audit date: 2026-10-15 · Scope: the live app in `fastapi/` (FastAPI + SQLAlchemy + PostgreSQL, vanilla JS frontend)

## How this was tested

| What | How |
|---|---|
| Backend code | Every router, model, schema, and core module was read line by line. |
| Runtime behaviour | The real app was booted in-process with FastAPI `TestClient` against a **throw-away SQLite database**. 70 probes covered auth, role-based access, multi-tenancy, POS sales, kitchen, inventory, purchase orders, customer QR orders, shifts and tables. **22 passed, 48 failed.** |
| Frontend | Script and asset references, API calls, and the rendering of customer-supplied data were reviewed. No browser was driven. |
| Deployment files | `Dockerfile`, `Procfile`, `render.yaml`, `requirements.txt`, helper scripts and git hygiene were reviewed. |

**Not covered**
- Nothing was run against your PostgreSQL server or any real data. A SQLite run cannot show Postgres-only behaviour, such as FK enforcement and row-lock races. Those items are marked *(by reading)*.
- The existing `test_complete_system.py`, `test_crud_persistence.py` and `audit_system.py` were **not run**. They write to whatever database `.env` points at, which could be production.
- Browser UI behaviour (clicks, layout) was not tested.

**Legend** — **Verified** = reproduced in the test run. *(by reading)* = found in code, not executed.

---

## Summary

| Severity | Count | Theme |
|---|---|---|
| 🔴 Critical | 9 | Missing authentication/authorisation, data loss, wrong money, forgeable tokens |
| 🟠 High | 11 | Broken business flows, validation holes, 500 errors |
| 🟡 Medium | 12 | Data integrity, timezone, UX/logic bugs |
| 🔵 Low / Hygiene | 10 | Repo cleanliness, dead code, docs, performance |

**Fix first, in this order:** C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → C9 → H1 → H2.

---

## 🔴 Critical

### C1. Anyone on the internet can accept/reject customer orders and read all customers' orders
- **Where:** `app/routers/customer_orders.py` — `update_customer_order_status` (line 145), `get_customer_history` (line 164)
- **Problem:**
  - `PUT /api/v1/customer-orders/{id}/status` has **no authentication** and no tenant check.
  - `GET /api/v1/customer-orders/history` has **no authentication** and, with no `customer_name`, returns every order of every branch. That includes customer names, table numbers and notes.
- **Verified:** an anonymous `PUT` returned 200. An anonymous `GET /history` returned all rows.
- **Fix:**
  - Require `get_current_user` on both.
  - Scope by `current_user.tenant_id`, and restrict status changes to ADMIN/MANAGER/CASHIER.
  - Make `/history` and `/track` look up by the order number or a secret token only. Never list everything.

### C2. Any logged-in user can manage user accounts (broken access control)
- **Where:** `app/routers/users.py` — all endpoints use only `get_current_user`
- **Problem:** no role check exists. A **CASHIER or KITCHEN** account can list users, create MANAGER/INVENTORY accounts, reset other staff passwords, deactivate and delete users.
- **Verified:** a cashier created a MANAGER (201) and reset the manager's password (200). A kitchen account listed all users (200).
- **Fix:** use `Depends(require_admin)` on every `/users` write endpoint and the list endpoints. Allow MANAGER read-only if that is intended.

### C3. Unauthenticated endpoints leak or modify system state
- **Where:** `app/main.py` — `POST /seed-super-admin` (line 429), `GET /test-db` (line 389)
- **Problem:**
  - `/seed-super-admin` is public. It creates a `superadmin / superadmin123` account if no super admin exists, and discloses the existing super admin's id and username.
  - `/test-db` is public. It returns the database name, host, port, tenant and user counts, and on failure the raw exception text. The Dockerfile and `render.yaml` use it as the health check.
- **Verified:** `/test-db` returned the DB name. `/seed-super-admin` returned 200 without a token.
- **Fix:** delete `/seed-super-admin` (startup already seeds). Make the health check return only `{"status":"ok"}`. Keep the detailed version behind `require_admin`.

### C4. JWT secret has a hardcoded fallback — tokens can be forged
- **Where:** `app/core/security.py:9`
- **Problem:** if `JWT_SECRET` is not set, the key is `super_secret_fallback_key_for_pos_inbox_2026`. That string is in the repo. Anyone can sign a token for any user id, including the super admin.
- **Verified:** a token signed with the fallback key was accepted (`GET /users` → 200).
- **Fix:** raise at startup if `JWT_SECRET` is unset or shorter than 32 characters. `render.yaml` already generates one, so confirm it is set on every environment. Rotate it, because the fallback is public.

### C5. Deleting a user permanently deletes their sales history
- **Where:** `app/models.py:87` (`User.transactions`, `User.shifts`, `User.shift_cash_movements` use `cascade="all, delete-orphan"`), `app/routers/users.py` `delete_user`
- **Problem:** the ORM cascade deletes the user's transactions, items, payments, shifts and cash movements before the DB's `RESTRICT` rule can stop it. Removing one cashier erases the financial records.
- **Verified:** 3 sales existed, the cashier was deleted (204), then 0 transactions, 0 payments and 0 shifts remained.
- **Fix:**
  - Remove the delete cascades from `User` → `Transaction/Shift/ShiftCashMovement`.
  - Replace hard delete with deactivation (`is_active=False`), or block deletion when the user has history.
  - The same cascade pattern on `Tenant` is dangerous. Review it too.

### C6. POS sales never become "completed", so the dashboard shows ₱0
- **Where:** `app/routers/transactions.py:156` creates sales with `status="pending"`. `app/routers/analytics.py:48` only counts `"completed"`. Only the Kitchen screen can set `"completed"` (`kitchen.py`).
- **Problem:** today's sales and transaction count stay at 0 until the kitchen staff tap "complete". Sales that never go through the kitchen (drinks, retail) are never counted. The payment row is already `completed` while the sale is `pending`.
- **Verified:** after a ₱30 sale the dashboard returned `today_sales: 0, total_transactions_today: 0`.
- **Fix:** separate payment status (`paid`) from kitchen/fulfilment status (`preparing/ready/served`). Use `status="completed"` (paid) for sales and report revenue on that. Track the kitchen state in its own column.

### C7. Transaction endpoint accepts raw JSON with no validation (negative / free / corrupt sales)
- **Where:** `app/routers/transactions.py:77` (`body: dict`). The `TransactionCreate` schema exists but is not used.
- **Problem:**
  - Quantity ≤ 0 is accepted. A quantity of -5 created a sale with a negative total, clamped to ₱0 net.
  - Tax and discount can be negative, or larger than the total.
  - `tax_amount` and `discount_amount` are trusted from the client with no permission check.
  - Payments are never compared to the amount due. A ₱1 payment on a ₱30 order was accepted.
  - A non-numeric quantity returns a 500.
  - The sale row is committed before its items and payments, so a failure leaves orphan "pending" sales.
- **Verified:** all of the above, plus a 500 for `"quantity":"abc"`.
- **Fix:**
  - Use Pydantic models (`quantity: int = Field(gt=0, le=…)`, `Decimal` with `ge=0`).
  - Compute tax server-side and require a role/PIN for discounts.
  - Require `sum(payments) >= net_amount` and store change.
  - Do the whole sale in **one** DB transaction.

### C8. Duplicate offline-sync ID crashes with 500 and is not idempotent
- **Where:** `transactions.py` (`client_tx_id` is `unique=True` globally in `models.py`)
- **Problem:** the field exists for offline retries, but a retry with the same `client_tx_id` raises an unhandled `IntegrityError` (500). Uniqueness is global, so two tenants colliding is also possible.
- **Verified:** the second POST with the same `client_tx_id` returned 500.
- **Fix:** look the ID up first and return the existing transaction (200). Make the constraint `(tenant_id, client_tx_id)`.

### C9. Cross-tenant and cross-role writes on kitchen orders
- **Where:** `app/routers/kitchen.py` `update_order_status` (line 61)
- **Problem:** the transaction is looked up by id with **no tenant filter** and no role check. Any logged-in user of any branch can change any branch's order status. The status string is also unvalidated (the DB column is 20 characters).
- **Verified:** a different tenant's admin set tenant 1's order to `completed` (200). A 40-character status was accepted (200 on SQLite; it would error on Postgres).
- **Fix:** filter by `tenant_id`, allow only KITCHEN/ADMIN/MANAGER/CASHIER, and validate the status against an enum (`pending|preparing|ready|completed|cancelled`).

---

## 🟠 High

### H1. Stored XSS from the public customer order form
- **Where:** `static/assets/js/views.js` ~line 2426 (`${o.customer_name}`, `${o.table_number}`) and ~line 1295 (`${it.notes}`) are injected into `innerHTML` unescaped.
- **Problem:** `customer_name` and `notes` come from the **unauthenticated** `POST /customer-orders`. A malicious customer can run script in the cashier's or admin's browser and steal the token from `localStorage`. This combines with C1 and C2.
- **Fix:**
  - Add an `escapeHtml()` helper and use it for every user-supplied field.
  - Prefer `textContent`.
  - Escape on the server for stored text too.
  - Move tokens to `HttpOnly` cookies if feasible.

### H2. Customer order endpoint trusts the client for tenant, product and size
- **Where:** `customer_orders.py:14–110`
- **Problems (verified):**
  - An order for tenant 1 containing a **tenant 2** product is accepted (201). The product lookup has no `tenant_id` filter.
  - Quantity `99,999,999` is accepted. There is no cap on items, quantity or text length, and no rate limiting, so it is spam-able.
  - A client-chosen `order_number` that already exists returns **200 "Order already exists"**, so the customer thinks the order was placed. Return 409.
  - A client-supplied lowercase order number is stored as-is, but `/track/` uppercases the lookup, so it returns 404.
  - `tenant_id` comes from the request body. A non-existent tenant is a 500 on Postgres *(by reading)*, and a non-numeric value is a 500.
- **Fix:** validate with Pydantic, filter products by tenant, cap quantity (e.g. ≤ 50), always generate `order_number` server-side, use 409 on duplicates, and add rate limiting.

### H3. Seeding fails about half the time on a fresh database
- **Where:** `app/main.py:143` and `app/routers/inventory.py:411` build SKUs with `abs(hash(name)) % 10000`.
- **Problem:** Python's `hash()` of strings is randomised per process, and only 10,000 SKUs are possible for 125 items. Measured across 100 hash seeds, **48% produced a SKU collision**. The unique `(tenant_id, sku)` constraint then aborts the entire seed. The error is logged and swallowed, so the app starts with **0 products and 0 suppliers**.
- **Verified:** two of the first three boots seeded nothing. One logged `UNIQUE constraint failed: products.tenant_id, products.sku`.
- **Fix:** derive the SKU deterministically (`slug + running number`, or a zlib `crc32`/`sha1` prefix). Seed one item per savepoint so one failure doesn't discard everything. Fail loudly instead of continuing.

### H4. Menu seed data contains 10 duplicate product names
- **Where:** `app/seed_data.py`. Example: `Buko — 16 oz` is in both *Sticky Milk* (₱75) and *Milky Shake Frappe* (₱80).
- **Problem:** `Product` is unique on `(tenant_id, name)`, so only one copy survives. The other category silently loses the item or keeps the wrong price. Affected: Buko, Mango, Choco, Melon (16 and 22 oz) and Caramel Macchiato (16 and 22 oz).
- **Fix:** make names unique (`"Buko Sticky Milk — 16 oz"`) or allow a product to belong to many categories.

### H5. Users can be created without a name → 500; email is not validated
- **Where:** `users.py:174` and `inventory.py:355` both use `int(func.now())`, which raises `TypeError`.
- **Problems (verified):**
  - `POST /users` with no username/name/email returns **500**.
  - `POST /inventory` with no `sku` returns **500**. SKU is optional in the schema, so the default path is broken.
  - `email` is a plain `str`, so `"not-an-email"` is accepted.
  - A super admin can create users for a non-existent `tenant_id`. SQLite allowed it; on Postgres it is a 500 *(by reading)*.
- **Fix:** generate defaults in Python (`uuid4().hex[:8]`, `time.time()`), use `EmailStr`, and validate that the tenant exists.

### H6. Purchase-order flow is inconsistent and can corrupt stock
- **Where:** `app/routers/purchase_orders.py`
- **Problems (verified unless noted):**
  - `PUT /purchase-orders/{id}` with `{"status":"Received"}` marks the PO received **without adding any stock**, and it can no longer be received afterwards.
  - `POST …/receive` works on a **Draft** PO. There is no Draft → Ordered → Received workflow.
  - `quantity_received` is never updated, so "Partially Received" is unreachable.
  - Receiving uses `float()` maths on `Numeric` columns and has no row lock. Two simultaneous clicks double-add stock *(by reading)*.
  - Receiving writes one activity-log row per line item.
  - A 500 response leaks `str(e)` (line 236).
  - PO numbers use "last id + 1" with no lock; concurrent creates collide into a 409 *(by reading)*.
- **Fix:** an explicit status state machine; forbid changing status to `Received` except via `/receive`; use `Decimal` and `SELECT … FOR UPDATE`; write one log per PO; use a DB sequence or retry for PO numbers.

### H7. Deleting suppliers and inventory items has destructive or crashing side effects
- **Where:** `suppliers.py:153`, `inventory.py:589`, `models.py:171`
- **Problems (verified):**
  - Deleting a supplier that has purchase orders returns **500** (the ORM tries to set `supplier_id` NULL on a NOT NULL column).
  - Deleting an inventory item **silently deletes its purchase-order lines** (`cascade="all, delete-orphan"`). Past PO totals no longer match their lines. The test left 0 PO items.
- **Fix:** return 409 with a clear message when the record is in use, or soft-delete (`is_active`). Remove the delete cascade on `purchase_order_items`.

### H8. Audit log can be forged, hidden, or wiped
- **Where:** `app/routers/activity_logs.py`, plus `auth.py` and `users.py`
- **Problems (verified):**
  - **Any user, including a cashier, can read the audit log.** A cashier's `GET /activity-logs` returned 200.
  - `POST /activity-logs` lets any user write an entry with an arbitrary `performed_by` and `role`, for example `superadmin` / `SUPER_ADMIN`. This allows forging evidence.
  - `DELETE /activity-logs` deletes **all** tenants' logs in one call. There is no soft delete, no backup and no confirmation.
  - Login, User Created/Edited/Deleted, Password Reset and Profile events are written **without `tenant_id`**. The Branch Admin's filter (`tenant_id == mine`) therefore never shows them. The admin saw an empty log in the test.
- **Fix:** restrict reading to ADMIN/MANAGER (own tenant) and SUPER_ADMIN. Remove or lock down the public `POST`. Always set `tenant_id` (the target user's tenant). Replace the bulk `DELETE` with retention-based archiving.

### H9. Weak authentication hardening
- **Verified:** 15 wrong passwords against `admin` in a row all returned 401, with **no lockout or throttling**.
- **Also:**
  - Minimum password length is 6 (`123456` was accepted).
  - Default demo accounts (`admin/admin123`, `superadmin/superadmin123`, and so on) are auto-created on **every** deployment, including production, and are printed by `run.py`.
  - Tokens last 12 hours and cannot be revoked after a password change.
- **Fix:** rate-limit `/auth/login` (e.g. `slowapi`) and lock the account after N failures. Require ≥ 10 characters. Only seed demo accounts when `APP_ENV != production`, and force a password change on first login.

### H10. CORS allows every origin with credentials, and API docs are public
- **Where:** `main.py:215–216`
- **Problem:** `allow_origins=["*"]` combined with `allow_credentials=True`. Starlette answers by echoing back the requesting origin. The test showed `Access-Control-Allow-Origin: http://evil.com`. `/docs` and `/openapi.json` are also open on production.
- **Fix:** set `allow_origins` to your real domains from an env var. Disable `/docs` in production (`docs_url=None`) or protect it.

### H11. Role checks are inconsistent across the API (several endpoints are open to every role)
- **Verified / by reading:**
  - A **KITCHEN** account can ring up sales (`POST /transactions` → 201) and list **all** transactions of the tenant (`GET /transactions` → 200). The list shows every cashier's takings.
  - `GET /analytics/dashboard` is documented "Admin only" but works for a cashier (200).
  - `GET /products`, `/categories`, `/inventory` and `/tables` are open to every role.
  - A **SUPER_ADMIN gets 403 when creating or deleting tables**, because the check compares `str(role)` to `"UserRole.ADMIN"` and similar strings (`tables.py:34`).
  - A SUPER_ADMIN's `GET /customer-orders/pending` returns nothing, because it filters `tenant_id == None`.
- **Fix:** define one permission map (`role → allowed actions`) and enforce it with dependencies. Compare enums (`current_user.role in {UserRole.ADMIN, …}`), not strings. Decide explicitly what a super admin may do per tenant.

---

## 🟡 Medium

| # | Where | Problem | Fix |
|---|---|---|---|
| M1 | `kitchen.py:42` | The table label is `"Takeout" if not tx.client_tx_id else "Dine-In"`. `client_tx_id` is always set (auto-UUID), so every order says **Dine-In** *(verified)*. | Store `order_type` and `table_number` on the transaction and show those. |
| M2 | `kitchen.py:35`, `analytics.py:36`, `purchase_orders.py:59,230`, `shifts.py:81` | Mixed time sources: `datetime.now()` (server local), `datetime.utcnow()` (UTC, deprecated) and `func.now()` (DB clock) are all written to naive `DateTime` columns. Shift start/end times can be hours apart from the truth. "Today" is off around midnight. | Use `DateTime(timezone=True)`, store UTC, and convert to the shop's timezone (Asia/Manila) only for "today" and display. |
| M3 | `shifts.py` `end_shift` | There is no expected-cash calculation or variance. `end_cash` is stored with no check against cash sales plus paid-in/out. Open shifts can be left running. The cashier's shift is auto-opened by the first sale with ₱0 float. | Compute `expected = start + cash sales + paid_in − paid_out` and store the difference. Require starting a shift explicitly. |
| M4 | `transactions.py` + `models.py` | `ProductRecipe` is defined but **nothing in the code reads or writes it**. Selling a product **never deducts ingredient stock**, so inventory only goes down by manual adjustments. | Add recipe CRUD and deduct stock inside the sale transaction (with rollback on shortage). |
| M5 | `inventory.py` `import-masterlist` | Names duplicated across departments (`Flour`, `Chicken`, `Lettuce`, `Condense`, `Tongs`, `Fries`, `Sugar`…) overwrite each other's `category`. The second import re-labels any category you changed manually. Equipment items (Laptop, Refrigerator, Dining Chair…) are imported as consumable stock and trigger low-stock alerts. | Key by `(name, category)` or de-duplicate the list. Don't overwrite existing categories. Separate equipment from consumables. |
| M6 | `inventory.py` `adjust_stock`, PO receive | Stock maths uses `float`, and there is no row lock, so concurrent adjustments lose updates *(by reading)*. There is no stock-movement table, only free-text activity logs. | Use `Decimal` and `with_for_update()`. Add a `stock_movements` table. |
| M7 | `products.py` `update_product` | Sending `"price": null` or `"name": null` sets NOT NULL columns to NULL and is reported as **409 "already exists"** *(verified)*. The wrong error hides the real one. | Strip `None` for non-nullable fields or reject with 422. |
| M8 | `AdminProductCreate.image_url` | There is no size limit. A 5 MB `data:` URL was accepted *(verified)* and stored in a `Text` column, which then goes out in every product-list response. | Cap the length, or store uploads as files/object storage and keep only a URL. |
| M9 | `models.py` (`CustomerOrder.order_number`) | `order_number` is globally unique but `tenant_id` defaults to 1 and is not tied to the real tenant. Order status is free text (`pending/accepted/rejected/completed`), unvalidated at DB level. An accepted order is never linked to the resulting transaction. | Per-tenant unique order numbers, a status enum, and a `customer_order_id` on `Transaction`. |
| M10 | `tables.py` | `(tenant_id, table_number)` has no DB unique constraint, so concurrent creates can duplicate it. Deleting a table does not affect the printed QR codes that point to it. | Add the unique constraint. Show a clear "table inactive" message to customers. |
| M11 | `users.py` `update_user` / `/auth/me` | A user can rename themselves freely. There is no re-auth for email/username change, and usernames are case-sensitive, so `Admin` and `admin` can both exist. | Normalise usernames to lowercase and add a case-insensitive unique index. |
| M12 | Frontend wastage page | `cachedWastageLogs` in `views.js:2199` is a **hard-coded array**. "Wastage Track" in the Inventory menu is fake data and nothing is saved. | Build a `wastage_logs` table and endpoints, or hide the menu item until it exists. |

---

## 🔵 Low / Repo & deployment hygiene

| # | Item | Fix |
|---|---|---|
| L1 | **Two copies of the app are committed.** The root `app/` is an older version and lacks `customer_orders`, `shifts`, `tables` and `purchase_orders`. The real app is `fastapi/app/`. `requirements.txt` is also duplicated. | Delete the root `app/` and root `requirements.txt` (or the other way round). Keep one source of truth. |
| L2 | **`Procfile` is broken.** It runs `python migrate_customer_orders.py && uvicorn app.main:app` from the repo root. The script is in `fastapi/` and `app.main` there is the stale copy. | Point it at `fastapi/` (`cd fastapi && …`) or delete it if only Render/Docker is used. |
| L3 | **`push_to_github.bat` runs `git push --force`.** One click can overwrite the remote history. | Delete it or remove `--force`. |
| L4 | **`__pycache__/*.pyc` files are tracked** (16 of them), and `.gitignore` can't remove them retroactively. | `git rm -r --cached app/__pycache__ app/**/__pycache__`. |
| L5 | **Large binary assets in git:** 62 images totalling about 129 MB, with many duplicates (`static/images` vs `static/assets/images`; `blessie.png` and `blessie logo.png` are the same 1.6 MB). Menu photos are 1–2 MB each, which is slow on mobile data. | Keep one copy. Compress to WebP at ≤ 150 KB. Consider object storage/CDN. |
| L6 | **Duplicate / dead frontend files.** `static/js/*` and `static/assets/js/*` are two *different* versions of the same scripts. Only `storage.js` and `customer.js` are loaded from `static/js/`. The rest, plus `dummy_new_customer.js` (1,755 lines) and `pages/uploaded_customer.html`, are unused. `admin.html`, `manager.html` and similar also exist in several differing copies. | Pick one directory, delete the rest, and make `main.py` serve a single file per page (it currently falls back across three locations). |
| L7 | **Hard-coded production URL** in QR codes: `https://foodhub-xbdi.onrender.com/customer?table=…` (`views.js:2526`). QR codes generated on staging or localhost point to production. | Use `window.location.origin` or a config value. |
| L8 | **`fastapi/.env.example` is empty.** There is no documentation of `DATABASE_URL`, `JWT_SECRET`, `DB_*`. `PROJECT.md` still describes MySQL, port 3307 and `app/seed.py`, none of which match the PostgreSQL code. The API title string says "MySQL". | Fill in `.env.example`, update `PROJECT.md`, and fix the FastAPI `description`. |
| L9 | **No migration tool.** The schema changes through `create_all` plus ad-hoc scripts (`migrate_customer_enum.py`, `migrate_image_url.py`, `migrate_customer_orders.py`). `create_all` never alters existing tables. | Adopt Alembic. |
| L10 | **Tests are scripts, not a suite.** `test_complete_system.py` and `test_crud_persistence.py` hit a live server or the configured DB, and `run.py --test` runs them against it. There is no `pytest`, CI, test database or cleanup. Root-level `scratch_test.py`, `test_po.py`, `check_db.py`, `check_suppliers.py` and `split_html.py` are throw-away scripts. | Create a `tests/` folder with pytest, an isolated test database (the harness used for this audit is a starting point), and a CI job. Remove or move the scratch scripts. |

Other small notes:
- Startup errors in `lifespan` are logged and **swallowed**, so the app can come up "healthy" with no tables or seed data (see H3). Re-raise in production.
- Money is serialised as `float` in the transactions, kitchen and customer-order responses. Return strings or `Decimal` to avoid rounding drift.
- `/transactions` list loads items, products, payments and user with `joinedload` for up to 200 rows per request. This is fine at small scale but worth paginating with a total count.

---

## Suggested fix plan

**Day 1 — close the holes (C1–C5, C9, H1, H10):** add auth and tenant checks to customer orders and kitchen; add `require_admin` to `/users`; delete `/seed-super-admin`; make `JWT_SECRET` mandatory and rotate it; stop the user-delete cascade; escape customer text in the UI; lock down CORS.

**Day 2 — make money correct (C6–C8, H2, H5):** Pydantic models for sales; one DB transaction per sale; idempotent `client_tx_id`; payment-vs-total check; proper `completed` status; fix the two `int(func.now())` crashes.

**Day 3 — data and workflows (H3, H4, H6–H9, H11, M1–M4):** deterministic SKUs and unique menu names; PO state machine; safe deletes; audit-log fixes; login throttling; a role/permission map; timezone-aware timestamps; recipe-based stock deduction.

**Then:** the Medium and Low items, and turn `harness.py` from this audit into a real `pytest` suite so the fixes stay fixed.

---

## Appendix — probe results (SQLite run)

Passed (22): all 6 role logins; customer order create; superadmin pending orders; cross-tenant product blocked on the POS endpoint; sale creation; negative opening stock rejected; masterlist import; inventory SKUs unique (in the lucky run); PO create; cashier blocked from tables; duplicate table rejected; shift start/end; no-active-shift response; `/auth/me` hides the hash; all 15 HTML routes return 200.

Failed (48): every item flagged above under C1–C9, H1–H11 and the M-items marked *Verified*.

The harness script used for this audit is `harness.py` in the Claude session scratchpad, and it is easy to convert to pytest. Ask if you want it added to the repo.
