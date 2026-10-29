# Production Readiness Audit — Inbox POS (Blessie FoodHub)

_Audit date: 2026-10-23 · Scope: FastAPI backend (`app/`), static frontend (`static/`), deployment config, repo hygiene, tests._

Findings come from reading the code. Nothing was run against a live database, so each item is "found in code", not "reproduced". Severity:

- **P0**: blocker. Do not go live until fixed.
- **P1**: fix before or immediately after launch.
- **P2**: hardening and cleanup.

---

## Summary

| Area | Verdict |
|---|---|
| Authentication | Solid base (bcrypt, JWT, HttpOnly cookie, single-session `token_version`). Weak defaults and no brute-force protection. |
| Authorization (RBAC) | **Not production-safe.** Several routers only check "is logged in", not role. |
| Multi-tenant isolation | Mostly good on authenticated routes. Public/WebSocket routes leak across tenants. |
| Secrets | **A real DB password is in git history.** Hardcoded fallback JWT secret and default passwords. |
| Money / inventory logic | Core sale totals are server-computed (good). No stock deduction on sale found. |
| Deployment | Duplicate code tree, a broken Procfile, no migrations, a public `/test-db` endpoint. |
| Tests | Two test files, DB-dependent, no CI. |

---

## P0 — Blockers

### P0-1. Staff-management endpoints have no role check (privilege escalation)
**Where:** [app/routers/users.py](app/routers/users.py) — `create_user`, `update_user`, `reset_user_password`, `toggle_user_status`, `delete_user`, `get_users`, `get_user_by_id`, `/stats`.

All of them use only `Depends(get_current_user)`. The tenant filter hides ADMIN/SUPER_ADMIN rows, but **any logged-in role** can call them. That includes CASHIER, KITCHEN and CUSTOMER, because customers self-register publicly and get a valid token.

Examples:
- A cashier can `POST /api/v1/users` with `role: MANAGER`, then log in as that manager.
- A customer can reset the password of any manager, cashier, inventory or kitchen user in tenant 1, then log in as them.
- A cashier can deactivate or delete other staff.

**Fix:** add a dependency such as `require_admin_or_manager` (or `require_admin`, matching your business rules) to every route in this router. Block CUSTOMER from every staff API. Add tests for 403 per role.

### P0-2. Customers (and any role) can use staff APIs
`get_current_user` accepts a CUSTOMER token everywhere it is the only guard. Examples:
- `POST /transactions`: a customer can record POS sales and auto-open a shift (see P1-3).
- `/tables` (list), `/shifts/*`, `/kitchen/*`, `/customer-orders/pending`, `/activity-logs` (POST), `/analytics`.

**Fix:** one shared `require_staff` dependency (non-CUSTOMER) as the baseline for every `/api/v1` router except `/auth` and the public customer-ordering routes. Then add narrower role guards per route:
- Cashier: sales and shifts.
- Kitchen: kitchen status.
- Manager/Admin: voids, expenses, tables.

### P0-3. Unauthenticated write/read endpoints on customer orders
**Where:** [app/routers/customer_orders.py](app/routers/customer_orders.py)

- `PUT /customer-orders/{order_id}/status` has **no auth at all**. Anyone on the internet can accept, reject or complete any tenant's order by ID. IDs are sequential, so this is trivially scriptable.
- `GET /customer-orders/history?customer_name=` has **no auth and no tenant filter**. It returns other customers' names, tables, items and totals across all tenants. An empty `customer_name` dumps recent orders.
- `GET /customer-orders/track/{order_number}` is public and has no tenant filter. The order numbers are `CUST-` plus 6 hex characters, which is guessable. A `tracking_token` is generated but **never checked**.
- Kitchen `PUT /kitchen/orders/{id}/status` for `CUST-*` orders looks up the order by ID **without a tenant filter**, so one tenant's staff can modify another tenant's orders.

**Fix:**
- Require staff auth plus a tenant filter on `PUT .../status`.
- Remove `/history`, or require the customer's own token and filter by `user_id`.
- Make `/track` require `order_number` **and** `tracking_token`.
- Use a longer random order reference.

