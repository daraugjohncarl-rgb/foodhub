# Production-readiness remediation status

Companion to `PRODUCTION_READINESS.md` (audit of 2026-10-23). Each finding was re-verified against the
code before it was changed. **Nothing here was deployed, committed, or applied to any remote database.**
Statuses: **Fixed** (code + tests), **Partial**, **Deferred** (needs a decision or is out of scope),
**Blocked** (needs a manual action outside the code).

## Test environment (what "tested" means)

All automated tests run against a throwaway SQLite file created by `fastapi/tests/conftest.py`, which asserts the engine is
SQLite so the suite cannot touch MySQL or Supabase. No PostgreSQL, Docker or Supabase CLI was available, so:
SQL migrations were **syntax-checked with the PostgreSQL parser (`pglast`) but not executed**; RLS behaviour, the Docker image,
Supabase connectivity and the live deployment were **not tested**. A live migration test exists and runs when
`TEST_POSTGRES_URL` points at a disposable PostgreSQL database (CI provides one).

Command: `cd fastapi && pip install -r requirements-dev.txt pglast && pytest -q`

## P0

| ID | Status | What changed | Tests |
|---|---|---|---|
| P0-1 staff-management RBAC | **Fixed** | Every `/users` route requires MANAGER/ADMIN/SUPER_ADMIN. New accounts always take the caller's tenant (body `tenant_id` ignored). No self role/status change or self password reset through admin routes. Password reset, deactivation and role change bump `token_version` (sessions revoked). `SUPER_ADMIN` must name a tenant explicitly. | `test_authorization.py` |
| P0-2 customers/other roles on staff APIs | **Fixed** | Shared guards in `core/dependencies.py`: `require_staff`, `require_pos_access` (cashier, manager, admin, super admin), `require_kitchen_access`, `require_menu_read`, `require_inventory_access`, `require_manager_or_admin`, `require_admin`. Applied to every router. Parametrized tests prove 401 unauthenticated and 403 for CUSTOMER on 25 staff endpoints. | `test_authorization.py` |
| P0-3 customer-order endpoints | **Fixed** | `PUT .../status`, `/history`, `/pending` are staff-only and tenant-scoped; status transitions validated (final states locked). `/track/{order}` needs the per-order tracking token in the `X-Tracking-Token` header (constant-time compare, 404 on mismatch, throttled). Order refs are 48-bit random (`CUST-` + 12 hex). Kitchen status updates are tenant-filtered and validated. | `test_customer_orders.py` |
| P0-4 trusted prices | **Fixed** | Pydantic schema; only `product_id`, `quantity`, `variant` are read. Name/price/total come from the DB for active products of the resolved tenant. Qty 1-50, 50 lines, 200 units, notes 500 chars. Tenant must exist and be active. `Idempotency-Key` header prevents duplicates; IP rate limit 10/min. | `test_customer_orders.py` |
| P0-5 WebSocket | **Fixed** | Auth via cookie/Bearer; tenant derived from the user (URL tenant must match; only SUPER_ADMIN may name one); CUSTOMER and anonymous refused; Origin check; connection caps; 90 s idle timeout; 64-byte messages; session re-validated on each ping; broadcasts scrubbed of token fields and `tracking_token` removed from events; route registered once; worker-thread broadcasts now scheduled onto the owning event loop. Customer page polls instead of using a socket. | `test_realtime.py` |
| P0-6 credential in git history | **Blocked (manual)** | Cannot be fixed in code. History contains credential-like lines in at least 5 commits touching `.env.example` (counts only, values not printed). Local `.env` and `app/.env` still hold commented Supabase credentials (not modified: they may be your only copy). See "Manual actions". | - |
| P0-7 default accounts / secrets | **Fixed** (code) | Startup seeding removed; demo users only with `SEED_DEMO_DATA=true` and never in production. `/seed-super-admin` deleted. `JWT_SECRET` >= 32 chars enforced in production; the hardcoded fallback is gone (dev uses a random per-process secret). One-time `scripts/bootstrap_admin.py`. Token/cookie lifetime follows `ACCESS_TOKEN_EXPIRE_MINUTES`. Tokens without a matching `token_version` are rejected. Any password that ever matched a default must still be rotated. | `test_configuration.py`, `test_migrations_and_scripts.py` |
| P0-8 registration picks tenant | **Fixed** | Tenant must exist and be active; inferred only when exactly one is active; role is always CUSTOMER; case-insensitive username/email checks; 10/hour/IP; password >= 8. | `test_authorization.py` |

