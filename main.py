import os
import sys

# Ensure sys.path includes the root and fastapi directories
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
FASTAPI_DIR = os.path.join(ROOT_DIR, "fastapi")
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)
if os.path.isdir(FASTAPI_DIR) and FASTAPI_DIR not in sys.path:
    sys.path.insert(0, FASTAPI_DIR)

# Expose the ASGI application instance so 'uvicorn main:app' succeeds on Render/production
from app.main import app

def test_connection():
    """Optional database connectivity test when run directly as a script."""
    from dotenv import load_dotenv
    load_dotenv()
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL is not set in environment or .env file.")
        return
    try:
        import psycopg2
        conn = psycopg2.connect(db_url)
        print("Successfully connected to the database via psycopg2!")
        conn.close()
    except Exception as e:
        print(f"Database connection error: {e}")

if __name__ == "__main__":
    test_connection()
