import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
from app.schemas import UserResponse, UserCreate, UserUpdate, PasswordResetRequest
from app.core import audit
from app.core.security import get_password_hash
from app.core.dependencies import require_permission

router = APIRouter(
    prefix="/users",
    tags=["Users"]
)

# Read: SUPER_ADMIN, ADMIN, MANAGER (read-only). Write: SUPER_ADMIN, ADMIN. (app/core/permissions.py)
can_read_users = require_permission("users.read")
can_write_users = require_permission("users.write")

BRANCH_STAFF_ROLES = (
    models.UserRole.MANAGER, models.UserRole.CASHIER, models.UserRole.INVENTORY, models.UserRole.KITCHEN,
)


def _visible_users(db: Session, current_user: models.User):
    """SUPER_ADMIN sees every account; branch admins/managers see only their branch's operational staff."""
    query = db.query(models.User)
    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.User.tenant_id == current_user.tenant_id,
            models.User.role.in_(BRANCH_STAFF_ROLES),
        )
    return query


def _get_visible_user(db: Session, current_user: models.User, user_id: int) -> models.User:
    user = _visible_users(db, current_user).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return user


def _assert_assignable_role(current_user: models.User, role: models.UserRole) -> None:
    if current_user.role != models.UserRole.SUPER_ADMIN and role not in BRANCH_STAFF_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Branch Admins can only manage Manager, Cashier, Inventory or Kitchen accounts.",
        )


def _username_taken(db: Session, username: str, exclude_id: Optional[int] = None) -> bool:
    q = db.query(models.User.id).filter(func.lower(models.User.username) == username.lower())
    if exclude_id is not None:
        q = q.filter(models.User.id != exclude_id)
    return q.first() is not None


@router.get("/stats")
def get_user_stats(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_users),
):
    """
    Get user statistics aggregated for dashboard metric cards.
    Branch Admins and Managers only see statistics for their branch's operational staff.
    """
    if current_user.role != models.UserRole.SUPER_ADMIN:
        base_query = _visible_users(db, current_user).filter(models.User.id != current_user.id)
        total_admins = active_admins = inactive_admins = 0
        total_users = base_query.count()
        managers_count = base_query.filter(models.User.role == models.UserRole.MANAGER).count()
        cashiers_count = base_query.filter(models.User.role == models.UserRole.CASHIER).count()
        inventory_count = base_query.filter(models.User.role == models.UserRole.INVENTORY).count()
        kitchen_count = base_query.filter(models.User.role == models.UserRole.KITCHEN).count()
    else:
        admins_query = db.query(models.User).filter(
            models.User.role == models.UserRole.ADMIN,
            models.User.id != current_user.id
        )
        total_admins = admins_query.count()
        active_admins = admins_query.filter(models.User.is_active.is_(True)).count()
        inactive_admins = admins_query.filter(models.User.is_active.is_(False)).count()

        total_users = db.query(models.User).filter(models.User.id != current_user.id).count()
        managers_count = db.query(models.User).filter(models.User.role == models.UserRole.MANAGER).count()
        cashiers_count = db.query(models.User).filter(models.User.role == models.UserRole.CASHIER).count()
        inventory_count = db.query(models.User).filter(models.User.role == models.UserRole.INVENTORY).count()
        kitchen_count = db.query(models.User).filter(models.User.role == models.UserRole.KITCHEN).count()

    return {
        "total": total_users,
        "admins": total_admins,
        "active_admins": active_admins,
        "inactive_admins": inactive_admins,
        "managers": managers_count,
        "cashiers": cashiers_count,
        "inventory": inventory_count,
        "kitchen": kitchen_count
    }


