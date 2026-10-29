# Deployment, migrations and operations

## Verified architecture

| Aspect | Finding (from the code, not assumptions) |
|---|---|
| Deployed code tree | `fastapi/` (`render.yaml` `rootDir`, `Dockerfile`, `Procfile`, `run.py`, root `main.py` all point here). The root `app/` and `static/` folders are legacy copies, mirrored from `fastapi/` for now. |
| Database access | SQLAlchemy over a **direct PostgreSQL connection** (`DATABASE_URL`, psycopg). Local development may use MySQL/XAMPP; production is Supabase PostgreSQL. |
| Supabase features used | Database only. **No** supabase-js, PostgREST, Supabase Auth, Realtime or Storage. |
| Authentication | Application-managed JWT (HS256) + HttpOnly `session_token` cookie, revocation via `users.token_version`. Unchanged. |
| Tenant model | `users.tenant_id` (NULL only for `SUPER_ADMIN`); every business table carries `tenant_id`. |
| RLS | Not used by the app (it connects with a privileged role that bypasses RLS). Migration 3 turns RLS on with no policies so the Supabase public API roles see nothing. Server-side checks remain the real authorization layer. |

## Environment variables

Names only; never commit values. See `.env.example` for the documented template.

| Variable | Required in production | Purpose |
|---|---|---|
| `APP_ENV=production` | yes | Enables secure cookies, HSTS, hides API docs, disables dev seeding and `create_all`. |
| `DATABASE_URL` | yes | Supabase PostgreSQL connection string. The app refuses to start without it (no localhost fallback). |
| `JWT_SECRET` | yes (>= 32 chars) | The app refuses to start without it. |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | no (default 1440) | Now honoured for the token and the cookie lifetime. |
| `ALLOWED_HOSTS` | recommended | Trusted `Host` headers. |
| `ALLOWED_ORIGINS` | only for cross-origin clients | Explicit origins; `*` is rejected. The bundled UI is same-origin and needs none. |
| `TRUSTED_PROXY_COUNT` | behind a proxy | Number of proxies you operate in front of the app; rate limits use the X-Forwarded-For entry that many hops from the right. Default 0 (socket peer). uvicorn `--proxy-headers` is intentionally not used. |
| `ENABLE_API_DOCS` | no (default false) | Exposes `/docs`, `/redoc`, `/openapi.json`. |
| `AUTO_OPEN_SHIFT` | no (default true) | **Business decision pending**: auto-open a zero-cash shift for a sale with no open shift. |
| `RATE_LIMIT_ENABLED` | no (default true) | In-process limiter switch. |
| `WS_MAX_CONNECTIONS_PER_TENANT`, `WS_MAX_CONNECTIONS_PER_USER`, `WS_IDLE_TIMEOUT_SECONDS` | no | WebSocket limits (100 / 5 / 90 s). |

Development only (ignored in production): `SEED_DEMO_DATA`, `DB_AUTO_CREATE_TABLES`.

## Migration workflow (Supabase / PostgreSQL)

The repository had no migration tool; `create_all()` ran at every start. The convention is now plain,
reviewed SQL files in `supabase/migrations/` (Supabase CLI layout), applied as a **release step, never at app start**.

| File | What | Status |
|---|---|---|
| `20261023000001_baseline_schema.sql` | Idempotent `CREATE ... IF NOT EXISTS` of the current models (frozen; regenerate only for a new baseline with `fastapi/scripts/generate_baseline_sql.py`). No-op on the existing project. | prepared |
| `20261023000002_tenant_integrity_and_indexes.sql` | Case-insensitive unique username/email, per-tenant `client_tx_id` uniqueness, missing indexes, `NOT VALID` CHECK constraints. Aborts with a clear message if existing data would violate a new unique index. | prepared |
| `20261023000003_enable_rls_deny_by_default.sql` | RLS on all 20 modelled tables plus `stock_movements` (present in the live schema, unused by the app), no policies, `REVOKE` from `anon`/`authenticated`. Read its pre-flight notes first (backend role must own the tables or bypass RLS). | prepared |
| `20261024000001_manual_gcash_verification.sql` | Manual GCash verification and safe online-order settlement: `customer_orders.payment_method/payment_status`, `transactions.customer_order_id/request_fingerprint` (+ `UNIQUE (tenant_id, customer_order_id)`), GCash fields on `payments`, new append-only `payment_verifications` table (RLS on, no policies) with `UNIQUE (tenant_id, claimed_reference)`, `NOT VALID` CHECKs. **Additive only**: no existing row or column is changed; old rows get `payment_status = 'unpaid'` and `payment_method = NULL`. Rollback refuses to run if it would delete verification or payment data. | prepared |

None of these have been applied to any database. Rollbacks are in `supabase/rollbacks/`.

