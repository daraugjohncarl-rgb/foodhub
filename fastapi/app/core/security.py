import os
from datetime import datetime, timedelta, timezone
from typing import Optional
import bcrypt
from jose import jwt

# JWT authentication configuration parameters
# Defaults to a secure fallback token in development environments
SECRET_KEY = os.getenv("JWT_SECRET", "super_secret_fallback_key_for_pos_inbox_2026")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 720  # 12 hours (720 minutes)

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
