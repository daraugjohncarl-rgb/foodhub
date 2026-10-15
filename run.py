#!/usr/bin/env python3
"""
Inbox POS - Localhost Server & Test Runner
Run this script from the project root to start the backend on localhost or run the test suite.

Usage:
    python run.py             # Start the server on http://127.0.0.1:8000 (auto-reload)
    python run.py --no-reload # Start without auto-reload
    python run.py --port 8080 # Start on custom port
    python run.py --migrate   # Apply database migrations (alembic upgrade head), then exit
    python run.py --test      # Run the pytest suite (needs TEST_DATABASE_URL pointing at a *_test database)

Configuration comes from fastapi/.env (see fastapi/.env.example). The server refuses to start without
JWT_SECRET and a database configuration, and when the database schema is behind the code.
"""

import os
import sys
import argparse
import subprocess

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
FASTAPI_DIR = os.path.join(ROOT_DIR, "fastapi")
if FASTAPI_DIR not in sys.path:
    sys.path.insert(0, FASTAPI_DIR)


def main():
    parser = argparse.ArgumentParser(description="Inbox POS Localhost Development Launcher")
    parser.add_argument("--host", default="127.0.0.1", help="Host IP to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)), help="Port to bind (default: 8000)")
    parser.add_argument("--reload", action="store_true", default=True, help="Enable auto-reload on code changes (default: True)")
    parser.add_argument("--no-reload", action="store_false", dest="reload", help="Disable auto-reload")
    parser.add_argument("--test", action="store_true", help="Run the pytest suite against TEST_DATABASE_URL")
    parser.add_argument("--migrate", action="store_true", help="Apply database migrations (alembic upgrade head)")

    args = parser.parse_args()

    # Change working directory to fastapi so relative paths and .env resolve smoothly
    os.chdir(FASTAPI_DIR)

    if args.test:
        # The suite itself refuses any database whose name does not end in "_test" and never reads .env.
        if not os.getenv("TEST_DATABASE_URL"):
            sys.exit("Set TEST_DATABASE_URL to a disposable PostgreSQL database whose name ends in _test.")
        sys.exit(subprocess.call([sys.executable, "-m", "pytest", "-q"]))

    if args.migrate:
        from app.db import describe_database
        print(f"Applying migrations to {describe_database()}")
        if os.getenv("APP_ENV", "production").lower() == "production":   # unset = production (as in app config)
            if input("This is PRODUCTION. Have you taken a backup? Type 'yes' to continue: ").strip() != "yes":
                sys.exit("Aborted.")
        sys.exit(subprocess.call([sys.executable, "-m", "alembic", "upgrade", "head"]))

    import uvicorn

    print("\n========================================================")
    print(" 🍔 INBOX POS - BLESSIE FOODHUB BACKEND & WEB APP")
    print("========================================================")
    print(f"  • Local Server URL : http://{args.host}:{args.port}")
    print(f"  • API Documentation: http://{args.host}:{args.port}/docs (disabled in production)")
    print(f"  • Health check     : http://{args.host}:{args.port}/health")
    print("--------------------------------------------------------")
    print("  Development demo accounts are created only when SEED_DEMO_DATA is on;")
    print("  each must choose a new password at first login.")
    print("========================================================\n")

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        app_dir=FASTAPI_DIR
    )


if __name__ == "__main__":
    main()
