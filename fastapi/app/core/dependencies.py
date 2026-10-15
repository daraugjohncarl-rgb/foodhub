from typing import Callable, Optional

from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import OAuth2PasswordBearer
import jwt
from jwt.exceptions import PyJWTError as JWTError
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
from app.core.permissions import has_permission
from app.core.security import SECRET_KEY, ALGORITHM

# Define oauth2 scheme which extracts the bearer token from Authorization header
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

# Endpoints a user who must change their (default) password may still call.
PASSWORD_CHANGE_ALLOWED_PATHS = {"/api/v1/auth/me", "/api/v1/auth/change-password"}


def get_current_user(
    request: Request,
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    """
    Authenticates the bearer token and returns the active user.
    Rejects expired/forged tokens, tokens issued before the user's last password change or deactivation
    (token_version), and - for accounts flagged must_change_password - everything but the password-change flow.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM], options={"require": ["exp", "sub"]})
        user_id = int(payload.get("sub"))
        token_version = int(payload.get("ver", -1))
    except (JWTError, ValueError, TypeError):
        raise credentials_exception

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None or token_version != (user.token_version or 0):
        raise credentials_exception
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User account is deactivated.")
    if user.must_change_password and request.url.path not in PASSWORD_CHANGE_ALLOWED_PATHS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password change required before using the system.",
            headers={"X-Password-Change-Required": "1"},
        )
    return user


def require_permission(permission: str) -> Callable[..., models.User]:
    """Dependency factory: the caller must hold `permission` (see app/core/permissions.py)."""

    def _dependency(current_user: models.User = Depends(get_current_user)) -> models.User:
        if not has_permission(current_user.role, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have permission to perform this action.",
            )
        return current_user

    _dependency.__name__ = f"require_{permission.replace('.', '_')}"
    return _dependency


def require_roles(*roles: models.UserRole) -> Callable[..., models.User]:
    allowed = set(roles)

    def _dependency(current_user: models.User = Depends(get_current_user)) -> models.User:
        if current_user.role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to perform this action.")
        return current_user

    return _dependency


def resolve_tenant_id(db: Session, current_user: models.User, requested_tenant_id: Optional[int] = None) -> int:
    """
    The tenant a request operates on.
      * Branch users: always their own tenant. Asking for another tenant is refused (403).
      * SUPER_ADMIN: the requested tenant (?tenant_id=) or, when none is given, the first active tenant.
    """
    if current_user.role != models.UserRole.SUPER_ADMIN:
        if current_user.tenant_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is not assigned to a branch.")
        if requested_tenant_id is not None and requested_tenant_id != current_user.tenant_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access to another branch is not allowed.")
        return current_user.tenant_id

    q = db.query(models.Tenant)
    if requested_tenant_id is not None:
        tenant = q.filter(models.Tenant.id == requested_tenant_id).first()
        if tenant is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Branch not found.")
        return tenant.id
    tenant = q.filter(models.Tenant.is_active.is_(True)).order_by(models.Tenant.id).first()
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No branch exists yet.")
    return tenant.id


def get_tenant_scope(
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to act on"),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> int:
    return resolve_tenant_id(db, current_user, tenant_id)


# ── Backwards-compatible names used by the routers ──────────────────────────
require_admin = require_permission("users.write")
require_inventory_access = require_permission("inventory.write")


def get_admin_tenant_id(
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to act on"),
    current_user: models.User = Depends(require_permission("catalog.write")),
    db: Session = Depends(get_db),
) -> int:
    return resolve_tenant_id(db, current_user, tenant_id)


def get_inventory_tenant_id(
    tenant_id: Optional[int] = Query(None, description="SUPER_ADMIN only: branch to act on"),
    current_user: models.User = Depends(require_permission("inventory.write")),
    db: Session = Depends(get_db),
) -> int:
    return resolve_tenant_id(db, current_user, tenant_id)


def get_user_tenant_id(current_user: models.User = Depends(get_current_user)) -> Optional[int]:
    return current_user.tenant_id
