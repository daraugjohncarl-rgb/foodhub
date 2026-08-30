import os
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.db import engine, Base, get_db
import app.models as models
from app.core.security import get_password_hash
from app.routers.auth import router as auth_router
from app.routers.users import router as users_router
from app.routers.activity_logs import router as activity_logs_router
from app.routers.reports import router as reports_router
from app.routers.products import router as products_router
from app.routers.inventory import router as inventory_router
from app.routers.analytics import router as analytics_router

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

        # 4. Ensure existing users without tenant_id are associated with the default tenant
        orphan_users = db.query(models.User).filter(
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.tenant_id.is_(None)
        ).all()
        for u in orphan_users:
            u.tenant_id = tenant.id
        if orphan_users:
            db.commit()

        # 5. Seed / Sync Official Blessie FoodHub POS Menu Masterlist
        POS_MENU_MASTERLIST = {
            "Snacks": [
                ("Spaghetti w/ Bread — Single", 125.00),
                ("Spaghetti w/ Bread — Barkada", 550.00),
                ("Carbonara w/ Bread — Single", 140.00),
                ("Carbonara w/ Bread — Barkada", 480.00),
                ("Molo — Single", 55.00),
                ("Molo — Barkada", 200.00),
                ("Sotanghon Guisado — Single", 85.00),
                ("Sotanghon Guisado — Barkada", 280.00),
                ("Pancit Canton — Single", 85.00),
                ("Pancit Canton — Barkada", 280.00),
                ("Burger w/ Fries — Single", 95.00),
                ("Burger w/ Fries — Barkada", 450.00),
                ("Toasted Bread — 2 pcs", 30.00),
                ("Toasted Bread — 4 pcs", 60.00),
                ("Arrozcaldo — Regular", 20.00),
                ("Arrozcaldo — w/ Egg", 40.00),
                ("Lumpia Shanghai — 5 pcs", 65.00),
                ("Burger Solo — w/ Cheese", 65.00),
                ("Tuna Sandwich", 90.00),
                ("Chicken Sandwich", 70.00),
                ("Egg Sandwich", 60.00),
                ("Nachos", 90.00),
                ("Nachofries", 150.00),
                ("Sotanghon w/ Toasted Bread — Single", 90.00),
                ("Sotanghon w/ Toasted Bread — Barkada", 300.00),
                ("Pancit Canton w/ Toasted Bread — Single", 110.00),
                ("Pancit Canton w/ Toasted Bread — Barkada", 350.00),
                ("Spaghetti w/ Burger", 140.00),
                ("Sotanghon Guisado w/ Lumpia Shanghai", 140.00),
            ],
            "Bilao Snacks": [
                ("Bilao 1", 199.00),
                ("Bilao 2", 199.00),
                ("Bilao 3", 249.00),
            ],
            "Non-Alcoholic Drinks": [
                ("Mt. Dew", 25.00),
                ("Sting", 25.00),
                ("Royal", 25.00),
                ("Water", 20.00),
                ("Coke 12 oz", 25.00),
                ("Coke Litro", 50.00),
            ],
            "Alcoholic Drinks": [
                ("Red Horse Litro", 180.00),
                ("Red Horse 500", 90.00),
                ("Red Horse Stallion", 75.00),
                ("San Mig Light", 75.00),
                ("San Mig Apple", 75.00),
                ("Pelsin", 65.00),
                ("Eagle", 60.00),
                ("Tanduay Light", 195.00),
                ("Tanduay Dark", 200.00),
                ("Smirnoff", 80.00),
                ("CLVB", 250.00),
            ],
            "Gen-Z Tower": [
                ("1.5 L — Gin, Ice, Juice", 190.00),
                ("2 L — Gin, Ice, Juice", 220.00),
                ("3 L — Gin, Ice, Juice", 440.00),
                ("1.5 L — Gin, Ice, Juice + Kropek", 220.00),
                ("2 L — Gin, Ice, Juice + 2 Kropek", 380.00),
                ("3 L — Gin, Ice, Juice + 2 Kropek", 500.00),
            ],
            "Add-Ons": [
                ("Kropek", 60.00),
                ("1 Bucket Ice", 15.00),
            ],
            "Milktea w/ Boba Pearls": [
                ("Okinawa — 16 oz", 65.00),
                ("Okinawa — 22 oz", 75.00),
                ("Taro — 16 oz", 65.00),
                ("Taro — 22 oz", 75.00),
                ("Watermelon — 16 oz", 65.00),
                ("Watermelon — 22 oz", 75.00),
                ("Cookies & Cream — 16 oz", 70.00),
                ("Cookies & Cream — 22 oz", 80.00),
                ("Caramelizes Sugar — 16 oz", 65.00),
                ("Caramelizes Sugar — 22 oz", 75.00),
            ],
            "Sticky Milk": [
                ("Buko — 16 oz", 75.00),
                ("Buko — 22 oz", 85.00),
                ("Mango — 16 oz", 75.00),
                ("Mango — 22 oz", 85.00),
                ("Choco — 16 oz", 80.00),
                ("Choco — 22 oz", 90.00),
                ("Melon — 16 oz", 75.00),
                ("Melon — 22 oz", 85.00),
                ("Red Velvet — 16 oz", 85.00),
                ("Red Velvet — 22 oz", 95.00),
            ],
            "Milky Shake Frappe": [
                ("Mango — 16 oz", 80.00),
                ("Mango — 22 oz", 100.00),
                ("Choco — 16 oz", 85.00),
                ("Choco — 22 oz", 105.00),
                ("Caramel Macchiato — 16 oz", 85.00),
                ("Caramel Macchiato — 22 oz", 105.00),
                ("Coffee Crumble — 16 oz", 80.00),
                ("Coffee Crumble — 22 oz", 100.00),
                ("Melon — 16 oz", 80.00),
                ("Melon — 22 oz", 100.00),
                ("Buko — 16 oz", 80.00),
                ("Buko — 22 oz", 100.00),
            ],
            "Cold Coffee": [
                ("Spanish Latte — 16 oz", 50.00),
                ("Spanish Latte — 22 oz", 65.00),
                ("French — 16 oz", 60.00),
                ("French — 22 oz", 75.00),
                ("Salted Caramel — 16 oz", 65.00),
                ("Salted Caramel — 22 oz", 80.00),
                ("Caramel Macchiato — 16 oz", 60.00),
                ("Caramel Macchiato — 22 oz", 75.00),
                ("Iced Americano — 16 oz", 50.00),
                ("Iced Americano — 22 oz", 65.00),
                ("Vietnamese — 16 oz", 55.00),
                ("Vietnamese — 22 oz", 70.00),
                ("Dirty Matcha — 16 oz", 55.00),
                ("Dirty Matcha — 22 oz", 70.00),
                ("Matcha Milk — 16 oz", 55.00),
                ("Matcha Milk — 22 oz", 70.00),
                ("Matcha Latte — 16 oz", 60.00),
                ("Matcha Latte — 22 oz", 75.00),
            ],
            "Hot Coffee": [
                ("Native Coffee", 25.00),
                ("Native with Milk", 35.00),
                ("Barako", 35.00),
                ("Brewed", 30.00),
                ("Americano", 30.00),
                ("Spanish Latte", 45.00),
                ("French Vanilla", 55.00),
                ("Salted Caramel Latte", 60.00),
                ("Caramel Macchiato", 55.00),
                ("Hot Matcha Latte", 50.00),
            ],
            "Unli Samgyupsal": [
                ("Pork", 249.00),
                ("Chicken", 240.00),
                ("Chicken & Pork", 299.00),
                ("Beef", 299.00),
                ("Lettuce (70g)", 50.00),
                ("Cheese (Dipping)", 50.00),
                ("Sesame Oil + Salt", 30.00),
                ("Seaweed", 35.00),
            ]
        }

        from decimal import Decimal
        for cat_name, items in POS_MENU_MASTERLIST.items():
            cat = db.query(models.Category).filter(models.Category.tenant_id == tenant.id, models.Category.name == cat_name).first()
            if not cat:
                cat = models.Category(tenant_id=tenant.id, name=cat_name, description=f"{cat_name} Menu")
                db.add(cat)
                db.flush()
            
            for item_name, price in items:
                prod = db.query(models.Product).filter(models.Product.tenant_id == tenant.id, models.Product.name == item_name).first()
                if not prod:
                    sku_code = f"POS-{abs(hash(item_name)) % 10000:04d}"
                    prod = models.Product(
                        tenant_id=tenant.id,
                        category_id=cat.id,
                        name=item_name,
                        sku=sku_code,
                        price=Decimal(str(price)),
                        cost=Decimal(str(round(price * 0.55, 2))),
                        is_active=True
                    )
                    db.add(prod)
                else:
                    prod.category_id = cat.id
                    prod.price = Decimal(str(price))
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
    logger.info("Initializing database tables on startup...")
    try:
        # Create all tables defined in models.py
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables initialized successfully.")
        
        # Ensure users.role column enum contains all current UserRole values
        try:
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE users MODIFY COLUMN role ENUM('SUPER_ADMIN','ADMIN','MANAGER','CASHIER','INVENTORY','KITCHEN') NOT NULL DEFAULT 'CASHIER'"))
                conn.commit()
        except Exception as err:
            logger.debug(f"Enum alignment check: {err}")

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

