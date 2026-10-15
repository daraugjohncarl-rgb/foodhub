"""
Loads .env files exactly once, before any configuration is read.

Order: fastapi/.env, then the repository-root .env. Values already present in the process environment always win,
so a deployment platform (Render, Docker) or a test runner can never be overridden by a stray local .env file.
Set INBOX_POS_SKIP_DOTENV=1 to ignore .env files entirely (the test suite does this).
"""
import os

from dotenv import load_dotenv

_APP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # .../fastapi

if os.getenv("INBOX_POS_SKIP_DOTENV") != "1":
    for _path in (os.path.join(_APP_DIR, ".env"), os.path.join(os.path.dirname(_APP_DIR), ".env")):
        if os.path.exists(_path):
            load_dotenv(_path, override=False)