## P1

| ID | Status | Notes |
|---|---|---|
| P1-1 rate limiting | **Partial** | Login (IP + per-username/IP lock-out), registration, order submission, menu, tracking. In-process only: add the same limits at the proxy before running more than one instance. Username/email case-insensitivity enforced in code; DB-level via migration 2 (prepared). |
| P1-2 CORS / CSRF | **Fixed** | No wildcard (startup fails if configured); explicit `ALLOWED_ORIGINS`; cookie-authenticated writes from a foreign `Origin` get 403 on top of `SameSite=Lax`; `ALLOWED_HOSTS` supported; secure cookie in production. |
| P1-3 transactions / money | **Partial** | Fixed: server-side totals with `Decimal` (2 dp, half-up), qty 1-100, tax/discount >= 0 and discount <= order total, payments validated against the computed amount, status limited to pending/completed on create, single atomic commit (rollback tested), tenant-scoped idempotency, tenant-scoped `GET /transactions/{id}` (was readable across tenants), role guards. **Open business decisions:** (1) auto-opening a zero-cash shift (kept, flag `AUTO_OPEN_SHIFT`; the UI never calls `/shifts/start`), (2) who may void/refund and any manager approval or discount cap per role, (3) stock deduction on sale, (4) tax/service-charge/receipt-numbering policy. A test documents that stock is **not** deducted. |
| P1-4 tenant fallbacks | **Fixed** | All `first tenant`/`or 1` fallbacks removed. `SUPER_ADMIN` selects a tenant with `X-Tenant-ID`; with exactly one tenant it is inferred. Note: read-only list endpoints (products, categories, inventory, users) intentionally still span all tenants for a tenant-less `SUPER_ADMIN`. |
| P1-5 schema management | **Partial** | `create_all` and seeding off in production; no migration scripts in the start command; DB failure aborts startup. SQL migrations prepared in `supabase/` (Alembic not adopted: SQL files match Supabase tooling). Legacy `fastapi/migrate_*.py` scripts remain but nothing runs them. |
| P1-6 diagnostics | **Fixed** | `/test-db` removed; `/healthz` and `/readyz` disclose nothing; docs/OpenAPI off in production. |
| P1-7 deployment config | **Partial** | `fastapi/` is the single deployed tree (Procfile, Dockerfile, render.yaml, root `main.py` updated). Non-root container, `/healthz` probe, proxy headers, pinned dependencies (`requirements.txt`/`requirements-dev.txt`), Render Postgres block removed (Supabase is the database). The root `app/` and `static/` were **not deleted**; they were refreshed from `fastapi/` so no stale vulnerable copy remains. Delete them once you confirm nothing deploys from the repository root. Docker build not verified. |
| P1-8 frontend | **Partial** | Escaping added at every sink that renders customer-controlled data (customer name, table, notes, item names, order numbers) plus the toast helper; table labels restricted server-side to `[\w .#-]`; CSP and other security headers added (CSP still needs `'unsafe-inline'` because the UI uses inline handlers). **Not done:** audit of the remaining ~140 `innerHTML` uses with staff-entered data (products, suppliers, expenses), and moving the JWT out of `localStorage` (needs a UI-wide change to rely on the cookie; deferred deliberately). |
| P1-9 audit logs | **Fixed** | Actor and role always come from the session; log routes limited to MANAGER+; user-management events now carry `tenant_id`; clearing remains SUPER_ADMIN-only and now leaves a tombstone entry. |
| P1-10 password/session policy | **Fixed** | Self-service change and admin reset revoke sessions; deactivation and role change revoke sessions; min length 8. The single-session login behaviour (new login signs out other devices) is unchanged and is a poor fit for a shared cashier/kitchen tablet account: give each person their own account. |

## P2

