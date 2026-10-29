# Running Inbox POS locally

This guide gets the POS running on your own computer for development and testing.

## 1. What you need

| Tool | Version | Check with |
|------|---------|------------|
| Python | 3.11 or newer (the team uses 3.13) | `python --version` |
| Git | any recent version | `git --version` |
| Chrome or Edge | recent | needed for voice ordering |
| Node.js | 18 or newer | only to run the browser tests (`node --version`) |

## 2. One-time setup

Run these from the project root (the folder that contains `run.py`).

```
git clone <repository-url> Inbox_POS
cd Inbox_POS
pip install -r fastapi/requirements.txt
```

Optional, only if you will run the tests:

```
pip install -r fastapi/requirements-dev.txt
cd fastapi/tests/js
npm install
cd ../../..
```

## 3. Configure the database (`fastapi/.env`)

The app will not start without a `DATABASE_URL`. Copy the template and fill it in:

```
copy fastapi\.env.example fastapi\.env
```

Edit `fastapi/.env`. Set exactly **one** `DATABASE_URL` line:

```
APP_ENV=development
DATABASE_URL=<your connection string>
JWT_SECRET=<a long random secret>
PORT=8000
```

Ask the project owner for the connection string. Do not commit `.env` and do not paste its contents in chat or tickets.

> **Warning: pick your database on purpose.**
> The server connects to whatever `DATABASE_URL` points at. If it points at the shared Supabase database, every sale, order and change you make while testing is saved in the **real** data.
> If `.env` contains more than one `DATABASE_URL` line, the **last one wins**. Remove or comment out (`#`) the ones you do not want.
> For safe testing, use a local database instead, for example MySQL from XAMPP:
> `DATABASE_URL=mysql+pymysql://root@127.0.0.1:3307/pos?charset=utf8mb4`
> (start MySQL in the XAMPP control panel first; the app creates the tables and, for a local server, the `pos` database).

## 4. Start the app

```
python run.py
```

Wait for `Application startup complete`, then open:

**http://localhost:8000**

Always use `localhost`. Do not open the app by IP address (for example `http://192.168.1.5:8000`): the browser blocks the microphone on those addresses and voice ordering will not work.

Useful options:

| Command | What it does |
|---------|--------------|
| `python run.py` | Start the server with auto-reload (default) |
| `python run.py --port 8080` | Use a different port |
| `python run.py --no-reload` | Start without auto-reload |

Other addresses once it is running:

- API documentation: http://localhost:8000/docs
- Health check: http://localhost:8000/healthz

To stop the server, press **Ctrl+C** in the terminal.

Without the launcher you can also run:

```
cd fastapi
uvicorn app.main:app --reload --port 8000
```

## 5. Sign in

The app does not create accounts on its own. Either:

- Use an account the project owner gave you, or
- On a **new, empty** database, create the first administrator from the `fastapi` folder:

  ```
  cd fastapi
  python scripts/bootstrap_admin.py --username owner --email owner@example.com --create-tenant "Main Branch" --confirm-host <db-host>
  ```

  That is a dry run. Add `--execute` to actually create the account. It refuses to run if an administrator already exists.

After signing in, each role lands on its own screen: Admin, Manager, Cashier, Kitchen, Inventory.

## 6. Try the main flow

1. Open two browser windows at http://localhost:8000.
2. Sign in as a **Cashier** in one and as **Kitchen** in the other.
3. Place an order with a food item on the cashier screen.
4. The kitchen window chimes, shows "New order ... for the Kitchen station" and lists the ticket without a refresh.

Browsers keep a page silent until someone clicks on it, so click anywhere on the kitchen screen once after loading it or the chime may not play.

## 7. Voice ordering

- Use Chrome or Edge on `http://localhost:8000` (or HTTPS when online).
- The first time you press **VOICE ORDER**, the browser asks for the microphone. Choose **Allow**.
- If it says access is blocked, click the lock icon beside the address, set **Microphone** to **Allow**, and reload.
- Also check Windows: **Settings > Privacy & security > Microphone**. Turn on microphone access and "Let desktop apps access your microphone".

## 8. Run the tests

Tests use a throwaway SQLite database. They never touch your real data.

```
cd fastapi
python -m pytest -q                       # backend, about 4 to 5 minutes
cd tests/js
node --test --test-force-exit             # browser-side logic, about 10 seconds
```

Run both before sending changes. The backend run also calls the JS tests once.

## 9. Troubleshooting

| Problem | Fix |
|---------|-----|
| `Address already in use` | Another copy is on port 8000. Close the other terminal, or use `python run.py --port 8080`. |
| App exits with `DATABASE_URL must be set` | `fastapi/.env` is missing or has no `DATABASE_URL`. See step 3. |
| Sign-in shows a 500 error | Read the red error text in the terminal that is running the server. The most common cause is the server losing its database connection: restart it with `python run.py`. |
| Page is blank and the console says `Unexpected end of input` | A `.html` file lost its line breaks (a formatter or minifier did it). Restore the file from git and turn that tool off for `.html` files. |
| You changed a `.js` file but the browser shows the old behaviour | Hard refresh with **Ctrl+F5**. |
| Microphone blocked | See step 7. |
| Kitchen does not receive orders | Check it is signed in as the Kitchen role, on the same branch as the cashier. The kitchen screen also refreshes by itself every 6 seconds. |
| `ModuleNotFoundError` | Run `pip install -r fastapi/requirements.txt` again. |

## 10. Project layout

| Path | What is in it |
|------|---------------|
| `run.py` | Local launcher |
| `fastapi/app/` | Backend code (routes in `app/routers/`) |
| `fastapi/static/` | Web pages and scripts served by the backend |
| `fastapi/tests/` | Backend tests; `tests/js/` holds the browser-side tests |
| `docs/DEPLOYMENT.md` | Online deployment, migrations and backups |

`fastapi/` is the real application. The `app/` and `static/` folders at the project root are older copies kept for now, so make changes in `fastapi/`.
