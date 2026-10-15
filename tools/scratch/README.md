# Scratch scripts (not part of the application)

One-off helper scripts that used to live in the repository root. They are kept for reference only.

* `check_db.py`, `check_suppliers.py` — ad-hoc database / API probes. They hard-code paths and ports from a
  developer machine and talk to whatever database or server is configured. **Do not run them against production.**
* `scratch_test.py`, `test_po.py` — manual API pokes against `http://127.0.0.1:8001`.
* `split_html.py`, `build_customer_js.py` — one-time generators used to build the customer page.
  `build_customer_js.py` writes JavaScript with escaped backticks; the generated `suppliers.js` /
  `purchase_orders.js` were syntactically invalid because of it (fixed by hand). Do not re-run it.

The real automated tests live in `fastapi/tests` (pytest, disposable database only).
