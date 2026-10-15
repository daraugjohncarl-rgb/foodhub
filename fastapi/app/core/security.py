import os
from datetime import timedelta
from typing import Optional

import bcrypt
import jwt

import app.core.env  # noqa: F401  (loads .env)
from app.core.timeutils import utcnow

JWT_SECRET_MIN_LENGTH = 32

# The previous hard-coded fallback key was published in the repository; it must never be accepted again.
_KNOWN_LEAKED_SECRETS = {"super_secret_fallback_key_for_pos_inbox_2026", "change_me", "changeme", "secret"}


def _load_secret_key() -> str:
    secret = os.getenv("JWT_SECRET", "")
    if not secret:
        raise RuntimeError(
            "JWT_SECRET is not set. Generate one with:\n"
            "  python -c \"import secrets; print(secrets.token_urlsafe(48))\"\n"
            "and set it in the environment (or fastapi/.env for local development)."
        )
    if len(secret) < JWT_SECRET_MIN_LENGTH or secret.strip().lower() in _KNOWN_LEAKED_SECRETS:
        raise RuntimeError(
            f"JWT_SECRET is too weak: it must be at least {JWT_SECRET_MIN_LENGTH} random characters "
            "and must not be a known/default value."
        )
    return secret


SECRET_KEY = _load_secret_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "720"))  # 12 hours


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


# A real bcrypt hash used to keep login timing constant when the username does not exist.
DUMMY_PASSWORD_HASH = get_password_hash("dummy-password-for-timing")


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Create a signed JWT access token with payload claims and an expiration time.
    Standard claims: sub (user_id as string), username, role, tenant_id, ver (the user's token_version).
    """
    to_encode = data.copy()
    expire = utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({
        "exp": expire,
        "iat": utcnow(),
        "sub": str(data.get("sub"))  # Ensure user ID is converted to string for standard 'sub' format
    })
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
