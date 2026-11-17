import os
import sys
import logging
import uuid
from urllib.parse import urlparse

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Ensure the 'fastapi' directory is in sys.path so 'app.*' imports always resolve
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.gzip import GZipMiddleware
from app.db import engine, Base, get_db
import app.models as models
from app.core.security import get_password_hash, IS_PRODUCTION
from app.core.dependencies import get_current_user_optional
from app.routers.auth import router as auth_router
from app.routers.users import router as users_router
from app.routers.activity_logs import router as activity_logs_router
from app.routers.reports import router as reports_router
from app.routers.products import router as products_router
from app.routers.inventory import router as inventory_router
from app.routers.analytics import router as analytics_router
from app.routers.suppliers import router as suppliers_router
from app.routers.purchase_orders import router as purchase_orders_router
from app.routers.expenses import router as expenses_router


# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pos_app")

# Resolve absolute paths to prevent static directory lookup issues
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_list(name: str) -> list:
    return [item.strip() for item in os.getenv(name, "").split(",") if item.strip()]


# Origins allowed to call the API cross-origin (the bundled UI is same-origin and needs none).
ALLOWED_ORIGINS = _env_list("ALLOWED_ORIGINS")
ALLOWED_HOSTS = _env_list("ALLOWED_HOSTS")

# Development conveniences. Both are forced off in production.
SEED_DEMO_DATA = (not IS_PRODUCTION) and _env_flag("SEED_DEMO_DATA", False)
AUTO_CREATE_TABLES = (not IS_PRODUCTION) and _env_flag("DB_AUTO_CREATE_TABLES", True)
ENABLE_API_DOCS = _env_flag("ENABLE_API_DOCS", not IS_PRODUCTION)

if "*" in ALLOWED_ORIGINS:
    raise RuntimeError("ALLOWED_ORIGINS must list explicit origins; a wildcard cannot be combined with credentials.")


