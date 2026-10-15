import os
import sys
import logging

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Ensure the 'fastapi' directory is in sys.path so 'app.*' imports always resolve
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core import config
from app.db import engine, get_db, SessionLocal, describe_database
import app.models as models
from app.core.dependencies import require_permission
from app.core.schema import assert_schema_current, current_revision
from app.seed import ensure_essentials, seed_demo_data
from app.routers.auth import router as auth_router
from app.routers.users import router as users_router
from app.routers.activity_logs import router as activity_logs_router
from app.routers.reports import router as reports_router
from app.routers.products import router as products_router
from app.routers.inventory import router as inventory_router
from app.routers.analytics import router as analytics_router
from app.routers.suppliers import router as suppliers_router
from app.routers.purchase_orders import router as purchase_orders_router
from app.routers.transactions import router as transactions_router
from app.routers.kitchen import router as kitchen_router
from app.routers.customer_orders import router as customer_orders_router
from app.routers.shifts import router as shifts_router
from app.routers.tables import router as tables_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pos_app")

# Resolve absolute paths to prevent static directory lookup issues
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Start-up never creates or alters tables (migrations are applied by a person with Alembic) and never swallows
    errors: if the schema is behind the code or essential data cannot be created, the process exits instead of
    reporting itself healthy.
    """
    logger.info("Starting Inbox POS (APP_ENV=%s, %s)", config.APP_ENV, describe_database())
    assert_schema_current(engine)
    db = SessionLocal()
    try:
        tenant = ensure_essentials(db)
        if config.SEED_DEMO_DATA:
            seed_demo_data(db, tenant)
    finally:
        db.close()
    yield
    logger.info("Shutting down Inbox POS API...")


app = FastAPI(
    title="Inbox POS Backend",
    description="Multi-tenant FastAPI backend for the Inbox POS system (PostgreSQL, JWT auth).",
    version="1.3.0",
    lifespan=lifespan,
    docs_url="/docs" if config.ENABLE_API_DOCS else None,
    redoc_url="/redoc" if config.ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if config.ENABLE_API_DOCS else None,
)

# Bearer tokens are sent in the Authorization header, never in cookies, so credentials are not needed cross-origin.
if config.CORS_ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # Full details go to the server log only; the client never sees SQL, stack traces or host names.
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "An internal error occurred. Please try again."})


# Register routers
for router in (
    auth_router, users_router, activity_logs_router, reports_router, products_router, inventory_router,
    analytics_router, transactions_router, kitchen_router, suppliers_router, purchase_orders_router,
    customer_orders_router, shifts_router, tables_router,
):
    app.include_router(router, prefix="/api/v1")

# Mount static files directories to serve frontend assets using absolute paths
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if os.path.exists(os.path.join(STATIC_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")


def _page(*parts: str) -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, *parts))


# Explicit HTML page routes: one file per page.
@app.get("/", response_class=FileResponse, include_in_schema=False)
@app.get("/login", response_class=FileResponse, include_in_schema=False)
@app.get("/auth/login", response_class=FileResponse, include_in_schema=False)
def get_login_page():
    return _page("index.html")


@app.get("/admin", response_class=FileResponse, include_in_schema=False)
@app.get("/admin.html", response_class=FileResponse, include_in_schema=False)
@app.get("/admin/dashboard", response_class=FileResponse, include_in_schema=False)
@app.get("/admin/dashboard.html", response_class=FileResponse, include_in_schema=False)
def get_admin_shell():
    return _page("admin", "admin.html")


@app.get("/manager", response_class=FileResponse, include_in_schema=False)
@app.get("/manager.html", response_class=FileResponse, include_in_schema=False)
def get_manager_shell():
    return _page("pages", "manager.html")


@app.get("/inventory", response_class=FileResponse, include_in_schema=False)
@app.get("/inventory.html", response_class=FileResponse, include_in_schema=False)
def get_inventory_shell():
    return _page("pages", "inventory.html")


@app.get("/cashier", response_class=FileResponse, include_in_schema=False)
@app.get("/cashier.html", response_class=FileResponse, include_in_schema=False)
def get_cashier_shell():
    return _page("pages", "cashier.html")


@app.get("/kitchen", response_class=FileResponse, include_in_schema=False)
@app.get("/kitchen.html", response_class=FileResponse, include_in_schema=False)
def get_kitchen_shell():
    return _page("pages", "kitchen.html")


@app.get("/customer", response_class=FileResponse, include_in_schema=False)
@app.get("/customer.html", response_class=FileResponse, include_in_schema=False)
@app.get("/costumer", response_class=FileResponse, include_in_schema=False)
def get_customer_page():
    return _page("customer.html")


SUPER_ADMIN_PAGES = {
    "dashboard": ["dashboard", "super_admin", "super-admin"],
    "users": ["users"],
    "create_user": ["create-user", "create_user"],
    "activity_logs": ["activity-logs", "activity_logs"],
    "reports": ["reports"],
    "profile": ["profile"],
    "settings": ["settings"],
}


def _register_super_admin_page(file_stem: str, slugs):
    paths = []
    for slug in slugs:
        paths += [f"/{slug}", f"/{slug}.html"]
        if slug not in ("super_admin", "super-admin"):
            for prefix in ("super_admin", "super-admin"):
                paths += [f"/{prefix}/{slug}", f"/{prefix}/{slug}.html"]
    if file_stem == "dashboard":
        paths += ["/super_admin/dashboard", "/super_admin/dashboard.html",
                  "/super-admin/dashboard", "/super-admin/dashboard.html"]

    def handler():
        return _page("super_admin", f"{file_stem}.html")

    handler.__name__ = f"get_super_admin_{file_stem}_page"
    for path in dict.fromkeys(paths):
        app.get(path, response_class=FileResponse, include_in_schema=False)(handler)


for _stem, _slugs in SUPER_ADMIN_PAGES.items():
    _register_super_admin_page(_stem, _slugs)


@app.get("/health", include_in_schema=False)
def health(db: Session = Depends(get_db)):
    """Minimal liveness/readiness probe for Docker and Render. Reveals nothing about the database."""
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        logger.exception("Health check: database unreachable")
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"status": "unavailable"})
    return {"status": "ok"}


@app.get("/test-db")
@app.get("/api/v1/admin/diagnostics")
def diagnostics(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("diagnostics.read")),
):
    """Detailed database diagnostics, SUPER_ADMIN only. Never includes credentials or raw exception text."""
    return {
        "status": "online",
        "app_env": config.APP_ENV,
        "schema_revision": current_revision(engine),
        "stats": {
            "active_tenants": db.query(models.Tenant).filter(models.Tenant.is_active.is_(True)).count(),
            "total_users": db.query(models.User).count(),
        },
    }


if __name__ == "__main__":
    import uvicorn
    # Render, Heroku, and Railway inject the PORT environment variable
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=False)
