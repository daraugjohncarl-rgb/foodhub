"""Supabase/PostgreSQL migration checks, the admin bootstrap script and front-end escaping."""
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

import pytest

from conftest import R
from app.db import Base
import app.models  # noqa: F401

FASTAPI_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(FASTAPI_DIR)
MIGRATIONS = sorted(glob.glob(os.path.join(REPO_ROOT, "supabase", "migrations", "*.sql")))
ROLLBACKS = sorted(glob.glob(os.path.join(REPO_ROOT, "supabase", "rollbacks", "*.sql")))


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def test_migrations_exist_are_ordered_and_have_rollbacks():
    assert len(MIGRATIONS) >= 3
    versions = [os.path.basename(p).split("_")[0] for p in MIGRATIONS]
    assert versions == sorted(versions) and len(set(versions)) == len(versions)
    for path in MIGRATIONS[1:]:  # the baseline is create-if-missing only
        down = os.path.join(REPO_ROOT, "supabase", "rollbacks", os.path.basename(path).replace(".sql", ".down.sql"))
        assert os.path.exists(down), f"missing rollback for {os.path.basename(path)}"


@pytest.mark.parametrize("path", MIGRATIONS, ids=os.path.basename)
def test_migrations_are_not_destructive(path):
    sql = re.sub(r"--.*", "", read(path))
    for pattern in (r"\bDROP\s+TABLE\b", r"\bTRUNCATE\b", r"\bDELETE\s+FROM\b", r"\bDROP\s+SCHEMA\b", r"\bDROP\s+COLUMN\b", r"\bALTER\s+COLUMN\b.*\bTYPE\b"):
        assert not re.search(pattern, sql, re.IGNORECASE), f"{pattern} found in {os.path.basename(path)}"


def test_migrations_create_every_model_table():
    # The baseline plus later additive migrations (new tables) together define the full schema.
    created = set()
    for path in MIGRATIONS:
        created |= set(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", read(path)))
    assert created == {t.name for t in Base.metadata.sorted_tables}


def test_migrations_add_every_model_column():
    """Every model column must exist in the SQL (baseline CREATE TABLE or a later ADD COLUMN)."""
    sql = "\n".join(read(p) for p in MIGRATIONS)
    for table in Base.metadata.sorted_tables:
        created = re.search(r"CREATE TABLE IF NOT EXISTS %s \((.*?)\n\);" % table.name, sql, re.S)
        body = created.group(1) if created else ""
        for column in table.columns:
            in_create = re.search(r"^\s*%s\s" % column.name, body, re.M)
            added = re.search(r"ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s\b" % (table.name, column.name), sql)
            assert in_create or added, f"{table.name}.{column.name} is not created by any migration"



def test_rls_migration_covers_every_model_table():
    rls = read(next(p for p in MIGRATIONS if "rls" in p))
    listed = set(re.findall(r"'([a-z_]+)'", rls.split("app_tables text[] := ARRAY[")[1].split("];")[0]))
    # Tables added by later migrations enable RLS themselves in the migration that creates them.
    later = set()
    for path in MIGRATIONS:
        for table in re.findall(r"ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY", re.sub(r"--.*", "", read(path))):
            later.add(table)
    assert (listed - {"stock_movements"}) | later == {t.name for t in Base.metadata.sorted_tables}
    assert "ENABLE ROW LEVEL SECURITY" in rls and "FORCE ROW LEVEL SECURITY" not in rls.replace("Does NOT use FORCE ROW LEVEL SECURITY", "")


def test_migrations_parse_as_postgresql():
    pglast = pytest.importorskip("pglast")
    for path in MIGRATIONS + ROLLBACKS:
        pglast.parse_sql(read(path))


def test_manual_gcash_migration_matches_models_and_is_additive():
    sql = read(next(p for p in MIGRATIONS if "manual_gcash" in p))
    code = re.sub(r"--.*", "", sql)
    assert "uix_transactions_tenant_customer_order" in code and "uix_payment_verifications_tenant_reference" in code
    assert re.search(r"payment_status VARCHAR\(20\) NOT NULL DEFAULT 'unpaid'", code)  # old rows stay valid
    assert not re.search(r"UPDATE", code, re.I)                                     # no data rewritten
    uniques = {c.name for c in Base.metadata.tables["transactions"].constraints if c.__class__.__name__ == "UniqueConstraint"}
    assert "uix_transactions_tenant_customer_order" in uniques


def test_models_match_the_integrity_migration():
    transactions = Base.metadata.tables["transactions"]
    assert {c.name for c in transactions.constraints if c.__class__.__name__ == "UniqueConstraint"} >= {"uix_transactions_tenant_client_tx"}
    assert transactions.c.client_tx_id.unique in (None, False)
    assert Base.metadata.tables["customer_orders"].c.tenant_id.default is None  # no silent "tenant 1"


@pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="set TEST_POSTGRES_URL to a DISPOSABLE PostgreSQL database to run live migration tests")
def test_migrations_apply_twice_on_disposable_postgres():
    import psycopg
    url = os.environ["TEST_POSTGRES_URL"]
    assert "supabase.co" not in url and "supabase.com" not in url, "refusing to run against a hosted Supabase project"
    with psycopg.connect(url, autocommit=False) as conn:
        for _ in range(2):  # second pass proves idempotency
            for path in MIGRATIONS:
                conn.execute(read(path))
            conn.commit()
        rows = conn.execute("SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'").fetchall()
        assert rows and all(enabled for _, enabled in rows)