# Mount static files directories to serve frontend assets using absolute paths
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
if os.path.exists(os.path.join(STATIC_DIR, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")


# Explicit HTML Page Routes for Roles
@app.get("/", response_class=FileResponse)
@app.get("/login", response_class=FileResponse)
@app.get("/auth/login", response_class=FileResponse)
def get_login_page():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.get("/admin", response_class=FileResponse)
@app.get("/admin.html", response_class=FileResponse)
def get_admin_shell():
    page = os.path.join(STATIC_DIR, "pages", "admin.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "admin.html")
    return FileResponse(page)

@app.get("/manager", response_class=FileResponse)
@app.get("/manager.html", response_class=FileResponse)
def get_manager_shell():
    page = os.path.join(STATIC_DIR, "pages", "manager.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "manager.html")
    return FileResponse(page)

@app.get("/inventory", response_class=FileResponse)
@app.get("/inventory.html", response_class=FileResponse)
def get_inventory_shell():
    page = os.path.join(STATIC_DIR, "pages", "inventory.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "inventory.html")
    return FileResponse(page)

@app.get("/cashier", response_class=FileResponse)
@app.get("/cashier.html", response_class=FileResponse)
def get_cashier_shell():
    page = os.path.join(STATIC_DIR, "pages", "cashier.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "cashier.html")
    return FileResponse(page)

@app.get("/kitchen", response_class=FileResponse)
@app.get("/kitchen.html", response_class=FileResponse)
def get_kitchen_shell():
    page = os.path.join(STATIC_DIR, "pages", "kitchen.html")
    if not os.path.exists(page):
        page = os.path.join(STATIC_DIR, "kitchen.html")
    return FileResponse(page)



@app.get("/dashboard", response_class=FileResponse)
@app.get("/dashboard.html", response_class=FileResponse)
@app.get("/super_admin", response_class=FileResponse)
@app.get("/super_admin.html", response_class=FileResponse)
@app.get("/super_admin/dashboard", response_class=FileResponse)
@app.get("/super_admin/dashboard.html", response_class=FileResponse)
@app.get("/super-admin", response_class=FileResponse)
@app.get("/super-admin/dashboard", response_class=FileResponse)
@app.get("/super-admin/dashboard.html", response_class=FileResponse)
def get_dashboard_page():
    return FileResponse(os.path.join(STATIC_DIR, "super_admin", "dashboard.html"))

@app.get("/users", response_class=FileResponse)
@app.get("/users.html", response_class=FileResponse)
@app.get("/super_admin/users", response_class=FileResponse)
@app.get("/super_admin/users.html", response_class=FileResponse)
@app.get("/super-admin/users", response_class=FileResponse)
@app.get("/super-admin/users.html", response_class=FileResponse)
def get_users_page():
    return FileResponse(os.path.join(STATIC_DIR, "super_admin", "users.html"))

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
def get_create_user_page():
    return FileResponse(os.path.join(STATIC_DIR, "super_admin", "create_user.html"))

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
def get_activity_logs_page():
    return FileResponse(os.path.join(STATIC_DIR, "super_admin", "activity_logs.html"))

@app.get("/reports", response_class=FileResponse)
@app.get("/reports.html", response_class=FileResponse)
@app.get("/super_admin/reports", response_class=FileResponse)
@app.get("/super_admin/reports.html", response_class=FileResponse)
@app.get("/super-admin/reports", response_class=FileResponse)
@app.get("/super-admin/reports.html", response_class=FileResponse)
def get_reports_page():
    return FileResponse(os.path.join(STATIC_DIR, "super_admin", "reports.html"))

@app.get("/profile", response_class=FileResponse)
@app.get("/profile.html", response_class=FileResponse)
@app.get("/super_admin/profile", response_class=FileResponse)
@app.get("/super_admin/profile.html", response_class=FileResponse)
@app.get("/super-admin/profile", response_class=FileResponse)
@app.get("/super-admin/profile.html", response_class=FileResponse)
def get_profile_page():
    return FileResponse(os.path.join(STATIC_DIR, "super_admin", "profile.html"))

@app.get("/settings", response_class=FileResponse)
@app.get("/settings.html", response_class=FileResponse)
@app.get("/super_admin/settings", response_class=FileResponse)
@app.get("/super_admin/settings.html", response_class=FileResponse)
@app.get("/super-admin/settings", response_class=FileResponse)
@app.get("/super-admin/settings.html", response_class=FileResponse)
def get_settings_page():
    return FileResponse(os.path.join(STATIC_DIR, "super_admin", "settings.html"))

@app.get("/admin", response_class=FileResponse)
@app.get("/admin.html", response_class=FileResponse)
@app.get("/admin/dashboard", response_class=FileResponse)
@app.get("/admin/dashboard.html", response_class=FileResponse)
def get_admin_page():
    admin_page = os.path.join(STATIC_DIR, "admin", "admin.html")
    if not os.path.exists(admin_page):
        admin_page = os.path.join(STATIC_DIR, "admin.html")
    return FileResponse(admin_page)

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