Fixed: P2-3 (protected HTML no longer served through `/static`), P2-9 (generic errors + request IDs), P2-6 partly (menu N+1 removed; missing indexes in migration 2).
Partial: P2-5 pagination (caps added on transactions, history, pending, users, logs, products, inventory; analytics/reports not reviewed), P2-10 (request IDs only; no Sentry), P2-11 (documented in `docs/DEPLOYMENT.md`, nothing configured or rehearsed).
Deferred: P2-1 repo clutter (`users dashboard-*`, `scratch_test.py`, committed `.pyc`, duplicate `static/js` vs `static/assets/js`; the two JS trees are both loaded by different pages, so edits must be mirrored), P2-2 (`supabase_setup.sql` is still tracked and contains password hashes: run `git rm --cached supabase_setup.sql` after deciding), P2-4 images, P2-7 money columns (arithmetic is `Decimal`; `float` only in JSON output), P2-8 timezones, P2-12 offline mode, P2-13 tax/receipts, P2-14 privacy/retention.
Product `cost` is still returned to every role that can list products (cashier/kitchen included) because the UI shares one response shape; consider a trimmed schema for non-management roles.

## Supabase changes (prepared only)

`supabase/migrations/20261023000001..3_*.sql` and matching `supabase/rollbacks/`. Not applied to any database. See `docs/DEPLOYMENT.md`.

## Manual actions required

1. **Rotate the Supabase database password now** and treat everything in the old git history as compromised. Rotate any password that ever equalled a seeded default (`superadmin123`, `admin123`, ...).
2. Purge history (`git filter-repo`/BFG) and force-push, or recreate the repository; this was not done (it rewrites shared history and needs your approval). `push_to_github.bat` force-pushes: review before using.
3. Remove the commented Supabase credentials from the local `.env` and `app/.env` after storing them in a password manager.
4. In the Supabase Dashboard: confirm the backup/PITR plan, rehearse a restore, and review the project's exposed schemas/API settings. After migration 3, verify with the `anon` role that tables return nothing.
5. Set the production environment variables listed in `docs/DEPLOYMENT.md`; create the first admin with `bootstrap_admin.py`.
6. Decide the open business items under P1-3.

## Remaining risks