**Order matters for the GCash migration (`20261024000001`):** migration 2 must be applied first (it creates the per-tenant `client_tx_id` unique index that the checkout idempotency guarantee relies on). The new migration is backward compatible, so apply it **before** deploying the new code; the old code ignores the new columns. The new code, deployed against a database *without* this migration, fails on every sale and customer order (missing columns), so never deploy the code first. For a local MySQL/XAMPP/SQLite development database that already exists, run `python migrate_payment_verification.py` (dry run) and `--apply` from `fastapi/`; the script refuses to touch a hosted Supabase database.

Recommended sequence:

1. Take a backup and note the time (Supabase Dashboard -> Database -> Backups; PITR if the plan has it).
2. Create a Supabase **branch** or restore the backup into a scratch project and apply migrations 1-3 there (`supabase db push` or the SQL editor). Run them twice to prove idempotency, then run `pytest` with `TEST_POSTGRES_URL` pointing at a disposable database to repeat that check automatically.
3. Resolve anything the pre-flight blocks in migration 2 reports (case-variant duplicate usernames/emails).
4. Run the pre-flight queries in migration 3 against production and confirm the `DATABASE_URL` role bypasses RLS.
5. Apply to production in a maintenance window, in order, one file at a time.
6. Optionally `VALIDATE CONSTRAINT` the `ck_*` constraints after reviewing legacy rows.

Release order for a code deploy: **(a)** backup -> **(b)** migrations -> **(c)** deploy the new code -> **(d)** smoke test `/healthz`, `/readyz`, login, a test sale (and the same `client_tx_id` twice: the second must return the first), a customer order with each payment choice, a GCash verify (match and mismatch), settle a verified order from the POS, and a WebSocket connection. Migration 2 is compatible with the old code; deploy code after it. If the new code is deployed first it still works (it handles the old global `client_tx_id` index and returns a retryable 409 on a rare cross-tenant collision).

## First administrator

Startup no longer seeds anyone. On a fresh database run once (from `fastapi/`, with `DATABASE_URL` set):

```
python scripts/bootstrap_admin.py --username <name> --email <email> --create-tenant "<Branch name>" --confirm-host <db-host>           # dry run
BOOTSTRAP_SUPERADMIN_PASSWORD=... python scripts/bootstrap_admin.py ... --execute
```

It refuses to run if a `SUPER_ADMIN` exists, rejects weak/default passwords, requires the host confirmation to match, and never prints the password. The schema has no "must change password" flag, so rotate the password after first sign-in.

## Startup and container

- Start command: `cd fastapi && uvicorn app.main:app --host 0.0.0.0 --port $PORT` (Procfile, Render, Docker all use it).
- `GET /healthz` = liveness (no dependencies). `GET /readyz` = readiness (`SELECT 1`; returns only `ok` / `unavailable`). Use `/healthz` for platform probes, `/readyz` for load-balancer readiness.
- The app fails to start if the database is unreachable or required settings are missing.
- Docker: `docker build -t inbox-pos .` from the repository root. Runs as UID 10001, copies only `fastapi/`, excludes `.env`, `*.sql`, backups and tests. **Not built or run in this review (Docker unavailable).**
- Multiple instances/workers: the rate limiter and WebSocket registry are per process. Enforce the same limits at the proxy/CDN (public order, login, register routes) and use sticky routing or a pub/sub layer before scaling horizontally.

## Rate limits (in-process defaults)

Login 20/min/IP plus lock-out after 5 failures per (username, IP) for 15 min; registration 10/hour/IP; customer order submission 10/min/IP; menu 60/min/IP; order tracking 60/min/IP and 10 failed lookups/5 min/IP.

## Backups, recovery and retention (to be configured, not yet done)

- A SQL dump, the Git repository or the Supabase project alone are not a backup strategy. Use Supabase automated daily backups (all paid plans) and enable **PITR** for production if the plan allows; confirm the retention window in the Dashboard for the current plan.
- Keep the manual dumps produced by `scripts/client_handover_reset.py` outside the repository and image (they are git-ignored and docker-ignored) and treat them as sensitive: they contain password hashes and customer data.
- Rehearse a restore (restore into a scratch project, run `/readyz`, log in, count rows) before go-live and after every migration batch. Not performed in this review.
- Retention/privacy: customers store name, phone and email. Decide a retention period and an anonymisation path (hard-deleting users can violate `RESTRICT` foreign keys on shifts/transactions); neither is implemented.

## Timezones

`DateTime` columns are naive with `server_default=now()` and reports bucket "today" with the app server's local time. Behaviour is unchanged and **not** converted; pick UTC storage plus an explicit business timezone (for example Asia/Manila) before relying on day boundaries.
