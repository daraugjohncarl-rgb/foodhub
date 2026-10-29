#!/usr/bin/env python3
"""
One-time administrator bootstrap for a fresh Inbox POS database.

Replaces the removed startup seeding and the public /seed-super-admin endpoint.

- Creates the first SUPER_ADMIN (and optionally the first tenant). It refuses to run when a
  SUPER_ADMIN already exists, so it cannot be used to reset or add privileged accounts later.
- Never uses a built-in password: the password comes from the BOOTSTRAP_SUPERADMIN_PASSWORD
  environment variable or an interactive prompt, and must be strong.
- Does nothing unless --execute is passed, and then only after the database host you name with
  --confirm-host matches the host in DATABASE_URL (guards against pointing at the wrong database).
- Secrets are never printed.

Usage (from the fastapi/ directory, with DATABASE_URL set for the target database):

    python scripts/bootstrap_admin.py --username owner --email owner@example.com \\
        --create-tenant "Main Branch" --confirm-host <db-host>            # dry run
    python scripts/bootstrap_admin.py ... --execute                        # perform it
"""
import argparse
import getpass
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

WEAK_PASSWORDS = {
    "superadmin123", "admin123", "manager123", "cashier123", "inventory123", "kitchen123",
    "password", "password123", "12345678", "123456789012", "qwertyuiop12",
}


def validate_password(password: str) -> list:
    problems = []
    if len(password) < 12:
        problems.append("must be at least 12 characters")
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        problems.append("must contain letters and digits")
    if password.lower() in WEAK_PASSWORDS:
        problems.append("is a well-known default password")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Create the first SUPER_ADMIN (one-time).")
    parser.add_argument("--username", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--create-tenant", metavar="NAME", help="Also create the first tenant with this name (only if none exists).")
    parser.add_argument("--tenant-code", help="Tenant code/subdomain (default: derived from the name).")
    parser.add_argument("--confirm-host", required=True, help="Database host you expect to be modifying.")
    parser.add_argument("--execute", action="store_true", help="Actually write to the database (default is a dry run).")
    args = parser.parse_args()

    from app.db import SessionLocal, DB_HOST, DB_NAME
    import app.models as models
    from app.core.security import get_password_hash

    print(f"Target database: host={DB_HOST} name={DB_NAME}")
    if args.confirm_host.strip().lower() != str(DB_HOST).strip().lower():
        print("ERROR: --confirm-host does not match the database host in DATABASE_URL. Nothing was changed.")
        return 2

    db = SessionLocal()
    try:
        if db.query(models.User).filter(models.User.role == models.UserRole.SUPER_ADMIN).first():
            print("ERROR: a SUPER_ADMIN already exists. Bootstrap is one-time only. Nothing was changed.")
            return 3

        username = args.username.strip()
        email = args.email.strip().lower()
        if len(username) < 3:
            print("ERROR: username must be at least 3 characters.")
            return 2

        password = os.environ.get("BOOTSTRAP_SUPERADMIN_PASSWORD") or ""
        if not password:
            password = getpass.getpass("New SUPER_ADMIN password (input hidden): ")
            if password != getpass.getpass("Repeat password: "):
                print("ERROR: passwords do not match.")
                return 2
        problems = validate_password(password)
        if problems:
            print("ERROR: password " + "; ".join(problems) + ".")
            return 2

        tenant = None
        if args.create_tenant:
            if db.query(models.Tenant).first():
                print("NOTE: a tenant already exists; --create-tenant ignored.")
            else:
                code = args.tenant_code or re.sub(r"[^a-z0-9]+", "-", args.create_tenant.lower()).strip("-") or "main"
                tenant = models.Tenant(name=args.create_tenant.strip(), subdomain_or_code=code, is_active=True)

        print(f"Will create SUPER_ADMIN '{username}' <{email}>" + (f" and tenant '{tenant.name}'" if tenant else "") + ".")
        if not args.execute:
            print("Dry run only. Re-run with --execute to apply.")
            return 0

        if tenant:
            db.add(tenant)
        db.add(models.User(
            username=username,
            email=email,
            password_hash=get_password_hash(password),
            role=models.UserRole.SUPER_ADMIN,
            tenant_id=None,
            is_active=True,
        ))
        db.commit()
        print("Done. Sign in and rotate this password after first use.")
        return 0
    except Exception as exc:  # noqa: BLE001 - report without leaking connection details
        db.rollback()
        print(f"ERROR: bootstrap failed ({type(exc).__name__}). Nothing was changed.")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
