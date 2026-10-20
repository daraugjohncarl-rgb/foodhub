from typing import Optional
from fastapi import Request, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
import jwt
from jwt.exceptions import PyJWTError as JWTError
from sqlalchemy.orm import Session
from app.db import get_db
import app.models as models
from app.core.security import SECRET_KEY, ALGORITHM

# Define oauth2 scheme which extracts the bearer token from Authorization header (auto_error=False allows cookie fallback)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)

def get_current_user(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> models.User:
    """
    Dependency function to authenticate requests via either:
    1. HTTP Authorization Bearer header
    2. Secure HttpOnly 'session_token' cookie
    Decodes the JWT token, verifies expiration, integrity, user activity status,
    and single-session token_version.
    Raises 401 Unauthorized exceptions if validation fails or account is deactivated.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    # 1. Resolve token: header takes priority, fallback to secure session cookie
    token_str = token if isinstance(token, str) and token.strip() else None
    auth_token = token_str or request.cookies.get("session_token")
    if not auth_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please sign in.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    try:
        # Decode the token payload
        payload = jwt.decode(auth_token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id_str: str = payload.get("sub")
        if user_id_str is None:
            raise credentials_exception
        user_id = int(user_id_str)
        token_version = payload.get("token_version")
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session has expired. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except (JWTError, ValueError):
        raise credentials_exception
        
    # Look up user in database
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise credentials_exception
        
    # Verify user account is active
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is deactivated."
        )
        
    # Single-session / token version revocation enforcement
    if token_version is not None and getattr(user, "token_version", None) is not None:
        if token_version != user.token_version:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Your session has been revoked or logged into on another device.",
                headers={"WWW-Authenticate": "Bearer"},
            )

    return user


def get_current_user_optional(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> Optional[models.User]:
    """
    Safely retrieves the current authenticated user without raising an exception if unauthenticated.
    Returns None if no session exists or if the session is invalid/expired.
    """
    token_str = token if isinstance(token, str) and token.strip() else None
    auth_token = token_str or request.cookies.get("session_token")
    if not auth_token:
        return None
    try:
        payload = jwt.decode(auth_token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id_str = payload.get("sub")
        if not user_id_str:
            return None
        user_id = int(user_id_str)
        token_version = payload.get("token_version")
        user = db.query(models.User).filter(models.User.id == user_id).first()
        if not user or not user.is_active:
            return None
        if token_version is not None and getattr(user, "token_version", None) is not None:
            if token_version != user.token_version:
                return None
        return user
    except Exception:
        return None


def require_admin(
    current_user: models.User = Depends(get_current_user)
) -> models.User:
    """
    Dependency that restricts access to ADMIN and SUPER_ADMIN roles.
    Raises HTTP 403 for any other role (MANAGER, CASHIER, INVENTORY, KITCHEN).
    """
    allowed = {models.UserRole.ADMIN, models.UserRole.SUPER_ADMIN}
    if current_user.role not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied. Requires ADMIN or SUPER_ADMIN role."
        )
    return current_user


def require_inventory_access(
    current_user: models.User = Depends(get_current_user)
) -> models.User:
    """
    Dependency that allows ADMIN, SUPER_ADMIN, MANAGER, and INVENTORY roles.
    """
    allowed = {models.UserRole.ADMIN, models.UserRole.SUPER_ADMIN, models.UserRole.MANAGER, models.UserRole.INVENTORY}
    if current_user.role not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied. Requires INVENTORY, MANAGER, or ADMIN role."
        )
    return current_user


def require_manager_or_admin(
    current_user: models.User = Depends(get_current_user)
) -> models.User:
    """
    Dependency that allows MANAGER, ADMIN, and SUPER_ADMIN roles.
    """
    allowed = {models.UserRole.ADMIN, models.UserRole.SUPER_ADMIN, models.UserRole.MANAGER}
    if current_user.role not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied. Requires MANAGER, ADMIN or SUPER_ADMIN role."
        )
    return current_user


def get_manager_or_admin_tenant_id(
    current_user: models.User = Depends(require_manager_or_admin),
    db: Session = Depends(get_db)
) -> int:
    """
    Returns tenant_id for manager or admin (defaults to tenant 1 for super admin).
    """
    if current_user.tenant_id:
        return current_user.tenant_id
    first_tenant = db.query(models.Tenant).first()
    return first_tenant.id if first_tenant else 1


def get_admin_tenant_id(
    current_user: models.User = Depends(require_admin)
) -> int:
    """
    Returns the tenant_id for the calling ADMIN user.
    """
    if current_user.tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This endpoint requires a tenant-scoped account."
        )
    return current_user.tenant_id


def get_inventory_tenant_id(
    current_user: models.User = Depends(require_inventory_access),
    db: Session = Depends(get_db)
) -> int:
    """
    Returns tenant_id for inventory operators (defaults to tenant 1 for super admin).
    """
    if current_user.tenant_id:
        return current_user.tenant_id
    first_tenant = db.query(models.Tenant).first()
    return first_tenant.id if first_tenant else 1


def get_user_tenant_id(
    current_user: models.User = Depends(get_current_user)
) -> Optional[int]:
    """
    Returns tenant_id for any authenticated user.
    """
    return current_user.tenant_id