### P0-4. Customer order prices are trusted from the client
**Where:** [customer_orders.py:75-98](app/routers/customer_orders.py#L75-L98)

The price is taken from the request body. The DB price is used only when the client sends a price `<= 0`. An attacker can submit `price: 0.01` for any product. Compare `POST /transactions`, which correctly ignores the client price.

Also: `tenant_id` comes from the body with no check that the tenant exists. `int(...)` and `Decimal(str(...))` on bad input raise 500s. `quantity` has no upper bound. Negative prices are accepted when a `product_id` is absent.

**Fix:**
- Always load the product from the DB and use its price. Reject unknown or inactive products.
- Validate the body with a Pydantic schema (`gt=0`, `le=` limits).
- Verify the tenant.
- Rate-limit the endpoint (see P1-1).

### P0-5. WebSocket is unauthenticated and tenant-spoofable
**Where:** [app/routers/realtime.py](app/routers/realtime.py)

`/ws/{tenant_id}` accepts anyone. Any client can pick any `tenant_id` and receive live order, kitchen, drawer and `FINANCIAL_UPDATED` events. The `CUSTOMER_ORDER_CREATED` event also carries `tracking_token`, which would defeat P0-3's fix. The route is also registered twice (`/api/v1/ws` and `/ws`).

**Fix:** authenticate on connect (cookie or `?token=`), derive the tenant from the user instead of the URL, drop customer-facing secrets from broadcasts, and register the route once. Add an idle timeout and a connection cap.

### P0-6. Real database credential committed to git history
Commit `b926dd9` contains `.env.example` with a **real Supabase host, user and password**. The local `app/.env` also keeps the same credential in a commented line. Deleting the file later does not remove it from history, and GitHub is the remote (`push_to_github.bat`).

**Fix, in order:**
1. **Rotate the Supabase database password now.** Treat it as compromised.
2. Purge history with `git filter-repo` (or BFG) and force-push, or recreate the repo.
3. Remove the commented credentials from local `.env` files.
4. Keep `.env.example` placeholder-only.

### P0-7. Hardcoded default credentials and secrets
- [app/main.py:76-151](app/main.py#L76-L151) seeds **on every startup**: `superadmin/superadmin123`, `admin/admin123`, `manager/manager123`, `cashier/cashier123`, `inventory/inventory123`, `kitchen/kitchen123`. Any of these that is missing is **re-created at every boot**, even after you delete it. This runs in production.
- `POST /seed-super-admin` is **public** and creates `superadmin/superadmin123` if none exists.
- [security.py:7](app/core/security.py#L7): `JWT_SECRET` falls back to a hardcoded string, which makes tokens forgeable if the env var is missing. The local `.env` sets `ACCESS_TOKEN_EXPIRE_MINUTES=72082` (about 50 days), which contradicts the 1-day tokens that `auth.py` actually issues.

**Fix:**
- Remove the demo-user seeding in production (guard it with `APP_ENV != production`).
- Delete `/seed-super-admin`.
- Create the first super admin from an env-driven one-off script that forces a password change.
- Make the app **refuse to start** if `JWT_SECRET` is unset or shorter than 32 characters when `APP_ENV=production`.
- Rotate any password that has ever been one of the defaults above.

### P0-8. Public customer registration can pick the tenant
**Where:** [auth.py:239-325](app/routers/auth.py#L239-L325)

`CustomerRegisterRequest.tenant_id` is honoured as-is, so anyone can create accounts in any tenant. Combined with P0-1/P0-2, **self-registration is the entry point for privilege escalation**. There is no rate limit, captcha or email verification, and the minimum password length is unchecked in this handler (confirm in the schema).

---

## P1 — Fix before or right after launch

### P1-1. No brute-force or rate limiting
There is no throttling or lockout on `/auth/login` or `/auth/register`, and none on public order endpoints. Add `slowapi` (or an upstream proxy limit), per-IP and per-username lockout/backoff, and log failed logins. Login also does `username == X OR email == X`, so username and email namespaces can collide. Normalise to lowercase and enforce case-insensitive uniqueness (registration already checks it, but `create_user` does not).

### P1-2. `CORS: allow_origins=["*"]` with `allow_credentials=True`
[main.py:204-210](app/main.py#L204-L210). Starlette makes this combination echo any origin with credentials, so any website can make authenticated cross-origin calls with the user's cookie, which is `SameSite=Lax` and so only partly mitigates this. Restrict to your real domain(s) via an env var. Add CSRF protection if cookie auth is kept for state-changing calls, or require the `Authorization` header only.

### P1-3. Transaction creation: shift and payment integrity
[transactions.py:129-320](app/routers/transactions.py#L129-L320)
- **Silent shift creation:** if no open shift exists, one is created with `start_cash = 0`. This bypasses the drawer-count flow and distorts cash reconciliation.
- **Discount, tax and payment amounts come from the client.** `discount_amount` can exceed the total, which clamps net to 0 (a free sale). Payments are not checked against `net_amount` (under- or over-payment is accepted). The client can set `status` directly, including `completed`.
- Negative `quantity` is not rejected (`qty` can be 0 or negative and produces negative lines).
- Two `db.commit()` calls leave a window where a failure creates a transaction with no items or payments. Use one atomic transaction.
- **No inventory deduction on sale** was found in `transactions.py` or anywhere else outside inventory adjustments, even though recipes (`ProductIngredient`) and inventory items exist. Confirm whether stock is meant to decrement on sale. If so, this is a functional gap.
- The `client_tx_id` unique constraint is **global**, but the duplicate check is per tenant. A collision across tenants would raise a 500.
- There is no cap on discounts and no manager approval for voids or refunds. `PUT /transactions/{id}/status` has no role check, so a cashier can void or reject any sale in the tenant.

### P1-4. Missing tenant scoping when `tenant_id` is NULL
Several routes do `if current_user.tenant_id: filter(...)`, so a NULL-tenant user (SUPER_ADMIN) sees all tenants, which is fine. Others default to "first tenant" or `1` (`tables`, `customer_orders`, `get_*_tenant_id`). This silently reads or writes the wrong branch if a second tenant is added. Replace the `or 1` fallbacks with an explicit tenant selection for super admins.

### P1-5. Schema management
- `Base.metadata.create_all()` runs on startup. **There is no migration tool** (Alembic).
- Ad-hoc migration scripts (`migrate_customer_orders.py`, `migrate_customer_enum.py`, `migrate_image_url.py`) are run from the Procfile. A failing script blocks boot, and none is idempotent-tracked.
- Startup swallows DB init errors (`logger.critical` then `yield`), so the app "starts" with no database and only fails at the first request.

**Fix:** adopt Alembic with a baseline migration, run it as a release step (not in the web start command), and let startup fail hard when the DB is unreachable.

### P1-6. Public diagnostic endpoint
`GET /test-db` is unauthenticated and returns DB name, host, port, tenant and user counts, and the raw exception string on failure. It is also used as the Docker/Render health check. Split it: a minimal `/healthz` (returns `{"status":"ok"}`, optionally a `SELECT 1`) for probes, and remove the detailed version or put it behind SUPER_ADMIN. Also disable or protect `/docs`, `/redoc` and `/openapi.json` in production if you don't want the API surface published.

### P1-7. Deployment config is inconsistent
- **Two copies of the project:** `app/` + `static/` at the root, and `fastapi/app/` + `fastapi/static/` (currently identical for `.py` and `static`). `render.yaml` and the Dockerfile run from `fastapi/`, while the Procfile and `run.py` run from the root. Someone will edit one copy and deploy the other.
- **Procfile is broken at the root:** it runs `migrate_customer_orders.py`, which exists only under `fastapi/`.
- `render.yaml` uses `plan: free` (cold starts, and the free Render Postgres expires). It also sets `ACCESS_TOKEN_EXPIRE_MINUTES=720`, but `auth.py` ignores it and hardcodes 1 day.
- `APP_ENV=production` is never set in `render.yaml`, so the session cookie `secure` flag stays **off**. Add `APP_ENV=production`.
- The Dockerfile runs as **root**, uses `COPY . .` (which ships backups, `.env`, the 122 MB images and the junk folders, since `.dockerignore` must be verified), and runs a single uvicorn worker with no `--proxy-headers`. Add a non-root user and `--proxy-headers --forwarded-allow-ips`.
- `requirements.txt` has no upper bounds or lockfile (`fastapi>=`). Pin exact versions (`pip-compile` / `uv lock`).
- Both MySQL and PostgreSQL are supported, but only one should be the production target. The code has several dialect-specific paths (`ilike`, enums), and only one DB has been tested at a time. Pick one and test it.

### P1-8. Browser token storage and XSS surface
- The JWT is stored in `localStorage` (`access_token`) and also set as an HttpOnly cookie. `localStorage` is readable by any XSS, which defeats the point of the HttpOnly cookie. Rely on the cookie alone.
- There are about 150 `innerHTML` assignments in `static/assets/js`. Product names, customer names, notes, table numbers and expense descriptions are user-controlled. Any unescaped one is stored XSS that runs in a manager's session (and the customer name from the **unauthenticated** order form reaches the cashier/kitchen screens). Audit each with `escapeHtml` or switch to `textContent`.
- Add security headers: CSP, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, HSTS (at the proxy).

### P1-9. Audit-log reliability
- Many logs are written in `try/except: pass` and some are missing `tenant_id` (`users.py` logs omit it, so the admin's tenant-filtered view will never show user-management events, and they will show only for SUPER_ADMIN).
- Any user can `POST /activity-logs` with arbitrary `performed_by`, `role` and `details`, which means **forged audit entries**. Remove the endpoint or ignore client-supplied identity fields.
- `DELETE /activity-logs` wipes the whole table for every tenant. Restrict to a soft archive, or remove it.

### P1-10. Password and session policy
- `change_password` and the admin reset do not enforce complexity and do not bump `token_version`, so existing sessions stay valid after a password change/reset. Bump it.
- Logout only increments `token_version` when the token decodes; a failure path is silently ignored.
- Every login increments `token_version`, which logs the user out everywhere else. This is intended ("single session"), but it will surprise shared-tablet setups (cashier and kitchen on one account). Document or make configurable.

---

## P2 — Hardening and cleanup

1. **Repo clutter in the deploy artifact:** `users dashboard-20260823T115318Z-1-001/` (twice), `scratch_test.py`, `test_po.py`, `check_suppliers.py`, `split_html.py`, `build_customer_js.py`, `push_to_github.bat`, committed `__pycache__/*.pyc`, `app/seed.py` (1 line), duplicate JS in `static/js` vs `static/assets/js`, duplicate pages (`static/*.html` vs `static/pages/*.html` vs `static/admin/`), `create-user.js` vs `create_user.js`. Delete or move to `/tools`, and tidy `.gitignore` (it already lists `__pycache__/` but the `.pyc` files are tracked, so run `git rm -r --cached`).
2. **`supabase_setup.sql` is tracked** (despite the `*.sql` ignore) and includes `INSERT INTO "users"` rows with **password hashes**. Remove it from git. Local `backups/*.sql` are untracked (good) but contain full production-like data. Keep them off the repo and out of Docker images.
3. **`/static` mounts the whole static tree publicly.** Role-gated pages (`/static/pages/admin.html`, `/static/super_admin/*.html`) are reachable directly, **bypassing the server-side role guard**, because only the clean routes use `serve_protected_page`. The API is still protected, but the UI shell and its JS are exposed. Serve only `/static/assets` and the public pages, or move protected HTML outside the mount.
4. **122 MB of images in `static/images`** (67 tracked files): compress, convert to WebP, add cache headers for hashed assets (currently only HTML gets no-cache headers), and consider a CDN.
5. **Pagination and limits:** `GET /transactions`, `/products`, `/customer-orders/history` and analytics have inconsistent or no limits. Add a default `limit` and an upper cap everywhere.
6. **N+1 queries and loops:** e.g. `/customer-orders/menu` queries per category; kitchen and analytics build lists with per-row queries. Add `joinedload` / aggregates. Add indexes for hot filters (`customer_orders.tenant_id,status`, `customer_orders.order_number`, `inventory_items.tenant_id`). `InventoryItem.tenant_id` currently has no index.
7. **Money handling:** `Numeric(10,2)` is correct. A few places convert with `float(...)`, which is acceptable for JSON but avoid arithmetic on floats. `Numeric(10,2)` caps at 99,999,999.99; confirm that's enough for daily totals if you aggregate in SQL.
8. **Timezones:** `DateTime` columns are naive with `server_default=func.now()`. "Today"/"this week" reports depend on the DB server timezone. Decide on UTC storage with an explicit business timezone (e.g. Asia/Manila) for report bucketing.
9. **Error responses leak internals:** `/seed-super-admin` and `/test-db` return `str(e)`. Add a global exception handler that logs the traceback and returns a generic message plus request ID.
10. **Logging and monitoring:** only `basicConfig(INFO)`. Add structured logs, request IDs, Sentry (or similar) and uptime alerts. `print`/traceback strings are logged as plain text in places.
11. **Backups and recovery:** backups are manual SQL dumps from the handover script. Set up automated daily backups (managed Postgres PITR) and run a restore drill once.
12. **PWA / offline:** `client_tx_id` implies offline sync, but no service worker or offline queue was found in the audited files. Confirm whether offline mode is a promised feature; if so it is missing, if not remove the dead field/comments.
13. **Receipts/printing, tax config, currency:** the ₱ symbol and tax/discount values are free-form per request. There is no tenant-level tax rate, service charge or receipt-numbering setting; `TXN-{id:04d}` is not gap-free or per-branch. Fine for MVP, but compliance-sensitive (BIR in PH) if this is a real tax receipt.
14. **Data retention and privacy:** customers store name, phone and email. Add a privacy notice, a deletion/anonymisation path (`DELETE /users` hard-deletes and may violate FK `RESTRICT` on shifts/transactions, so prefer soft-delete), and avoid logging PII in activity details.

---

## Tests and CI (gaps)

- Only `tests/test_api_integration.py` and `tests/test_financial_calculations.py` exist, plus loose scripts at `fastapi/test_*.py`. The integration tests need a **live DB with the seeded default users and passwords** (which P0-7 says to remove), and they write real data.
- No tests for: the P0 authorization holes (cashier creating users, customer calling staff routes, unauthenticated order status), tenant isolation, discount/payment validation, shift lifecycle, customer-order pricing, or WebSocket auth.
- No CI. Add GitHub Actions: lint (`ruff`), `pytest` against a throwaway Postgres/SQLite service, `pip-audit`.
- Use a test DB fixture with its own users instead of the production seed accounts.

---

## Suggested order of work

**Day 0 (stop the bleeding)**
1. Rotate the Supabase password (P0-6) and purge history.
2. Add role guards to `users.py` and block CUSTOMER from staff APIs (P0-1, P0-2).
3. Lock down `customer-orders` status, history and track (P0-3) and the WebSocket (P0-5).
4. Remove `/seed-super-admin` and production demo-user seeding. Require a strong `JWT_SECRET` (P0-7).

**Week 1**
5. Server-side pricing and validation for customer orders and transactions (P0-4, P1-3).
6. Restrict CORS, set `APP_ENV=production`, add rate limiting (P1-1, P1-2, P1-7).
7. Collapse to a single code tree, fix the Procfile/Dockerfile, pin dependencies (P1-7).
8. Add Alembic, `/healthz`, and a global error handler (P1-5, P1-6, P2-9).
9. Escape-audit the `innerHTML` uses, drop `localStorage` tokens, add security headers (P1-8).

**Before handover**
10. Write the authorization/tenant-isolation tests and CI (Tests section).
11. Decide on stock deduction on sale, timezone and tax requirements (P1-3, P2-8, P2-13).
12. Automated backups plus a restore drill (P2-11), then repeat the handover reset on a clean DB and verify there are no leftover default users.

---

## Pre-launch checklist

- [ ] Supabase/DB password rotated; git history purged
- [ ] `JWT_SECRET` set (32+ random chars); app refuses to boot without it in production
- [ ] `APP_ENV=production`; secure cookies verified over HTTPS
- [ ] Default demo users and `/seed-super-admin` removed; first admin created with a unique password
- [ ] Every `/api/v1` route has an explicit role dependency; CUSTOMER blocked from staff APIs
- [ ] Customer-order endpoints authenticated or tokenised; prices server-side
- [ ] WebSocket authenticated; tenant derived from the user
- [ ] CORS restricted to the real origin(s)
- [ ] Rate limiting on login, register and order submission
- [ ] `/test-db` replaced by a minimal `/healthz`; `/docs` disabled or protected
- [ ] One code tree; Procfile/Dockerfile/render.yaml consistent; non-root container
- [ ] Alembic migrations in place; DB failures stop startup
- [ ] Dependencies pinned; `pip-audit` clean
- [ ] `innerHTML` audit complete; CSP and security headers in place
- [ ] RBAC and tenant-isolation tests passing in CI
- [ ] Automated backups enabled; restore tested
- [ ] Monitoring and error tracking live
