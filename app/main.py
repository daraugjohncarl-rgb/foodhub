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
from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.db import engine, Base, get_db
import app.models as models
from app.core.security import get_password_hash
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

def seed_default_data():
    """
    Seeds default Tenant, Super Admin, and initial Branch Admin accounts on startup.
    Only creates accounts if they do not already exist, preserving all custom user passwords.
    """
    from app.db import SessionLocal
    db = SessionLocal()
    try:
        # 1. Ensure default Tenant exists
        tenant = db.query(models.Tenant).first()
        if not tenant:
            logger.info("Seeding default Tenant 'Main Branch - Blessie FoodHub'...")
            tenant = models.Tenant(
                name="Main Branch - Blessie FoodHub",
                subdomain_or_code="main-branch",
                is_active=True
            )
            db.add(tenant)
            db.commit()
            db.refresh(tenant)

        # 2. Ensure default SUPER_ADMIN exists
        super_admin = db.query(models.User).filter(models.User.role == models.UserRole.SUPER_ADMIN).first()
        if not super_admin:
            logger.info("Seeding default SUPER_ADMIN 'superadmin'...")
            default_super = models.User(
                username="superadmin",
                email="superadmin@inboxpos.com",
                password_hash=get_password_hash("superadmin123"),
                role=models.UserRole.SUPER_ADMIN,
                tenant_id=None,
                is_active=True
            )
            db.add(default_super)
            db.commit()
            logger.info("Default SUPER_ADMIN 'superadmin' seeded successfully.")

        # 3. Ensure default ADMIN exists ('admin' / 'admin123') ONLY if no admin exists
        admin_user = db.query(models.User).filter(models.User.username == "admin").first()
        if not admin_user:
            logger.info("Seeding default ADMIN 'admin'...")
            admin_user = models.User(
                username="admin",
                email="admin@inboxpos.com",
                password_hash=get_password_hash("admin123"),
                role=models.UserRole.ADMIN,
                tenant_id=tenant.id,
                is_active=True
            )
            db.add(admin_user)
            db.commit()
            logger.info("Default ADMIN 'admin' seeded successfully.")

        # 3.5 Ensure default staff users exist for testing/demo
        roles_to_seed = [
            ("manager", models.UserRole.MANAGER, "manager123"),
            ("cashier", models.UserRole.CASHIER, "cashier123"),
            ("inventory", models.UserRole.INVENTORY, "inventory123"),
            ("kitchen", models.UserRole.KITCHEN, "kitchen123"),
        ]
        
        for username, role, pwd in roles_to_seed:
            user = db.query(models.User).filter(models.User.username == username).first()
            if not user:
                logger.info(f"Seeding default {role.name} '{username}'...")
                user = models.User(
                    username=username,
                    email=f"{username}@inboxpos.com",
                    password_hash=get_password_hash(pwd),
                    role=role,
                    tenant_id=tenant.id,
                    is_active=True
                )
                db.add(user)
                db.commit()
                logger.info(f"Default {role.name} '{username}' seeded successfully.")

        # 4. Ensure existing users without tenant_id are associated with the default tenant
        orphan_users = db.query(models.User).filter(
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.tenant_id.is_(None)
        ).all()
        for u in orphan_users:
            u.tenant_id = tenant.id
        if orphan_users:
            db.commit()

        # 5. Note: Masterlist auto-seeding removed to allow custom inventory and product menu management.

        # 6. Seed default suppliers under 'Main Branch - Blessie FoodHub'
        target_tenant = db.query(models.Tenant).filter(models.Tenant.name == "Main Branch - Blessie FoodHub").first()
        if target_tenant:
            from app.seed_data import DEFAULT_SUPPLIERS
            existing_sup_names = {s[0] for s in db.query(models.Supplier.supplier_name).filter(models.Supplier.tenant_id == target_tenant.id).all()}
            has_new_sup = False
            for s_data in DEFAULT_SUPPLIERS:
                if s_data["name"] not in existing_sup_names:
                    new_sup = models.Supplier(
                        tenant_id=target_tenant.id,
                        supplier_name=s_data["name"],
                        contact_number=s_data["contact"],
                        category=s_data["category"],
                        products_supplied=s_data["products"],
                        status="Active"
                    )
                    db.add(new_sup)
                    existing_sup_names.add(s_data["name"])
                    has_new_sup = True
            if has_new_sup:
                db.commit()

    except Exception as e:
        db.rollback()
        logger.error(f"Error during auto-seeding: {e}")
    finally:
        db.close()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan event handler for FastAPI to manage application startup and shutdown.
    Automatically creates all tables inside the MySQL database if they do not exist,
    and then seeds the default system accounts.
    """
    try:
        # Create all tables defined in models.py
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables initialized successfully.")
        
        # Seed default data
        seed_default_data()
    except Exception as e:
        logger.critical(f"Failed to initialize database on startup: {e}")
    yield
    logger.info("Shutting down Inbox POS API...")

from fastapi.middleware.cors import CORSMiddleware

# Initialize FastAPI application
app = FastAPI(
    title="Inbox POS Backend",
    description="Multi-Tenant FastAPI Backend for Inbox POS System with JWT Auth and MySQL",
    version="1.2.0",
    lifespan=lifespan
)

# CORS middleware for frontend flexibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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

from app.routers.realtime import router as realtime_router
app.include_router(realtime_router, prefix="/api/v1")
app.include_router(realtime_router)

# Mount static files directories to serve frontend assets using absolute paths
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if os.path.exists(os.path.join(STATIC_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")


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


@app.get("/test-db")
def test_db(db: Session = Depends(get_db)):
    """
    Endpoint to verify database connectivity.
    Executes a test query and prints active tenant and total user counts.
    """
    try:
        # Verify connection viability
        result = db.execute(text("SELECT 1")).fetchone()
        if not result or result[0] != 1:
            raise Exception("Test query failed.")

        # Query active tenant count
        active_tenant_count = db.query(models.Tenant).filter(models.Tenant.is_active == True).count()

        # Query total user count
        total_user_count = db.query(models.User).count()

        return {
            "status": "online",
            "message": "Successfully connected to the database server.",
            "database_name": engine.url.database,
            "host": engine.url.host,
            "port": engine.url.port,
            "stats": {
                "active_tenants": active_tenant_count,
                "total_users": total_user_count
            }
        }
    except Exception as e:
        logger.error(f"Database connectivity test failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "status": "offline",
                "message": "Database server is offline or database does not exist.",
                "error": str(e)
            }
        )

@app.post("/seed-super-admin", status_code=status.HTTP_200_OK)
def seed_super_admin_route(db: Session = Depends(get_db)):
    """
    Endpoint to manually trigger database seeding for the default SUPER_ADMIN user.
    """
    try:
        super_admin = db.query(models.User).filter(models.User.role == models.UserRole.SUPER_ADMIN).first()
        if not super_admin:
            default_super = models.User(
                username="superadmin",
                email="superadmin@inboxpos.com",
                password_hash=get_password_hash("superadmin123"),
                role=models.UserRole.SUPER_ADMIN,
                tenant_id=None,
                is_active=True
            )
            db.add(default_super)
            db.commit()
            db.refresh(default_super)
            return {
                "status": "seeded",
                "message": "Default SUPER_ADMIN seeded successfully.",
                "user": {
                    "id": default_super.id,
                    "username": default_super.username,
                    "role": default_super.role
                }
            }
        else:
            return {
                "status": "existing",
                "message": "SUPER_ADMIN already exists.",
                "user": {
                    "id": super_admin.id,
                    "username": super_admin.username,
                    "role": super_admin.role
                }
            }
    except Exception as e:
        db.rollback()
        logger.error(f"Manual seed routing failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to seed super admin: {str(e)}"
        )

if __name__ == "__main__":
    import uvicorn
    # Render, Heroku, and Railway inject the PORT environment variable
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=False)
