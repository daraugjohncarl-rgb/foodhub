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
    # A token without a matching token_version is treated as revoked.
    if token_version is None or token_version != (user.token_version or 0):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session has been revoked or logged into on another device.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Remembered so tenant resolution (SUPER_ADMIN only) can honour X-Tenant-ID without every
    # handler having to pass the request along.
    user.requested_tenant_header = request.headers.get("X-Tenant-ID")
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
    user = authenticate_token(auth_token, db)
    if user is not None:
        user.requested_tenant_header = request.headers.get("X-Tenant-ID")
    return user


def authenticate_token(auth_token: str, db: Session) -> Optional[models.User]:
    """
    Validate a raw JWT and return its active, non-revoked user, or None.
    Shared by the optional-auth dependency and the WebSocket handshake.
    """
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
        if token_version is None or token_version != (user.token_version or 0):
            return None
        return user
    except Exception:
        return None


def _role_guard(allowed: set, message: str):
    """Build a dependency that only lets the given roles through (403 otherwise)."""
    def dependency(current_user: models.User = Depends(get_current_user)) -> models.User:
        if current_user.role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=message)
        return current_user
    return dependency


_R = models.UserRole

# Baseline for every staff API: any authenticated, non-customer account.
require_staff = _role_guard(
    {_R.SUPER_ADMIN, _R.ADMIN, _R.MANAGER, _R.CASHIER, _R.INVENTORY, _R.KITCHEN},
    "Access denied. Staff account required.",
)

require_admin = _role_guard(
    {_R.ADMIN, _R.SUPER_ADMIN},
    "Access denied. Requires ADMIN or SUPER_ADMIN role.",
)

require_inventory_access = _role_guard(
    {_R.ADMIN, _R.SUPER_ADMIN, _R.MANAGER, _R.INVENTORY},
    "Access denied. Requires INVENTORY, MANAGER, or ADMIN role.",
)

require_manager_or_admin = _role_guard(
    {_R.ADMIN, _R.SUPER_ADMIN, _R.MANAGER},
    "Access denied. Requires MANAGER, ADMIN or SUPER_ADMIN role.",
)

# Point-of-sale operations: sales, shifts, drawer, incoming customer orders.
require_pos_access = _role_guard(
    {_R.ADMIN, _R.SUPER_ADMIN, _R.MANAGER, _R.CASHIER},
    "Access denied. Requires CASHIER, MANAGER, or ADMIN role.",
)

# Kitchen display / drinks counter: kitchen staff plus the cashier and management.
require_kitchen_access = _role_guard(
    {_R.ADMIN, _R.SUPER_ADMIN, _R.MANAGER, _R.CASHIER, _R.KITCHEN},
    "Access denied. Requires KITCHEN, CASHIER, MANAGER, or ADMIN role.",
)

# Product/menu browsing needed by POS, kitchen, inventory and management screens.
require_menu_read = _role_guard(
    {_R.ADMIN, _R.SUPER_ADMIN, _R.MANAGER, _R.CASHIER, _R.INVENTORY, _R.KITCHEN},
    "Access denied. Staff account required.",
)


def resolve_tenant_id(user: models.User, db: Session, request: Optional[Request] = None) -> int:
    """
    Resolve the tenant a request operates on, from the verified identity only.

    - Tenant-scoped users always get their own tenant. A client-supplied tenant is ignored.
    - SUPER_ADMIN has no tenant. They must pick one explicitly with the X-Tenant-ID header.
      If they do not, the request only succeeds when exactly one tenant exists (unambiguous);
      otherwise it is rejected with 400 instead of silently choosing a tenant.
    """
    if user.tenant_id:
        return user.tenant_id
    if user.role != models.UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is not assigned to a tenant.")

    requested = request.headers.get("X-Tenant-ID") if request is not None else getattr(user, "requested_tenant_header", None)
    if requested:
        try:
            requested_id = int(requested)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid X-Tenant-ID header.")
        if not db.query(models.Tenant.id).filter(models.Tenant.id == requested_id).first():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found.")
        return requested_id

    tenant_ids = [row[0] for row in db.query(models.Tenant.id).limit(2).all()]
    if len(tenant_ids) == 1:
        return tenant_ids[0]
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Tenant selection required. Send the X-Tenant-ID header.",
    )


def get_manager_or_admin_tenant_id(
    request: Request,
    current_user: models.User = Depends(require_manager_or_admin),
    db: Session = Depends(get_db)
) -> int:
    return resolve_tenant_id(current_user, db, request)


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
    request: Request,
    current_user: models.User = Depends(require_inventory_access),
    db: Session = Depends(get_db)
) -> int:
    return resolve_tenant_id(current_user, db, request)


def get_staff_tenant_id(
    request: Request,
    current_user: models.User = Depends(require_staff),
    db: Session = Depends(get_db)
) -> int:
    return resolve_tenant_id(current_user, db, request)


def get_user_tenant_id(
    current_user: models.User = Depends(get_current_user)
) -> Optional[int]:
    """
    Returns tenant_id for any authenticated user.
    """
    return current_user.tenant_id