def seed_demo_data():
    """
    DEVELOPMENT ONLY (SEED_DEMO_DATA=true, never in production).
    Creates a demo tenant and one account per role with well-known passwords so a local
    database is immediately usable. Real deployments create their first administrator with
    scripts/bootstrap_admin.py instead.
    """
    from app.db import SessionLocal
    db = SessionLocal()
    try:
        tenant = db.query(models.Tenant).first()
        if not tenant:
            tenant = models.Tenant(
                name="Main Branch - Blessie FoodHub",
                subdomain_or_code="main-branch",
                is_active=True
            )
            db.add(tenant)
            db.commit()
            db.refresh(tenant)

        accounts = [
            ("superadmin", models.UserRole.SUPER_ADMIN, "superadmin123", None),
            ("admin", models.UserRole.ADMIN, "admin123", tenant.id),
            ("manager", models.UserRole.MANAGER, "manager123", tenant.id),
            ("cashier", models.UserRole.CASHIER, "cashier123", tenant.id),
            ("inventory", models.UserRole.INVENTORY, "inventory123", tenant.id),
            ("kitchen", models.UserRole.KITCHEN, "kitchen123", tenant.id),
        ]
        for username, role, pwd, tenant_id in accounts:
            if not db.query(models.User).filter(models.User.username == username).first():
                db.add(models.User(
                    username=username,
                    email=f"{username}@inboxpos.com",
                    password_hash=get_password_hash(pwd),
                    role=role,
                    tenant_id=tenant_id,
                    is_active=True
                ))
                db.commit()
                logger.warning("DEV ONLY: seeded demo %s account '%s'.", role.name, username)
    except Exception:
        db.rollback()
        logger.exception("Error during demo seeding")
    finally:
        db.close()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application startup/shutdown.
    - The database must be reachable; otherwise startup fails loudly instead of serving a broken app.
    - Schema changes are NOT applied automatically in production. Apply the reviewed SQL in
      supabase/migrations/ as a separate release step (see docs/DEPLOYMENT.md).
    """
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        logger.critical("Database is not reachable; refusing to start.", exc_info=True)
        raise RuntimeError("Database connection failed. Check DATABASE_URL / DB_* settings.")

    if AUTO_CREATE_TABLES:
        Base.metadata.create_all(bind=engine)
        logger.info("Development: database tables ensured via create_all.")
    if SEED_DEMO_DATA:
        seed_demo_data()
    yield
    logger.info("Shutting down Inbox POS API...")

from fastapi.middleware.cors import CORSMiddleware

# Initialize FastAPI application
app = FastAPI(
    title="Inbox POS Backend",
    description="Multi-Tenant FastAPI Backend for Inbox POS System with JWT Auth",
    version="1.2.0",
    lifespan=lifespan,
    docs_url="/docs" if ENABLE_API_DOCS else None,
    redoc_url="/redoc" if ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)

# CORS: explicit origins only. With no ALLOWED_ORIGINS the API is same-origin only.
if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Tenant-ID", "X-Tracking-Token", "Idempotency-Key"],
    )
if ALLOWED_HOSTS:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)

CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    # The current UI relies on inline scripts/handlers; tighten once those are moved out.
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Adds a request id, blocks cross-site cookie-authenticated writes, and sets security headers."""

    async def dispatch(self, request: Request, call_next):
        request_id = uuid.uuid4().hex
        request.state.request_id = request_id

        # CSRF defence in depth (cookies are also SameSite=Lax): a browser-originated write that
        # relies on the session cookie must come from this site or an allowed origin.
        if (
            request.method in UNSAFE_METHODS
            and request.cookies.get("session_token")
            and not request.headers.get("authorization")
        ):
            origin = request.headers.get("origin") or request.headers.get("referer")
            if not origin:
                # Browsers always send Origin on cross-site writes; anything cookie-authenticated
                # without it or a Referer is not a normal browser request.
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Cross-site request blocked.", "request_id": request_id},
                    headers={"X-Request-ID": request_id},
                )
            parsed = urlparse(origin)
            origin_host = parsed.netloc.lower()
            origin_base = f"{parsed.scheme}://{parsed.netloc}".lower()
            same_site = origin_host == (request.headers.get("host") or "").lower()
            if not same_site and origin_base not in [o.lower() for o in ALLOWED_ORIGINS]:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Cross-site request blocked.", "request_id": request_id},
                    headers={"X-Request-ID": request_id},
                )

        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(self), geolocation=()")
        response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        if IS_PRODUCTION:
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response


app.add_middleware(RequestContextMiddleware)
# GZip compression: reduces payload size for JS/CSS/JSON (510KB views.js → ~120KB over the wire)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Log the traceback server-side; clients only receive a generic message and a request id."""
    request_id = getattr(request.state, "request_id", uuid.uuid4().hex)
    logger.error("Unhandled error [request_id=%s] %s %s", request_id, request.method, request.url.path, exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error.", "request_id": request_id},
        headers={"X-Request-ID": request_id},
    )

from app.routers.transactions import router as transactions_router
from app.routers.kitchen import router as kitchen_router
from app.routers.customer_orders import router as customer_orders_router
from app.routers.shifts import router as shifts_router

# Register routers
app.include_router(auth_router, prefix="/api/v1")
app.include_router(users_router, prefix="/api/v1")
app.include_router(activity_logs_router, prefix="/api/v1")
app.include_router(reports_router, prefix="/api/v1")
app.include_router(products_router, prefix="/api/v1")
app.include_router(inventory_router, prefix="/api/v1")
app.include_router(analytics_router, prefix="/api/v1")
app.include_router(transactions_router, prefix="/api/v1")
app.include_router(kitchen_router, prefix="/api/v1")
app.include_router(suppliers_router, prefix="/api/v1")
app.include_router(purchase_orders_router, prefix="/api/v1")
app.include_router(expenses_router, prefix="/api/v1")
app.include_router(customer_orders_router, prefix="/api/v1")

