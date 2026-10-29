import os
from datetime import datetime, timedelta, timezone
from typing import Optional
import bcrypt
import jwt

import logging
import secrets

logger = logging.getLogger("pos_security")

APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
IS_PRODUCTION = APP_ENV == "production"
MIN_SECRET_LENGTH = 32


def _load_secret_key() -> str:
    """
    Resolve the JWT signing secret from the environment.
    Production refuses to start without a strong, explicit JWT_SECRET.
    Development falls back to a random per-process secret (sessions reset on restart)
    instead of a hardcoded, forgeable value.
    """
    secret = os.getenv("JWT_SECRET", "").strip()
    if IS_PRODUCTION:
        if len(secret) < MIN_SECRET_LENGTH:
            raise RuntimeError(
                f"JWT_SECRET must be set to a random value of at least {MIN_SECRET_LENGTH} characters when APP_ENV=production."
            )
        return secret
    if len(secret) < MIN_SECRET_LENGTH:
        logger.warning("JWT_SECRET is unset or shorter than %d characters; using a random per-process secret (development only).", MIN_SECRET_LENGTH)
        return secrets.token_urlsafe(48)
    return secret


SECRET_KEY = _load_secret_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))  # default 1 day

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Verify if a plaintext password matches the hashed version using bcrypt.
    We use the native 'bcrypt' library directly to avoid passlib compatibility crashes
    with bcrypt >= 4.0 on Python 3.12/3.13.
    """
    try:
        return bcrypt.checkpw(
            plain_password.encode("utf-8"),
            hashed_password.encode("utf-8")
        )
    except Exception:
        return False

def get_password_hash(password: str) -> str:
    """
    Generate a secure bcrypt hash of a plaintext password.
    We use the native 'bcrypt' library directly to avoid passlib compatibility crashes
    with bcrypt >= 4.0 on Python 3.12/3.13.
    """
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode("utf-8"), salt)
    return hashed.decode("utf-8")

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Create a signed JWT access token with payload claims and an expiration time.
    Standard claims: sub (user_id as string), username, role, and tenant_id.
    """
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    
    # Update encoding data
    to_encode.update({
        "exp": expire,
        "sub": str(data.get("sub"))  # Ensure user ID is converted to string for standard 'sub' format
    })
    
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
