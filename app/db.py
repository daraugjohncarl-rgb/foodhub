import os
import logging
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Setup basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pos_db")

# Load environment variables from .env file
# Try finding .env in the parent directory of this app module
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dotenv_path = os.path.join(base_dir, ".env")
if os.path.exists(dotenv_path):
    load_dotenv(dotenv_path)
else:
    load_dotenv()

DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASS", "") or os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "3307")
DB_NAME = os.getenv("DB_NAME", "inbox_pos")

def check_and_create_db():
    """
    Connect directly to the MySQL server using pymysql and ensure the database exists
    before starting the SQLAlchemy connection pool.
    """
    import pymysql
    try:
        connection = pymysql.connect(
            host=DB_HOST,
            user=DB_USER,
            password=DB_PASSWORD,
            port=int(DB_PORT)
        )
        with connection.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS {DB_NAME}")
        connection.close()
        logger.info(f"Database '{DB_NAME}' verified or created successfully.")
    except Exception as e:
        logger.warning(f"Could not verify or create database '{DB_NAME}' on startup: {e}")

# Check/create the DB before starting the SQLAlchemy connection pool
check_and_create_db()

DATABASE_URL = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

# SQLAlchemy engine config
# pool_pre_ping=True verifies connections before using them, preventing disconnected socket errors
# pool_recycle automatically recycles connections older than 1 hour to prevent timeout issues
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=3600
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
