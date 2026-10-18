# Expose the FastAPI app instance so ASGI servers running `uvicorn app:app` or `uvicorn app.main:app` succeed
from app.main import app

__all__ = ["app"]