- Live PostgreSQL/Supabase behaviour (migrations, RLS, pooler settings, the production database's actual schema vs the models, e.g. `stock_movements`) is unverified.
- No DB-level tenant isolation: cross-tenant references are prevented by application checks only (composite foreign keys documented as follow-up).
- In-process rate limiting and WebSocket registry do not span multiple instances.
- Remaining `innerHTML` sinks with staff-entered data; JWT still in `localStorage`; CSP allows inline scripts.
- Legacy live-DB scripts (`tests/` at the repository root, `fastapi/test_*.py`, `run.py --test`) depend on removed demo users/`/test-db` and are superseded by `fastapi/tests/`.

## Assessment

Ready for a **staging test** (against a Supabase branch or restored copy with the migrations applied and the checklist above executed). **Not ready for production** until credentials are rotated and history is dealt with, migrations are rehearsed on PostgreSQL, the business decisions in P1-3 are made, the remaining frontend sinks are reviewed, and a restore has been rehearsed.

---

# Phase 2 (2026-10-24): remaining P1 security risks

Validation environment for everything below: **SQLite** (API tests), **jsdom** (front-end DOM tests, Node 23), and a PostgreSQL **parser** (`pglast`, syntax only). PostgreSQL, Supabase, RLS, Docker and Render were **not** run or tested (none available locally).

Commands and actual results:

- `cd fastapi && pytest -q` -> **191 passed, 1 skipped** on the previous pins, and **191 passed, 1 skipped** again on the new patched pins (separate venv). The skip is the live-PostgreSQL migration test, which needs `TEST_POSTGRES_URL`.
- `cd fastapi/tests/js && npm test` -> **36 passed**. Mutation check: the same jsdom suite run against the pre-fix front-end files **fails 24 of 36**, so the tests do detect the vulnerabilities.
- One failure was seen once in an interrupted, overlapping run on the patched pins; it did not reproduce when the affected files were rerun individually or in the later full run. Cause not identified (suspected timing under parallel load).

| Finding | Verdict | What was done |
|---|---|---|
| **P1-8a XSS audit** | **Mostly fixed** | Audited every JS template literal in `static/js` and `static/assets/js` with a codemod (`fastapi/scripts/xss_autoescape.py`): data reads inside HTML templates are wrapped in `Utils.escapeHtml`; inline-handler arguments use `Utils.jsArg` (JSON literal + HTML escape, because HTML escaping alone is unsafe inside a JS string); toast text uses `textContent`. Manual fixes for ternaries, modal titles, notifications (HTML now built from escaped parts) and the tables QR buttons. `Utils.escapeHtml/jsArg` also ship in `storage.js`, so super-admin and customer pages (which do not load `utils.js`) have them. jsdom tests render hostile data (script/img/svg/quote-breakers/entity-encoded breakouts) through the online-orders modal, customer-orders view, supplier/inventory/product tables, users, logs, kitchen, tables and toasts, and assert no markup, no injected handler and no executed code. **Remaining/intentional:** `Utils.openModal(title, body)` and `Utils.confirm(title, msg)` still accept trusted HTML by design (callers escape data); template expressions that call functions were not auto-wrapped and were reviewed by sampling, not exhaustively; `customer.js`, `dashboard.js`, `permissions.js` and `reports.js` are covered by the codemod and syntax checks, not by DOM tests; `<img src>` values are escaped but not scheme-validated. **Pre-existing breakage found:** `assets/js/suppliers.js` and `assets/js/purchase_orders.js` are syntactically invalid at HEAD (escaped backticks) and were not touched (the working supplier screens come from `views.js`); `dashboard.js` had two stray braces and was repaired. |
| **P1-8b JWT in localStorage** | **Fixed** | No script reads or writes the JWT or sends an `Authorization` header (`Auth.fetch`, login, logout, registration, customer page, `storage.js`); stale `access_token` copies are purged on load. The session is only the HttpOnly `session_token` cookie (Secure in production, SameSite=Lax). Customer registration now also sets the cookie, and customer logout calls the server. The login response body still contains `access_token` for non-browser/API clients (tests, tooling); the browser code ignores it. Tests: cookie-only auth, logout revocation (replayed cookie rejected), registration cookie flags, and a source scan proving neither JS tree stores the JWT or sends `Authorization`. Order-tracking tokens (one order each) remain in `localStorage` by design. |
| **CSRF / CORS** | **Fixed for the same-origin topology** | Cookie-authenticated writes now require an `Origin` (or `Referer`) matching the host or `ALLOWED_ORIGINS`; missing or foreign values get 403. Bearer-header clients are unaffected. Wildcard origins are still rejected at startup. Tested for foreign origin, `null`, foreign referer and missing headers. If the UI is ever hosted on another origin, set `ALLOWED_ORIGINS` and revisit `SameSite`. |
| **Product cost confidentiality** | **Fixed** | `GET /products` returns `cost` only to MANAGER/ADMIN/SUPER_ADMIN; other roles get a response where the key is **absent** (hand-serialised so the response model cannot re-add it; the first implementation did re-add `"cost": null`, caught by the test). Tested per role and across transactions, categories, kitchen, public menu and sale responses. Inventory `unit_price` (stock cost) still goes to the INVENTORY role, whose job it is to manage it. |
| **Rate limiting / client IP** | **Partially fixed** | New: change-password guessing throttle (5 failures / 15 min / user); a disabled limiter no longer counts hits; the client IP is no longer taken from a spoofable `X-Forwarded-For`: uvicorn `--proxy-headers` was removed everywhere and `TRUSTED_PROXY_COUNT` selects the right-most trusted hop. The earlier `render.yaml` (`FORWARDED_ALLOW_IPS=*`) would have let callers dodge the limits. **Verify `TRUSTED_PROXY_COUNT` (Render default 1) for your real proxy chain.** Still **single-process**: the tests cover one process only; no Redis was added. Multi-instance deployments need the same limits at the proxy/CDN. |
| **WebSocket lifecycle** | **Fixed (single process)** | Idle clients now receive an explicit close (1001); tests prove registry cleanup after disconnect, no capacity leak from rejected handshakes, per-user and per-tenant caps, and the idle timeout. The registry is per process. |
| **Tenant isolation / DB integrity** | **Application: re-verified. Database: prepared, unverified** | Application checks re-tested for cross-tenant category/product/order/transaction references and for tenant-scoped uniqueness and idempotency keys. New migration `20261023000004_tenant_composite_foreign_keys.sql`: composite `(id, tenant_id)` keys and `NOT VALID` foreign keys for transactions->shifts, products->categories, purchase_orders->suppliers, cash_movements->shifts, with a pre-flight audit and a rollback. **Not applied or executed**; syntax parsed only. Tables without a `tenant_id` column (transaction_items, payments, order items, recipes, PO items) cannot be protected this way without a schema change. RLS (migration 3) does not constrain the backend's privileged role, and whether the real `DATABASE_URL` role owns the tables or bypasses RLS is **unknown** until the pre-flight queries are run. No database-enforced tenant isolation is claimed. |
| **Money / transaction integrity** | **Partially fixed** | Added tests that client `total_amount`/`net_amount`/`unit_price`/`amount` never override the server, and that discount is bounded. Tax and discount amounts remain client-entered pending policy (see `docs/BUSINESS_DECISIONS.md`). Earlier atomicity, idempotency and rounding tests stand. Stock deduction is still not implemented. |
| **CSP `'unsafe-inline'`** | **Not fixed (blocked by front-end design)** | The UI relies on inline `onclick=` handlers and inline `<script>` blocks, so removing it would break the app. A nonce/hash policy needs those moved to external scripts first. In place: `object-src 'none'`, `base-uri`, `form-action`, `frame-ancestors 'none'`, `connect-src 'self'`. |
| **Dependencies** | **Fixed for direct pins** | `pip-audit` reported 52 advisories on the previous pins (starlette, PyJWT, python-multipart, python-dotenv, cryptography). Pins moved to fastapi 0.161.1, starlette 1.9.0, pydantic 2.14.1, PyJWT 2.15.1, python-multipart 0.0.32, python-dotenv 1.2.4, cryptography 50.0.2; `pip-audit --no-deps` now reports none. Transitive packages of `uvicorn[standard]` are not pinned or audited. Full suite passes on the new pins. New dev-only dependency: `jsdom` (front-end tests). |
| Error handling, headers, trusted hosts, docs endpoints | **Re-verified, unchanged** | `test_configuration.py`: generic 500 with request id, security headers, docs off in production, readiness leaks nothing. |
| Pagination, indexes, retention, backups, timezones, duplicate trees | **Unchanged / documented** | Pagination caps from phase 1 stand; indexes are in migration 2; the retention, backup and timezone decisions are in `docs/BUSINESS_DECISIONS.md` and `docs/DEPLOYMENT.md`. Root `app/` and `static/` were refreshed from `fastapi/` again (kept, not deleted). |

## Manual actions still required

All items under "Manual actions required" above remain (rotate the Supabase password, history purge, remove commented credentials from the local `.env` files, backups and restore rehearsal). In addition: run `npm install` in `fastapi/tests/js` to enable the DOM tests locally; review migrations 2-4 on a disposable PostgreSQL database; verify `TRUSTED_PROXY_COUNT`; decide the items in `docs/BUSINESS_DECISIONS.md`.

## Phase 2 verdict

**Ready for staging validation.** Code-level remediation is not fully complete (CSP inline scripts, tax/discount authority, stock deduction, multi-instance limits, unaudited transitive dependencies), and nothing was verified on PostgreSQL, Supabase, Docker or Render. Not production-ready.

# Phase 3 (2026-10-24): cashier ordering, manual GCash verification, duplicate-sale prevention

Scope: harden the cashier ordering flow described in `fastapi/CASHIER_ORDERING.md`. **No payment gateway, provider API, SDK or webhook was added**; GCash is verified by the cashier typing the amount seen in the store's GCash history. Nothing was committed, pushed, deployed or run against any hosted database.

| Area | Status | What changed | Tests |
|---|---|---|---|
| **Duplicate sales / retries** | **Fixed** | The checkout UI now sends a `client_tx_id` (one per logical checkout, reused on retry, replaced when the cart/method changes, cleared on success) and ignores a second tap while in flight. The server stores a SHA-256 fingerprint of the checkout; the same key with a different payload is 409; a repeat returns the original result with no new rows, audit entries or events. The tenant-scoped unique index already existed in the model/migration 2. | `test_online_orders_payments.py` (idempotency block), `tests/js/ordering.test.js` |
| **Online order -> sale** | **Fixed** | `POST /transactions` accepts `customer_order_id`: the server uses the order's items and stored prices (browser items/prices/tax/discount are ignored or rejected), links the sale (`UNIQUE (tenant_id, customer_order_id)`), and updates the order and audit log in the same DB transaction. The separate "mark completed" request was removed. Retries, a second cashier and a half-finished legacy attempt all return/finish the single existing sale. | same file |
| **Customer payment choice** | **Fixed** | `payment_method` (`GCASH`/`PAY_AT_COUNTER`, validated) is saved with the order; a new order is always `unpaid`; customers cannot set payment state. Legacy orders keep `NULL` and are never assumed GCash. Staff see it everywhere; customers see only a coarse status. | same file |
| **Manual GCash verification** | **Fixed** | Server-side exact `Decimal` comparison against the server-computed amount; mismatches are flagged (`discrepancy`) and block fulfilment/payment; append-only `payment_verifications` audit; duplicate references blocked per tenant; manager/admin-only closure as invalid. The UI states that the amount is cashier-reported. | same file |
| **Payment vs fulfilment status** | **Fixed** | New `payment_status` column with enforced transitions (compare-and-swap). `completed` fulfilment never implies paid. | same file |
| **GCash counted as cash (pre-existing)** | **Fixed** | Drawer, shift, analytics and financial queries matched `LIKE '%cash%'`, which also matched `GCASH`, inflating the cash drawer. They now match methods that start with "cash". The drawer response also lacked the `expected_cash` field the POS reads; added. | `test_gcash_is_not_counted_as_cash_anywhere`, existing financial tests |
| **Non-cash tender** | **Fixed** | A single GCASH/CARD payment must equal the amount due; cash still allows change. | `test_non_cash_payment_must_equal_the_amount_due` |
| **Cart safety** | **Fixed** | Confirm before clearing or replacing a non-empty cart; customer-order carts are locked; draft cart (ids + quantities only) rebuilt from current prices after reload; 100-per-line cap; server errors shown in the dialog. | `tests/js/ordering.test.js` |
| **Schema** | **Prepared, not applied** | `supabase/migrations/20261024000001_manual_gcash_verification.sql` (+ rollback that refuses to destroy data) and `fastapi/migrate_payment_verification.py` for existing dev databases. Parsed with `pglast`; the live-PostgreSQL test only runs when `TEST_POSTGRES_URL` is set. | `test_migrations_and_scripts.py` |

## What is still unverified (Phase 3)

- Everything database-related ran on **SQLite**: `SELECT ... FOR UPDATE` row locks are a no-op there, and SQLite serialises writers. The threaded tests prove that the unique constraints and the compare-and-swap status updates leave exactly one winner, but they do **not** prove PostgreSQL lock behaviour or isolation under real concurrency. The same goes for the migration, which was parsed but not executed.
- Staging test plan (disposable PostgreSQL or a Supabase branch, never production): (1) apply migrations 1 to 4 and then `20261024000001` twice and run `TEST_POSTGRES_URL=... pytest tests/test_migrations_and_scripts.py`; (2) point the app at it and run `pytest` with the SQLite guard replaced by a Postgres URL in a scratch copy of `conftest.py`, or script N parallel `POST /transactions` calls with one `client_tx_id` and N parallel verifications of one order and confirm a single row each; (3) confirm the backend role can `SELECT ... FOR UPDATE` the order rows and that `payment_verifications` accepts inserts under RLS (role must own the table or bypass RLS); (4) run the rollback on the scratch database both with and without data.
- The browser flow was exercised in jsdom with a scripted fetch only. It has not been clicked through in a real browser, on the card terminal, or against a real GCash account.

# Phase 4 (2026-10-27): cashier ordering remediation and hardening

Scope: re-verify the Phase 3 cashier work, then fix what was still wrong. **No payment gateway, GCash API, SDK or webhook was added.** Nothing was committed, pushed, deployed or applied to any database. The legacy root `app/` and `static/` copies were **not** updated this time (not deployed; `Procfile`, `Dockerfile` and `render.yaml` all run `fastapi/`).

Re-verified as already correct (not reimplemented): `client_tx_id` idempotency with `UNIQUE (tenant_id, client_tx_id)`, one sale per online order (`UNIQUE (tenant_id, customer_order_id)` + locked order row), the manual GCash verify/resolve/attempts endpoints, separate payment/fulfilment status with compare-and-swap, cart drafts and order locking, post-commit events.

| Defect found (confirmed in code) | Fix | Tests |
|---|---|---|
| Fingerprint ignored the amounts of an explicit `payments` list | Amounts included (only when a list is sent, so existing fingerprints are unchanged) | `test_same_key_with_different_split_amounts_is_a_conflict` |
| A `payments` list could exceed the amount due; the excess was stored and inflated drawer/income | Lines must add up exactly to the amount due | `test_split_payment_lines_must_add_up_to_exactly_the_amount_due` |
| Tax/discount/tendered/payment amounts with >2 decimals were silently rounded | Rejected with 400 (`payments.parse_money`) | `test_money_with_extra_decimals_or_invalid_values_is_rejected_not_rounded`, updated `test_tax_and_discount_rounding` |
| Any string was accepted as a payment method; cash was a `cash%` prefix match | Methods limited to CASH/GCASH/CARD, stored upper-case; drawer cash is an exact `upper(trim()) = 'CASH'` in shifts, analytics, financial service | `test_unknown_payment_methods_are_rejected`, `test_payment_methods_are_stored_canonically`, `test_legacy_cash_spellings_count_as_drawer_cash_but_lookalikes_do_not`, existing `test_gcash_is_not_counted_as_cash_anywhere` |
| Retrying an online order whose sale was voided "repaired" the order and replayed the voided sale; repairs were not audited | 409 for voided sales; repair audited (`Order Reconciled`), never marks GCash paid; `scripts/reconcile_customer_orders.py` (dry run by default) | `test_retry_repairs_a_half_finished_order_and_audits_it`, `test_reconciliation_never_marks_a_gcash_order_paid`, `test_a_voided_online_sale_is_neither_repaired_nor_resold`, `test_reconcile_script_scan_finds_repairs_and_review_cases`, updated `test_cancelled_online_sale_is_excluded_and_cannot_be_resold` |
| `PUT /transactions/{id}/status`: no lock, a completed sale could be set back to `pending`/`preparing`/`ready` (financial status, so it left income reports), void reason optional, no void audit fields, no record that money must be returned | Row lock; void needs a reason, stores `voided_at/by/reason`, keeps payment rows, sets `refund_status`; completed sales never go back; `preparing`/`ready` are fulfilment only; `VOID_REQUIRES_MANAGER` switch | `test_void_requires_a_reason_and_keeps_the_payment_record`, `test_a_voided_sale_cannot_be_voided_or_reopened_again`, `test_a_completed_sale_cannot_be_moved_back_out_of_the_income_figures`, `test_a_pending_sale_is_completed_only_when_its_payments_match`, `test_void_permission_switch_restricts_voids_to_managers` |
| No refund record of any kind | `POST /transactions/{id}/refund` (manager/admin): full amount, original method, optional reference, note; once per sale (unique + CAS); `sale_refunds` table | `test_only_managers_record_refunds_and_only_the_full_amount_by_the_original_method`, `test_gcash_refund_is_recorded_with_its_reference_and_never_claimed_as_sent`, `test_not_required_outcome_closes_a_mistaken_void`, `test_database_rejects_two_refund_records_for_one_sale`, `test_other_tenants_manager_cannot_touch_the_sale`, `test_cancelled_sale_and_its_refund_are_not_double_counted_in_reports` |
| Kitchen endpoint could cancel a POS sale (sale `cancelled`, payments still `completed`) and re-open completed tickets | 409 for cancel/reject and for re-opening; fulfilment only; row lock | `test_kitchen_cannot_void_a_pos_sale_or_reopen_a_served_one` |
| Customer-order status routes (POS and kitchen `CUST-`) had no row lock; an order with an active sale could be rejected; kitchen rejection of a verified order was not audited | One shared function on a `FOR UPDATE` row; rejection refused while an active sale exists; audit from both routes | `test_an_order_with_an_active_sale_cannot_be_rejected_by_any_route`, `test_kitchen_rejection_of_a_verified_order_is_audited_like_the_pos_route`, `test_kitchen_route_cannot_reopen_terminal_customer_orders` |
| Receipt printed from the browser cart (wrong on a replay); reprints computed change for GCash (`includes("CASH")`) | Sale responses carry committed `items`/`payments`; receipt uses them; change only for CASH | `test_sale_response_and_replay_carry_the_committed_lines_for_the_receipt`; JS: "the receipt shows the lines and totals the server committed", "a GCash receipt never shows change" |
| Stock never deducted (recipes exist, ledger table unmodelled) | `services/stock.py`: recipe deduction inside the sale transaction with conditional updates, `stock_movements` ledger with partial unique index, restoration on void once. **Off by default** (`INVENTORY_DEDUCTION=on_sale` to enable) pending decision D8/D9 | 9 tests `test_*stock*`, `test_online_order_is_deducted_once_*`, `test_two_sales_cannot_take_the_same_last_stock`, `test_database_rejects_a_second_deduction_row_*` |

Schema: `supabase/migrations/20261027000001_void_refund_and_stock_ledger.sql` (additive; diagnostics for legacy data in its header) + rollback that refuses to destroy data; `fastapi/migrate_payment_verification.py` extended for dev databases. Parsed with `pglast`; **not executed** on PostgreSQL.

## Test results (2026-10-27, Windows, Python 3.13.0, Node 23)

- `cd fastapi && python -m pytest -q` -> **328 passed, 10 skipped, 0 failed** (5 min 29 s), all on **SQLite**. The 10 skips are the 9 PostgreSQL concurrency tests and the live-migration test, all of which need `TEST_POSTGRES_URL`.
- New file `tests/test_remediation_voids_stock.py`: 45 tests (including parametrised cases); 3 existing assertions were changed to the stricter behaviour (rounding -> rejection, voided order retry -> 409) and say so in comments.
- `cd fastapi/tests/js && npm test` -> **65 passed, 0 failed** (jsdom; 5 new tests for receipts and the refund dialog).
- Not run: PostgreSQL (see below), a real browser, Docker, Render.

## PostgreSQL status

`tests/test_postgres_concurrency.py` (9 tests) races the real API with threads on PostgreSQL: identical concurrent checkouts, two cashiers settling one order, one GCash reference on many orders, verification vs rejection, sale vs rejection, concurrent stock deduction, concurrent voids/refunds, rollback after a failure mid-transaction plus retry, and a check that `FOR UPDATE` really blocks. It refuses Supabase hosts and databases whose name lacks `test`, and works in a private schema that it drops. **It has not been run**: the local PostgreSQL 18 server needs credentials that were not available, and the only URL offered was the hosted Supabase project, which was deliberately not used. Every PostgreSQL claim (row locks, isolation, partial unique index, migration application) is therefore **unverified**.

Staging procedure (disposable database only, never production):

1. `createdb inboxpos_test` on a local/staging PostgreSQL (or a Supabase **branch**, after removing the host guard in a scratch copy).
2. `cd fastapi && set TEST_POSTGRES_URL=postgresql://USER:PASS@HOST:5432/inboxpos_test`
3. `pytest tests/test_postgres_concurrency.py tests/test_migrations_and_scripts.py -v` (the second file applies all migrations twice and checks RLS).
4. On a restored copy of production: run the diagnostic queries in the header of `20261027000001`, apply `20261024000001` then `20261027000001`, then `python scripts/reconcile_customer_orders.py --confirm-host <host>` (dry run) and review its output.
5. Point a staging app at that copy with `INVENTORY_DEDUCTION=off`, run one cash, card, GCash (walk-in), counter-order and verified-GCash-order sale, void one, record its refund, and compare the drawer summary with the rows.

## Remaining risks (Phase 4)

- PostgreSQL/Supabase behaviour unverified (see above). SQLite ignores `FOR UPDATE`; the SQLite concurrency tests only prove the unique constraints and compare-and-swap updates.
- Concurrent first sales of one cashier can auto-open two shifts (no "one open shift per cashier" constraint; pre-existing).
- Walk-in GCash/CARD remain cashier-attested (decision D3).
- Tax/discount still client-entered through the API (decision D11); the cashier UI sends neither.
- The kitchen page's Reject button calls the POS void endpoint, which KITCHEN accounts cannot use (pre-existing UI gap; kitchen users get a 403 toast).
- Sales voided before this release have `refund_status = NULL` (unknown); review them with the query in the migration header.
- The legacy root `app/` and `static/` mirrors are now behind `fastapi/` (not deployed).
