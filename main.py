# Expose the Blessie FoodHub POS FastAPI app instance for ASGI servers running `uvicorn main:app`
from app.main import app

__all__ = ["app"]