app.include_router(shifts_router, prefix="/api/v1")

from app.routers.tables import router as tables_router
app.include_router(tables_router, prefix="/api/v1")

# WebSocket route is registered exactly once (/api/v1/ws and /api/v1/ws/{tenant_id}).
from app.routers.realtime import router as realtime_router
app.include_router(realtime_router, prefix="/api/v1")


# Role-gated HTML shells are served by the guarded routes below; only these pages are public.
PUBLIC_STATIC_HTML = {"index.html", "customer.html", "auth/login.html"}


class PublicStaticFiles(StaticFiles):
    """StaticFiles that never serves protected dashboard HTML directly (bypassing the role guard)."""

    async def get_response(self, path: str, scope):
        normalized = path.replace("\\", "/").lstrip("/")
        if normalized.lower().endswith((".html", ".htm")) and normalized not in PUBLIC_STATIC_HTML:
            raise HTTPException(status_code=404)
        response = await super().get_response(path, scope)
        ext = os.path.splitext(normalized)[1].lower()
        if ext in (".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf"):
            response.headers["Cache-Control"] = "public, max-age=86400, stale-while-revalidate=604800"
        return response


# Mount static files directories to serve frontend assets using absolute paths
app.mount("/static", PublicStaticFiles(directory=STATIC_DIR), name="static")
if os.path.exists(os.path.join(STATIC_DIR, "assets")):
    app.mount("/assets", PublicStaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")


NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, private",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff"
}

def get_role_dashboard(role_str: str) -> str:
    r = (role_str or "").lower()
    if r == "super_admin":
        return "/dashboard"
    elif r in ("admin", "manager", "inventory", "cashier", "kitchen", "customer"):
        return f"/{r}"
    return "/"

def serve_protected_page(request: Request, db: Session, page_path: str, allowed_roles: set):
    """
    Enforces server-side session-based authentication for HTML pages.
    - If unauthenticated, expired, or revoked: redirects to /login?unauthorized=1.
    - If authenticated but wrong role: redirects to authorized dashboard.
    - If authorized: returns FileResponse with strict anti-cache headers so browser Back button cannot restore access.
    """
    user = get_current_user_optional(request=request, token=None, db=db)
    if not user:
        return RedirectResponse(url="/login?unauthorized=1", status_code=status.HTTP_302_FOUND)
    
    role_str = (user.role.value if hasattr(user.role, 'value') else str(user.role)).lower()
    allowed_lower = {r.lower() for r in allowed_roles}
    
    # SUPER_ADMIN has master access across administrative interfaces
    if role_str == "super_admin" or role_str in allowed_lower:
        return FileResponse(page_path, headers=NO_CACHE_HEADERS)
    
    # User is logged in but not permitted on this dashboard -> redirect to their authorized dashboard
    return RedirectResponse(url=get_role_dashboard(role_str), status_code=status.HTTP_302_FOUND)


# Public & Authentication HTML Page Routes
@app.get("/", response_class=FileResponse)
@app.get("/login", response_class=FileResponse)
@app.get("/auth/login", response_class=FileResponse)
def get_login_page(request: Request, db: Session = Depends(get_db)):
    """
    Sign in page. If user already has an active server session, redirects to their assigned dashboard.
    """
    user = get_current_user_optional(request=request, token=None, db=db)
    if user:
        role_str = (user.role.value if hasattr(user.role, 'value') else str(user.role)).lower()
        return RedirectResponse(url=get_role_dashboard(role_str), status_code=status.HTTP_302_FOUND)
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=NO_CACHE_HEADERS)


# PWA & Home Screen Icon Root Endpoints
@app.get("/manifest.webmanifest")
@app.get("/manifest.json")
def get_manifest():
    manifest_path = os.path.join(STATIC_DIR, "manifest.webmanifest")
    return FileResponse(manifest_path, media_type="application/manifest+json")

@app.get("/favicon.ico")
def get_favicon():
    favicon_path = os.path.join(STATIC_DIR, "images", "favicon.ico")
    return FileResponse(favicon_path, media_type="image/x-icon")

