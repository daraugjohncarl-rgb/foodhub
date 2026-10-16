import os
import sys
import logging
from urllib.parse import quote_plus
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Setup basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pos_db")

# Load environment variables from .env file
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fastapi_env = os.path.join(base_dir, "fastapi", ".env")
root_env = os.path.join(base_dir, ".env")

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

    is_mysql = "mysql" in DATABASE_URL
    is_postgres = "postgres" in DATABASE_URL
    DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
    DB_PORT = os.getenv("DB_PORT", "3306" if is_mysql else "5432")
    DB_USER = os.getenv("DB_USER", "root" if is_mysql else "postgres")
    DB_PASSWORD = os.getenv("DB_PASS") if os.getenv("DB_PASS") is not None else os.getenv("DB_PASSWORD", "")
    DB_NAME = os.getenv("DB_NAME", "pos")
else:
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

check_and_create_db()

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=300
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