@router.get("", response_model=List[UserResponse])
def get_users(
    q: Optional[str] = Query(None, max_length=100, description="Search query by name, email, or phone"),
    role: Optional[str] = Query(None, description="Filter by role"),
    status: Optional[str] = Query(None, description="Filter by status ('Active' or 'Inactive')"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    exclude_self: bool = Query(True, description="Exclude the currently logged-in user"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_users),
):
    """
    Retrieve list of users with search and filter capabilities.
    Branch Admins and Managers only see non-ADMIN and non-SUPER_ADMIN staff in their branch.
    """
    query = _visible_users(db, current_user)

    if exclude_self:
        query = query.filter(models.User.id != current_user.id)

    if role and role.strip():
        # Handle INVENTORY_STAFF / KITCHEN_STAFF mapping
        clean_role = role.strip().upper().replace("_STAFF", "")
        if clean_role in models.UserRole.__members__:
            query = query.filter(models.User.role == models.UserRole[clean_role])

    if status and status.strip():
        if status.lower() == "active":
            query = query.filter(models.User.is_active.is_(True))
        elif status.lower() == "inactive":
            query = query.filter(models.User.is_active.is_(False))

    if q and q.strip():
        search_pattern = f"%{q.strip()}%"
        query = query.filter(
            or_(
                models.User.username.ilike(search_pattern),
                models.User.first_name.ilike(search_pattern),
                models.User.last_name.ilike(search_pattern),
                models.User.email.ilike(search_pattern),
                models.User.phone.ilike(search_pattern)
            )
        )

    return query.order_by(models.User.created_at.desc()).offset(offset).limit(limit).all()


@router.get("/{user_id}", response_model=UserResponse)
def get_user_by_id(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_read_users),
):
    return _get_visible_user(db, current_user, user_id)


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    user_in: UserCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_users),
):
    """
    Create a new user account.
    Branch Admins can only create operational branch staff (Manager, Cashier, Inventory, Kitchen) in their branch.
    """
    _assert_assignable_role(current_user, user_in.role)

    if current_user.role != models.UserRole.SUPER_ADMIN:
        assigned_tenant_id = current_user.tenant_id
    elif user_in.role == models.UserRole.SUPER_ADMIN:
        assigned_tenant_id = None
    else:
        if user_in.tenant_id is not None:
            tenant = db.query(models.Tenant).filter(models.Tenant.id == user_in.tenant_id).first()
            if tenant is None:
                raise HTTPException(status_code=422, detail="Branch (tenant_id) does not exist.")
        else:
            tenant = db.query(models.Tenant).order_by(models.Tenant.id).first()
            if tenant is None:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No branch exists yet.")
        assigned_tenant_id = tenant.id

    username = user_in.username
    if not username:
        if user_in.first_name and user_in.last_name:
            username = f"{user_in.first_name}.{user_in.last_name}".lower().replace(" ", "")
        elif user_in.email:
            username = str(user_in.email).split("@")[0].lower()
        else:
            username = f"user_{uuid.uuid4().hex[:8]}"
        username = "".join(ch for ch in username if ch.isalnum() or ch in "._@+-")[:44] or f"user_{uuid.uuid4().hex[:8]}"

    # Ensure username is unique (case-insensitive)
    base_username = username
    counter = 1
    while _username_taken(db, username):
        username = f"{base_username}{counter}"
        counter += 1

    if user_in.email and db.query(models.User.id).filter(models.User.email == str(user_in.email)).first():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email address already registered."
        )

    new_user = models.User(
        username=username,
        first_name=user_in.first_name,
        last_name=user_in.last_name,
        email=str(user_in.email) if user_in.email else None,
        phone=user_in.phone,
        password_hash=get_password_hash(user_in.password),
        role=user_in.role,
        tenant_id=assigned_tenant_id,
        is_active=user_in.is_active if user_in.is_active is not None else True,
        must_change_password=True,   # the person who set this password is not the account owner
    )
    db.add(new_user)
    audit.record(
        db, current_user, "User Created", target_user=username, tenant_id=assigned_tenant_id,
        details=f"Created {audit.role_name(user_in.role)} account {username}",
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username or email already in use.")
    db.refresh(new_user)
    return new_user


@router.put("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: int,
    user_in: UserUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_users),
):
    """
    Update an existing user's details.
    """
    user = _get_visible_user(db, current_user, user_id)
    changes = user_in.model_dump(exclude_unset=True)

    if "username" in changes:
        if _username_taken(db, changes["username"], exclude_id=user_id):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already in use.")
        user.username = changes["username"]

    if "email" in changes:
        email = str(changes["email"]) if changes["email"] else None
        if email and db.query(models.User.id).filter(models.User.email == email, models.User.id != user_id).first():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already in use.")
        user.email = email

    for field in ("first_name", "last_name", "phone"):
        if field in changes:
            setattr(user, field, changes[field])

    if "role" in changes:
        _assert_assignable_role(current_user, changes["role"])
        if user.id == current_user.id and changes["role"] != current_user.role:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot change your own role.")
        user.role = changes["role"]

    if "is_active" in changes and changes["is_active"] != user.is_active:
        if user.id == current_user.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot deactivate your own account.")
        user.is_active = changes["is_active"]
        if not user.is_active:
            user.token_version = (user.token_version or 0) + 1

    audit.record(db, current_user, "User Edited", target_user=user.username, tenant_id=user.tenant_id,
                 details=f"Updated details for {user.username}")
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username or email already in use.")
    db.refresh(user)
    return user


@router.put("/{user_id}/password")
def reset_user_password(
    user_id: int,
    req: PasswordResetRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_users),
):
    """
    Reset another user's password. Their existing sessions end and they must choose a new password at next login.
    """
    user = _get_visible_user(db, current_user, user_id)
    user.password_hash = get_password_hash(req.new_password)
    user.token_version = (user.token_version or 0) + 1
    user.must_change_password = user.id != current_user.id
    user.failed_login_attempts = 0
    user.locked_until = None
    audit.record(db, current_user, "Password Reset", target_user=user.username, tenant_id=user.tenant_id,
                 details=f"Reset password for {user.username}")
    db.commit()
    return {"message": f"Password for {user.username} has been reset successfully."}


@router.put("/{user_id}/status")
def toggle_user_status(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_users),
):
    """
    Toggle active / inactive status of a user. Deactivation is the normal way to remove staff: their sales and
    shift history stay attributed to them.
    """
    user = _get_visible_user(db, current_user, user_id)
    if user.id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot deactivate your own account.")

    user.is_active = not user.is_active
    if not user.is_active:
        user.token_version = (user.token_version or 0) + 1   # end their sessions immediately
    audit.record(
        db, current_user, "Status Changed", target_user=user.username, tenant_id=user.tenant_id,
        details=f"Changed status of {user.username} to {'Active' if user.is_active else 'Inactive'}",
    )
    db.commit()
    return {"message": f"User status updated to {'Active' if user.is_active else 'Inactive'}.", "is_active": user.is_active}


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(can_write_users),
):
    """
    Permanently delete an account that has no history. Accounts with sales, shifts or cash movements cannot be
    deleted (409); deactivate them instead so financial records keep their attribution.
    """
    user = _get_visible_user(db, current_user, user_id)
    if user.id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account.")

    has_history = any(
        db.query(model.id).filter(model.user_id == user.id).first() is not None
        for model in (models.Transaction, models.Shift, models.ShiftCashMovement)
    )
    if has_history:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account has sales or shift history and cannot be deleted. Deactivate it instead.",
        )

    audit.record(db, current_user, "User Deleted", target_user=user.username, tenant_id=user.tenant_id,
                 details=f"Deleted user account {user.username}")
    db.delete(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account is referenced by other records and cannot be deleted. Deactivate it instead.",
        )
    return None