@app.get("/apple-touch-icon.png")
@app.get("/apple-touch-icon-precomposed.png")
@app.get("/apple-touch-icon-180x180.png")
def get_apple_touch_icon():
    icon_path = os.path.join(STATIC_DIR, "images", "apple-touch-icon.png")
    return FileResponse(icon_path, media_type="image/png")


# Role-Protected HTML Page Routes
@app.get("/admin", response_class=FileResponse)
@app.get("/admin.html", response_class=FileResponse)
@app.get("/admin/dashboard", response_class=FileResponse)
@app.get("/admin/dashboard.html", response_class=FileResponse)
def get_admin_shell(request: Request, db: Session = Depends(get_db)):
    admin_page = os.path.join(STATIC_DIR, "admin", "admin.html")
    if not os.path.exists(admin_page):
        admin_page = os.path.join(STATIC_DIR, "pages", "admin.html")
    if not os.path.exists(admin_page):
        admin_page = os.path.join(STATIC_DIR, "admin.html")
    return serve_protected_page(request, db, admin_page, allowed_roles={"admin", "super_admin"})

@app.get("/manager", response_class=FileResponse)
@app.get("/manager.html", response_class=FileResponse)
def get_manager_shell(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "pages", "manager.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "manager.html")
    return serve_protected_page(request, db, page, allowed_roles={"manager", "admin", "super_admin"})

@app.get("/inventory", response_class=FileResponse)
@app.get("/inventory.html", response_class=FileResponse)
def get_inventory_shell(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "pages", "inventory.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "inventory.html")
    return serve_protected_page(request, db, page, allowed_roles={"inventory", "manager", "admin", "super_admin"})

@app.get("/cashier", response_class=FileResponse)
@app.get("/cashier.html", response_class=FileResponse)
def get_cashier_shell(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "pages", "cashier.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "cashier.html")
    return serve_protected_page(request, db, page, allowed_roles={"cashier", "admin", "super_admin"})

@app.get("/kitchen", response_class=FileResponse)
@app.get("/kitchen.html", response_class=FileResponse)
def get_kitchen_shell(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "pages", "kitchen.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "kitchen.html")
    return serve_protected_page(request, db, page, allowed_roles={"kitchen", "admin", "super_admin"})

@app.get("/customer", response_class=FileResponse)
@app.get("/customer.html", response_class=FileResponse)
@app.get("/costumer", response_class=FileResponse)
def get_customer_page():
    return FileResponse(os.path.join(STATIC_DIR, "customer.html"), headers=NO_CACHE_HEADERS)


# Super Admin Protected Pages
@app.get("/dashboard", response_class=FileResponse)
@app.get("/dashboard.html", response_class=FileResponse)
@app.get("/super_admin", response_class=FileResponse)
@app.get("/super_admin.html", response_class=FileResponse)
@app.get("/super_admin/dashboard", response_class=FileResponse)
@app.get("/super_admin/dashboard.html", response_class=FileResponse)
@app.get("/super-admin", response_class=FileResponse)
@app.get("/super-admin/dashboard", response_class=FileResponse)
@app.get("/super-admin/dashboard.html", response_class=FileResponse)
def get_dashboard_page(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "super_admin", "dashboard.html")
    return serve_protected_page(request, db, page, allowed_roles={"super_admin"})

@app.get("/users", response_class=FileResponse)
@app.get("/users.html", response_class=FileResponse)
@app.get("/super_admin/users", response_class=FileResponse)
@app.get("/super_admin/users.html", response_class=FileResponse)
@app.get("/super-admin/users", response_class=FileResponse)
@app.get("/super-admin/users.html", response_class=FileResponse)
def get_users_page(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "super_admin", "users.html")
    return serve_protected_page(request, db, page, allowed_roles={"super_admin"})

@app.get("/create-user", response_class=FileResponse)
@app.get("/create_user", response_class=FileResponse)
@app.get("/create-user.html", response_class=FileResponse)
@app.get("/create_user.html", response_class=FileResponse)
@app.get("/super_admin/create-user", response_class=FileResponse)
@app.get("/super_admin/create_user", response_class=FileResponse)
@app.get("/super_admin/create-user.html", response_class=FileResponse)
@app.get("/super_admin/create_user.html", response_class=FileResponse)
@app.get("/super-admin/create-user", response_class=FileResponse)
@app.get("/super-admin/create_user", response_class=FileResponse)
@app.get("/super-admin/create-user.html", response_class=FileResponse)
@app.get("/super-admin/create_user.html", response_class=FileResponse)
def get_create_user_page(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "super_admin", "create_user.html")
    return serve_protected_page(request, db, page, allowed_roles={"super_admin"})

@app.get("/activity-logs", response_class=FileResponse)
@app.get("/activity_logs", response_class=FileResponse)
@app.get("/activity-logs.html", response_class=FileResponse)
@app.get("/activity_logs.html", response_class=FileResponse)
@app.get("/super_admin/activity-logs", response_class=FileResponse)
@app.get("/super_admin/activity_logs", response_class=FileResponse)
@app.get("/super_admin/activity-logs.html", response_class=FileResponse)
@app.get("/super_admin/activity_logs.html", response_class=FileResponse)
@app.get("/super-admin/activity-logs", response_class=FileResponse)
@app.get("/super-admin/activity_logs", response_class=FileResponse)
@app.get("/super-admin/activity-logs.html", response_class=FileResponse)
@app.get("/super-admin/activity_logs.html", response_class=FileResponse)
def get_activity_logs_page(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "super_admin", "activity_logs.html")
    return serve_protected_page(request, db, page, allowed_roles={"super_admin"})

@app.get("/reports", response_class=FileResponse)
@app.get("/reports.html", response_class=FileResponse)
@app.get("/super_admin/reports", response_class=FileResponse)
@app.get("/super_admin/reports.html", response_class=FileResponse)
@app.get("/super-admin/reports", response_class=FileResponse)
@app.get("/super-admin/reports.html", response_class=FileResponse)
def get_reports_page(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "super_admin", "reports.html")
    return serve_protected_page(request, db, page, allowed_roles={"super_admin"})

@app.get("/profile", response_class=FileResponse)
@app.get("/profile.html", response_class=FileResponse)
@app.get("/super_admin/profile", response_class=FileResponse)
@app.get("/super_admin/profile.html", response_class=FileResponse)
@app.get("/super-admin/profile", response_class=FileResponse)
@app.get("/super-admin/profile.html", response_class=FileResponse)
def get_profile_page(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "super_admin", "profile.html")
    return serve_protected_page(request, db, page, allowed_roles={"super_admin"})

@app.get("/settings", response_class=FileResponse)
@app.get("/settings.html", response_class=FileResponse)
@app.get("/super_admin/settings", response_class=FileResponse)
@app.get("/super_admin/settings.html", response_class=FileResponse)
@app.get("/super-admin/settings", response_class=FileResponse)
@app.get("/super-admin/settings.html", response_class=FileResponse)
def get_settings_page(request: Request, db: Session = Depends(get_db)):
    page = os.path.join(STATIC_DIR, "super_admin", "settings.html")
    return serve_protected_page(request, db, page, allowed_roles={"super_admin"})


@app.get("/healthz", include_in_schema=False)
def healthz():
    """Liveness probe: the process is up. Deliberately touches no dependency."""
    return {"status": "ok"}


@app.get("/readyz", include_in_schema=False)
def readyz(db: Session = Depends(get_db)):
    """Readiness probe: the database answers. Discloses nothing beyond ok / unavailable."""
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        logger.error("Readiness check failed", exc_info=True)
        return JSONResponse(status_code=503, content={"status": "unavailable"})
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    # Render, Heroku, and Railway inject the PORT environment variable
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=False)
