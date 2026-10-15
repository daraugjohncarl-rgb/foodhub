# Browser checks (optional, manual)

Real-browser regression checks for the staff and customer pages: stored XSS payloads render as text, POS checkout
with the start-shift prompt, online-order checkout linking, kitchen labels, QR links, wastage, purchase orders and
every page loading without JavaScript exceptions. They drive headless Microsoft Edge / Chrome through the DevTools
protocol using only Node 22+ built-ins (no npm packages).

**Disposable database only.** `seed_browser_db.py` drops and recreates the schema of the database in
`DATABASE_URL`, and refuses to run unless the database name ends in `_test`.

```bash
# 1. empty disposable database, e.g. createdb inbox_pos_browser_test
export INBOX_POS_SKIP_DOTENV=1 APP_ENV=test SEED_DEMO_DATA=0
export DATABASE_URL=postgresql+psycopg://USER@127.0.0.1:5432/inbox_pos_browser_test
export JWT_SECRET=$(python -c "import secrets; print(secrets.token_urlsafe(48))")
python tools/browser_checks/seed_browser_db.py

# 2. start the app on port 8765 with the same environment
cd fastapi && uvicorn app.main:app --port 8765 &

# 3. run the checks (path to msedge.exe or chrome, and a throw-away profile directory)
node tools/browser_checks/browser_checks.mjs "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" ./tmp-profile
```

All test accounts use the password `E2e-password-123`.
