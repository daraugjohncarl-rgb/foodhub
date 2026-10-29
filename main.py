# ASGI entry point for `uvicorn main:app` run from the repository root.
# The deployed application lives in fastapi/ (see docs/DEPLOYMENT.md).
import os
import sys

_FASTAPI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fastapi")
if _FASTAPI_DIR not in sys.path:
    sys.path.insert(0, _FASTAPI_DIR)

from app.main import app

__all__ = ["app"]
