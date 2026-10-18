import os
import sys
import logging
from urllib.parse import quote_plus, urlparse
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Ensure sys.path includes the fastapi directory
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

# Setup basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pos_db")

# Load environment variables from .env file (checks fastapi/.env first, then workspace root .env)
fastapi_env = os.path.join(parent_dir, ".env")
root_env = os.path.join(os.path.dirname(parent_dir), ".env")

if os.path.exists(fastapi_env):
    load_dotenv(fastapi_env)
if os.path.exists(root_env):
    load_dotenv(root_env)
load_dotenv()

# Determine DB Engine (defaulting to MySQL for phpMyAdmin / XAMPP, or PostgreSQL if specified)
db_engine_type = os.getenv("DB_ENGINE", "").lower()
raw_db_url = os.getenv("DATABASE_URL")

# Resolve DB configuration
if raw_db_url:
    if raw_db_url.startswith("postgres://"):
        DATABASE_URL = raw_db_url.replace("postgres://", "postgresql+psycopg://", 1)
    elif raw_db_url.startswith("postgresql://") and not raw_db_url.startswith("postgresql+"):
        DATABASE_URL = raw_db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    elif raw_db_url.startswith("mysql://") and not raw_db_url.startswith("mysql+"):
        DATABASE_URL = raw_db_url.replace("mysql://", "mysql+pymysql://", 1)
    else:
        DATABASE_URL = raw_db_url

    parsed = urlparse(raw_db_url.replace("postgresql+psycopg://", "postgresql://").replace("mysql+pymysql://", "mysql://"))
    is_mysql = "mysql" in DATABASE_URL
    is_postgres = "postgres" in DATABASE_URL
    DB_HOST = parsed.hostname or os.getenv("DB_HOST", "127.0.0.1")
    DB_PORT = str(parsed.port or (3306 if is_mysql else 5432))
    DB_USER = parsed.username or os.getenv("DB_USER", "root" if is_mysql else "postgres")
    DB_PASSWORD = parsed.password if parsed.password is not None else (os.getenv("DB_PASS") if os.getenv("DB_PASS") is not None else os.getenv("DB_PASSWORD", ""))
    DB_NAME = (parsed.path.lstrip("/") if parsed.path else "") or os.getenv("DB_NAME", "pos")
else:
    # Check if configured for postgres or mysql
    if db_engine_type in ("postgres", "postgresql") or os.getenv("DB_PORT") == "5432":
        is_postgres = True
        is_mysql = False
        DB_USER = os.getenv("DB_USER", "postgres")
        DB_PASSWORD = os.getenv("DB_PASS", "1234") or os.getenv("DB_PASSWORD", "1234")
        DB_HOST = os.getenv("DB_HOST", "localhost")
        DB_PORT = os.getenv("DB_PORT", "5432")
        DB_NAME = os.getenv("DB_NAME", "pos")
        DATABASE_URL = f"postgresql+psycopg://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    else:
        # Default to MySQL (phpMyAdmin)
        is_mysql = True
        is_postgres = False
        DB_USER = os.getenv("DB_USER", "root")
        DB_PASSWORD = os.getenv("DB_PASS") if os.getenv("DB_PASS") is not None else os.getenv("DB_PASSWORD", "")
        DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
        DB_PORT = os.getenv("DB_PORT", "3306")
        DB_NAME = os.getenv("DB_NAME", "pos")
        auth = f"{DB_USER}:{quote_plus(DB_PASSWORD)}" if DB_PASSWORD else f"{DB_USER}"
        DATABASE_URL = f"mysql+pymysql://{auth}@{DB_HOST}:{DB_PORT}/{DB_NAME}?charset=utf8mb4"

def check_and_create_db():
    """
    Connect directly to local database server and ensure the target database exists
    before starting the SQLAlchemy connection pool.
    Skipped for remote cloud databases.
    """
    if DB_HOST not in ("localhost", "127.0.0.1"):
        return

    if is_mysql:
        try:
            import pymysql
            conn = pymysql.connect(
                host=DB_HOST,
                user=DB_USER,
                password=DB_PASSWORD,
                port=int(DB_PORT),
                connect_timeout=3,
                autocommit=True
            )
            with conn.cursor() as cursor:
                cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            conn.close()
            logger.info(f"Local MySQL database '{DB_NAME}' verified or created successfully.")
        except Exception as e:
            logger.warning(f"Could not verify or create MySQL database '{DB_NAME}' on startup: {e}")

    elif is_postgres:
        try:
            import psycopg
            from psycopg import sql
            conn = psycopg.connect(
                host=DB_HOST,
                user=DB_USER,
                password=DB_PASSWORD,
                port=int(DB_PORT),
                dbname="postgres",
                connect_timeout=3,
                autocommit=True
            )
            with conn.cursor() as cursor:
                cursor.execute(f"SELECT 1 FROM pg_database WHERE datname = '{DB_NAME}'")
                if not cursor.fetchone():
                    cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(DB_NAME)))
            conn.close()
            logger.info(f"Local PostgreSQL database '{DB_NAME}' verified or created successfully.")
        except Exception as e:
            logger.warning(f"Could not verify or create PostgreSQL database '{DB_NAME}' on startup: {e}")

# Check/create the DB if running locally
check_and_create_db()

# SQLAlchemy engine config
# pool_pre_ping=True verifies connections before using them, preventing disconnected socket errors
# pool_recycle=300 prevents timeouts on persistent connections
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=300,
    pool_size=15,
    max_overflow=20,
    pool_timeout=30
)

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Declarative base for ORM models
Base = declarative_base()

def get_db():
    """
    Dependency generator for FastAPI endpoints to get a DB session.
    Ensures that the connection is properly closed when the request is done.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
