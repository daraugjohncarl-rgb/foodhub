#!/usr/bin/env python3
"""
Inbox POS - Localhost Server & Test Runner
Run this script from the project root to start the backend on localhost or run tests.

Usage:
    python run.py             # Start the server on http://127.0.0.1:8000
    python run.py --reload    # Start with auto-reload (default)
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

# Configure sys.path so 'app.*' imports work from the root workspace
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
    parser.add_argument("--test", action="store_true", help="Run full system E2E tests instead of starting server")
    parser.add_argument("--audit", action="store_true", help="Run static route and asset audit")
    
    args = parser.parse_args()

    # Change working directory to fastapi so relative static files and .env resolve smoothly
    os.chdir(FASTAPI_DIR)

    if args.test:
        print("\n[Running Inbox POS System E2E Validation Tests...]")
        import test_complete_system
        test_complete_system.run_e2e_tests()
        return

    if args.audit:
        print("\n[Running Static Route and Asset Audit...]")
        import audit_system
        audit_system.test_system()
        return

    import uvicorn

    print("\n========================================================")
    print(" 🍔 INBOX POS - BLESSIE FOODHUB BACKEND & WEB APP")
    print("========================================================")
    print(f"  • Local Server URL : http://{args.host}:{args.port}")
    print(f"  • API Documentation: http://{args.host}:{args.port}/docs")
    print(f"  • Database Health  : http://{args.host}:{args.port}/test-db")
    print("--------------------------------------------------------")
    print("  Default Roles & Demo Credentials:")
    print("  - Super Admin : superadmin / superadmin123  -> /dashboard")
    print("  - Branch Admin: admin      / admin123       -> /admin")
    print("  - Manager     : manager    / manager123     -> /manager")
    print("  - Cashier POS : cashier    / cashier123     -> /cashier")
    print("  - Inventory   : inventory  / inventory123   -> /inventory")
    print("  - Kitchen KDS : kitchen    / kitchen123     -> /kitchen")
    print("  - Customer    : customer   / customer123    -> /customer")
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