# --------------------------------------------------------------------------- bootstrap script
def run_bootstrap(args, tmp_db, password=None):
    env = {k: v for k, v in os.environ.items() if k not in ("DATABASE_URL", "BOOTSTRAP_SUPERADMIN_PASSWORD")}
    env.update(DATABASE_URL="sqlite:///" + tmp_db.replace("\\", "/"), JWT_SECRET="s" * 40, APP_ENV="development",
               DB_HOST="127.0.0.1")  # a developer .env pointing DB_HOST elsewhere must not leak into the sqlite URL
    if password is not None:
        env["BOOTSTRAP_SUPERADMIN_PASSWORD"] = password
    return subprocess.run([sys.executable, os.path.join(FASTAPI_DIR, "scripts", "bootstrap_admin.py"), *args], cwd=FASTAPI_DIR,
                          env=env, capture_output=True, text=True, timeout=120, input="")


def test_bootstrap_script_is_one_time_and_safe(tmp_path):
    db_file = str(tmp_path / "bootstrap.db")
    # Create the schema in that file via a throwaway interpreter.
    setup = (
        "import sys; sys.path.insert(0, %r)\n"
        "from sqlalchemy import BigInteger\nfrom sqlalchemy.ext.compiler import compiles\n"
        "@compiles(BigInteger, 'sqlite')\ndef _b(t, c, **k): return 'INTEGER'\n"
        "from app.db import Base, engine\nimport app.models\nBase.metadata.create_all(engine)\n" % FASTAPI_DIR
    )
    env = {**os.environ, "DATABASE_URL": "sqlite:///" + db_file.replace("\\", "/"), "JWT_SECRET": "s" * 40}
    subprocess.run([sys.executable, "-c", setup], env=env, check=True, capture_output=True)

    base = ["--username", "owner", "--email", "Owner@Example.com", "--create-tenant", "Main Branch"]
    strong = "Correct-Horse-Battery-9"

    wrong_host = run_bootstrap(base + ["--confirm-host", "somewhere-else", "--execute"], db_file, strong)
    assert wrong_host.returncode == 2 and "does not match" in wrong_host.stdout

    weak = run_bootstrap(base + ["--confirm-host", "127.0.0.1", "--execute"], db_file, "superadmin123")
    assert weak.returncode == 2 and "password" in weak.stdout.lower()

    dry = run_bootstrap(base + ["--confirm-host", "127.0.0.1"], db_file, strong)
    assert dry.returncode == 0 and "Dry run" in dry.stdout

    done = run_bootstrap(base + ["--confirm-host", "127.0.0.1", "--execute"], db_file, strong)
    assert done.returncode == 0, done.stdout + done.stderr
    assert strong not in done.stdout + done.stderr

    again = run_bootstrap(base + ["--confirm-host", "127.0.0.1", "--execute"], db_file, strong)
    assert again.returncode == 3 and "already exists" in again.stdout


