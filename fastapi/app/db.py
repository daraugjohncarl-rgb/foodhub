import os
import sys
import logging
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

DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASS", "1234") or os.getenv("DB_PASSWORD", "1234")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "inbox_pos")

# Resolve DATABASE_URL (supports Render, Neon, Supabase, Railway, Docker, Localhost)
raw_db_url = os.getenv("DATABASE_URL")

if raw_db_url:
    # Render and Heroku use 'postgres://' which SQLAlchemy 1.4+ deprecated in favor of 'postgresql://'
    if raw_db_url.startswith("postgres://"):
        DATABASE_URL = raw_db_url.replace("postgres://", "postgresql+psycopg://", 1)
    elif raw_db_url.startswith("postgresql://") and not raw_db_url.startswith("postgresql+"):
        DATABASE_URL = raw_db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    else:
        DATABASE_URL = raw_db_url
else:
    DATABASE_URL = f"postgresql+psycopg://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

def check_and_create_db():
    """
    Connect directly to local PostgreSQL server and ensure the database exists
    before starting the SQLAlchemy connection pool.
    Skipped for cloud databases where users lack superuser permissions.
    """
    if raw_db_url or DB_HOST not in ("localhost", "127.0.0.1"):
        return

    import psycopg
    from psycopg import sql
    try:
        conn = psycopg.connect(
            host=DB_HOST,
            user=DB_USER,
            password=DB_PASSWORD,
            port=int(DB_PORT),
            dbname="postgres",
            autocommit=True
        )
        with conn.cursor() as cursor:
            cursor.execute(f"SELECT 1 FROM pg_database WHERE datname = '{DB_NAME}'")
            if not cursor.fetchone():
                cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(DB_NAME)))
        conn.close()
        logger.info(f"Local database '{DB_NAME}' verified or created successfully.")
    except Exception as e:
        logger.warning(f"Could not verify or create database '{DB_NAME}' on startup: {e}")

# Check/create the DB if running locally
check_and_create_db()

# SQLAlchemy engine config
# pool_pre_ping=True verifies connections before using them, preventing disconnected socket errors
# pool_recycle=300 prevents timeouts on managed cloud databases (Render, Neon, Supabase)
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=300
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
