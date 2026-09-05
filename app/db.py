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

DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not configured. Please set it in your .env file.")

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
