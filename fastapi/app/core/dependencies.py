from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
import jwt
from jwt.exceptions import PyJWTError as JWTError
from sqlalchemy.orm import Session
from app.db import get_db
import app.models as models
from app.core.security import SECRET_KEY, ALGORITHM

# Define oauth2 scheme which extracts the bearer token from Authorization header
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> models.User:
    """
    Dependency function to authenticate requests. Decodes the JWT token,
    checks expiration/integrity, and returns the User object from the database.
    Raises 401 Unauthorized exceptions if validation fails or account is deactivated.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    try:
        # Decode the token payload
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id_str: str = payload.get("sub")
        if user_id_str is None:
            raise credentials_exception
        user_id = int(user_id_str)
    except (JWTError, ValueError):
        # ValueError handles cases where user_id string cannot be parsed as an integer
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
        
    return user


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

