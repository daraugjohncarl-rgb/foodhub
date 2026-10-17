#!/usr/bin/env python3
"""
Inbox POS - Localhost Server & Test Runner
Run this script from the project root to start the backend on localhost or run tests.

Usage:
    python run.py             # Start the server on http://127.0.0.1:8000
    python run.py --reload    # Start with auto-reload (default locally)
    python run.py --port 8080 # Start on custom port
    python run.py --test      # Run complete E2E system validation tests
    python run.py --audit     # Run route and static asset audit
"""

import os
import sys
import argparse

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Configure sys.path so 'app.*' imports work from anywhere
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
FASTAPI_DIR = os.path.join(ROOT_DIR, "fastapi")

# Pre-load environment variables from .env
try:
    from dotenv import load_dotenv
    if os.path.exists(os.path.join(ROOT_DIR, ".env")):
        load_dotenv(os.path.join(ROOT_DIR, ".env"))
    if os.path.isdir(FASTAPI_DIR) and os.path.exists(os.path.join(FASTAPI_DIR, ".env")):
        load_dotenv(os.path.join(FASTAPI_DIR, ".env"))
except ImportError:
    pass

# Ensure directories are in sys.path
if os.path.isdir(FASTAPI_DIR) and FASTAPI_DIR not in sys.path:
    sys.path.insert(0, FASTAPI_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

# Expose ASGI application instance so 'uvicorn run:app' resolves seamlessly on Render/production
from app.main import app

def main():
    # Cloud environments (Render, Heroku, Docker) provide PORT and require binding to 0.0.0.0
    is_cloud_env = bool(os.environ.get("PORT") or os.environ.get("RENDER"))
    default_host = os.environ.get("HOST", "0.0.0.0" if is_cloud_env else "127.0.0.1")
    default_port = int(os.environ.get("PORT", 8000))
    default_reload = False if is_cloud_env else True

    parser = argparse.ArgumentParser(description="Inbox POS Localhost Development Launcher")
    parser.add_argument("--host", default=default_host, help=f"Host IP to bind (default: {default_host})")
    parser.add_argument("--port", type=int, default=default_port, help=f"Port to bind (default: {default_port})")
    parser.add_argument("--reload", action="store_true", default=default_reload, help="Enable auto-reload on code changes")
    parser.add_argument("--no-reload", action="store_false", dest="reload", help="Disable auto-reload")
    parser.add_argument("--test", action="store_true", help="Run full system E2E tests instead of starting server")
    parser.add_argument("--audit", action="store_true", help="Run static route and asset audit")
    
    args = parser.parse_args()

    # Change working directory if fastapi subdir exists
    working_dir = FASTAPI_DIR if os.path.isdir(FASTAPI_DIR) else ROOT_DIR
    try:
        os.chdir(working_dir)
    except Exception as e:
        print(f"Notice: Could not change directory to {working_dir}: {e}")

    if args.test:
        print("\n[Running Inbox POS System E2E Validation Tests...]")
        try:
            import test_complete_system
            test_complete_system.run_e2e_tests()
        except ImportError as e:
            print(f"Error loading test runner: {e}")
        return

    if args.audit:
        print("\n[Running Static Route and Asset Audit...]")
        try:
            import audit_system
            audit_system.test_system()
        except ImportError as e:
            print(f"Error loading audit runner: {e}")
        return

    import uvicorn

    print("\n========================================================")
    print(" 🍔 INBOX POS - BLESSIE FOODHUB BACKEND & WEB APP")
    print("========================================================")
    print(f"  • Server URL       : http://{args.host}:{args.port}")
    print(f"  • API Documentation: http://{args.host}:{args.port}/docs")
    print(f"  • Database Health  : http://{args.host}:{args.port}/test-db")
    print(f"  • Auto-reload      : {'Enabled' if args.reload else 'Disabled'}")
    print("--------------------------------------------------------")
    print("  Default Roles & Demo Credentials:")
    print("  - Super Admin : superadmin / superadmin123  -> /dashboard")
    print("  - Branch Admin: admin      / admin123       -> /admin")
    print("  - Manager     : manager    / manager123     -> /manager")
    print("  - Cashier POS : cashier    / cashier123     -> /cashier")
    print("  - Inventory   : inventory  / inventory123   -> /inventory")
    print("  - Kitchen KDS : kitchen    / kitchen123     -> /kitchen")
    print("========================================================\n")

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        app_dir=working_dir
    )

if __name__ == "__main__":
    main()