# --------------------------------------------------------------------------- front-end escaping
@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_utils_escape_html_neutralises_markup():
    js = os.path.join(FASTAPI_DIR, "static", "assets", "js", "utils.js")
    script = (
        "global.window = global; global.document = {addEventListener(){}, getElementById(){return null}, readyState:'loading'};"
        "const fs=require('fs'); eval(fs.readFileSync(%r,'utf8')+';global.U=Utils;');"
        "const out=U.escapeHtml('<img src=x onerror=alert(1)>\"\\'&');"
        "console.log(out);" % js
    )
    result = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert "<" not in result.stdout and ">" not in result.stdout
    assert "&lt;img" in result.stdout and "&quot;" in result.stdout and "&#39;" in result.stdout


def test_hostile_table_and_name_inputs(client, tenants, make_product, make_user, login):
    tenant_a, _ = tenants
    burger = make_product(tenant_a, "Burger", "50.00")
    item = [{"product_id": burger.id, "quantity": 1}]
    # Table labels cannot carry markup or quotes.
    for bad in ("<script>alert(1)</script>", "5'); alert(1);//", 'a"b'):
        resp = client.post("/api/v1/customer-orders", json={"tenant_id": tenant_a.id, "table_number": bad, "items": item})
        assert resp.status_code == 400, bad
    # Names are free text (O'Brien is legitimate) and are escaped at render time by the UI.
    ok = client.post("/api/v1/customer-orders", json={"tenant_id": tenant_a.id, "customer_name": "O'Brien <b>", "items": item})
    assert ok.status_code == 201
    make_user("mgr", R.MANAGER, tenant_a)
    bad_table = client.post("/api/v1/tables", headers=login("mgr"), json={"table_number": "<img src=x>"})
    assert bad_table.status_code == 400
    assert client.post("/api/v1/tables", headers=login("mgr"), json={"table_number": "T-5"}).status_code == 201


def test_dev_upgrade_script_adds_the_new_columns_and_is_idempotent(tmp_path):
    import sqlite3
    db_file = str(tmp_path / "old_schema.db")
    con = sqlite3.connect(db_file)
    con.executescript("""
        CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE customer_orders (id INTEGER PRIMARY KEY, tenant_id INTEGER, order_number TEXT);
        CREATE TABLE transactions (id INTEGER PRIMARY KEY, tenant_id INTEGER, client_tx_id TEXT);
        CREATE TABLE payments (id INTEGER PRIMARY KEY, transaction_id INTEGER);
        INSERT INTO customer_orders (id, tenant_id, order_number) VALUES (1, 1, 'CUST-OLD');
    """)
    con.close()
    env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    env.update(DATABASE_URL="sqlite:///" + db_file.replace("\\", "/"), JWT_SECRET="s" * 40, APP_ENV="development")
    script = os.path.join(FASTAPI_DIR, "migrate_payment_verification.py")

    def run(*args):
        return subprocess.run([sys.executable, script, *args], cwd=FASTAPI_DIR, env=env, capture_output=True, text=True, timeout=120)

    dry = run()
    assert dry.returncode == 0 and "Dry run only" in dry.stdout and "payment_status" in dry.stdout
    assert "payment_status" not in [r[1] for r in sqlite3.connect(db_file).execute("PRAGMA table_info(customer_orders)")]
    applied = run("--apply")
    assert applied.returncode == 0, applied.stdout + applied.stderr
    con = sqlite3.connect(db_file)
    cols = lambda t: {r[1] for r in con.execute(f"PRAGMA table_info({t})")}
    assert {"payment_method", "payment_status"} <= cols("customer_orders")
    assert {"customer_order_id", "request_fingerprint"} <= cols("transactions")
    assert {"reference_no", "amount_received", "verified_by", "verified_at"} <= cols("payments")
    assert "payment_verifications" in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # existing rows survive and default to "unpaid" with an unknown (NULL) payment method
    assert con.execute("SELECT payment_method, payment_status FROM customer_orders WHERE id = 1").fetchone() == (None, "unpaid")
    con.close()
    again = run("--apply")
    assert again.returncode == 0 and "already up to date" in again.stdout
