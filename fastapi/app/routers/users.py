from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from typing import List, Optional
from app.db import get_db
import app.models as models
from app.schemas import UserResponse, UserCreate, UserUpdate, PasswordResetRequest
from app.core.security import get_password_hash
from app.core.dependencies import get_current_user

router = APIRouter(
    prefix="/users",
    tags=["Users"]
)

@router.get("/stats")
def get_user_stats(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Get user statistics aggregated for dashboard metric cards.
    Branch Admins only see statistics for operational staff (Manager, Cashier, Inventory, Kitchen).
    """
    if current_user.role != models.UserRole.SUPER_ADMIN:
        base_query = db.query(models.User).filter(
            models.User.tenant_id == current_user.tenant_id,
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.role != models.UserRole.ADMIN,
            models.User.id != current_user.id
        )
        total_admins = 0
        active_admins = 0
        inactive_admins = 0
        
        total_users = base_query.count()
        managers_count = base_query.filter(models.User.role == models.UserRole.MANAGER).count()
        cashiers_count = base_query.filter(models.User.role == models.UserRole.CASHIER).count()
        inventory_count = base_query.filter(models.User.role == models.UserRole.INVENTORY).count()
        kitchen_count = base_query.filter(models.User.role == models.UserRole.KITCHEN).count()
        customers_count = base_query.filter(models.User.role == models.UserRole.CUSTOMER).count()
    else:
        admins_query = db.query(models.User).filter(
            models.User.role == models.UserRole.ADMIN,
            models.User.id != current_user.id
        )
        total_admins = admins_query.count()
        active_admins = admins_query.filter(models.User.is_active == True).count()
        inactive_admins = admins_query.filter(models.User.is_active == False).count()
        
        total_users = db.query(models.User).filter(models.User.id != current_user.id).count()
        managers_count = db.query(models.User).filter(models.User.role == models.UserRole.MANAGER).count()
        cashiers_count = db.query(models.User).filter(models.User.role == models.UserRole.CASHIER).count()
        inventory_count = db.query(models.User).filter(models.User.role == models.UserRole.INVENTORY).count()
        kitchen_count = db.query(models.User).filter(models.User.role == models.UserRole.KITCHEN).count()
        customers_count = db.query(models.User).filter(models.User.role == models.UserRole.CUSTOMER).count()
    
    return {
        "total": total_users,
        "admins": total_admins,
        "active_admins": active_admins,
        "inactive_admins": inactive_admins,
        "managers": managers_count,
        "cashiers": cashiers_count,
        "inventory": inventory_count,
        "kitchen": kitchen_count,
        "customers": customers_count
    }

@router.get("", response_model=List[UserResponse])
def get_users(
    q: Optional[str] = Query(None, description="Search query by name, email, or phone"),
    role: Optional[str] = Query(None, description="Filter by role"),
    status: Optional[str] = Query(None, description="Filter by status ('Active' or 'Inactive')"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    exclude_self: bool = Query(True, description="Exclude the currently logged-in user"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Retrieve list of users with search and filter capabilities.
    Branch Admins only see non-ADMIN and non-SUPER_ADMIN staff in their branch.
    """
    query = db.query(models.User)
    
    # Restrict non-SUPER_ADMIN users to their own tenant and exclude ADMIN & SUPER_ADMIN accounts
    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.User.tenant_id == current_user.tenant_id,
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.role != models.UserRole.ADMIN
        )
    
    if exclude_self:
        query = query.filter(models.User.id != current_user.id)
        
    if role and role.strip():
        # Handle INVENTORY_STAFF / KITCHEN_STAFF mapping
        clean_role = role.replace("_STAFF", "")
        if clean_role in models.UserRole.__members__:
            query = query.filter(models.User.role == models.UserRole[clean_role])
            
    if status and status.strip():
        if status.lower() == "active":
            query = query.filter(models.User.is_active == True)
        elif status.lower() == "inactive":
            query = query.filter(models.User.is_active == False)
            
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
    
    users = query.order_by(models.User.created_at.desc()).offset(offset).limit(limit).all()
    return users

@router.get("/{user_id}", response_model=UserResponse)
def get_user_by_id(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Retrieve a single user by ID.
    """
    query = db.query(models.User).filter(models.User.id == user_id)
    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.User.tenant_id == current_user.tenant_id,
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.role != models.UserRole.ADMIN
        )
    user = query.first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return user

@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    user_in: UserCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Create a new user account.
    Branch Admins can only create operational branch staff (Manager, Cashier, Inventory, Kitchen).
    """
    if current_user.role != models.UserRole.SUPER_ADMIN:
        if user_in.role in [models.UserRole.SUPER_ADMIN, models.UserRole.ADMIN]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Branch Admins cannot create ADMIN or SUPER_ADMIN accounts. Only Manager, Cashier, Inventory, or Kitchen accounts are allowed."
            )
        assigned_tenant_id = current_user.tenant_id
    else:
        if user_in.role != models.UserRole.SUPER_ADMIN and not user_in.tenant_id:
            first_tenant = db.query(models.Tenant).first()
            assigned_tenant_id = first_tenant.id if first_tenant else 1
        else:
            assigned_tenant_id = user_in.tenant_id

    username = user_in.username
    if not username:
        if user_in.first_name and user_in.last_name:
            username = f"{user_in.first_name.lower().strip()}.{user_in.last_name.lower().strip()}"
        elif user_in.email:
            username = user_in.email.split("@")[0]
        else:
            username = f"user_{int(func.now())}"
            
    # Ensure username is unique
    base_username = username
    counter = 1
    while db.query(models.User).filter(models.User.username == username).first():
        username = f"{base_username}{counter}"
        counter += 1
        
    if user_in.email:
        existing_email = db.query(models.User).filter(models.User.email == user_in.email).first()
        if existing_email:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email address already registered."
            )
            
    hashed_password = get_password_hash(user_in.password)
    new_user = models.User(
        username=username,
        first_name=user_in.first_name,
        last_name=user_in.last_name,
        email=user_in.email,
        phone=user_in.phone,
        password_hash=hashed_password,
        role=user_in.role,
        tenant_id=assigned_tenant_id,
        is_active=user_in.is_active if user_in.is_active is not None else True
    )
    db.add(new_user)
    
    # Audit log
    log = models.ActivityLog(
        user_id=current_user.id,
        action="User Created",
        performed_by=current_user.username,
        target_user=new_user.username,
        role=str(new_user.role.value if hasattr(new_user.role, 'value') else new_user.role),
        details=f"Created account for {new_user.email or new_user.username}"
    )
    db.add(log)
    
    db.commit()
    db.refresh(new_user)
    return new_user

@router.put("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: int,
    user_in: UserUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Update an existing user's details.
    """
    query = db.query(models.User).filter(models.User.id == user_id)
    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.User.tenant_id == current_user.tenant_id,
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.role != models.UserRole.ADMIN
        )
    user = query.first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        
    if user_in.username is not None:
        existing = db.query(models.User).filter(models.User.username == user_in.username, models.User.id != user_id).first()
        if existing:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already in use.")
        user.username = user_in.username
        
    if user_in.email is not None:
        existing_email = db.query(models.User).filter(models.User.email == user_in.email, models.User.id != user_id).first()
        if existing_email:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already in use.")
        user.email = user_in.email
        
    if user_in.first_name is not None:
        user.first_name = user_in.first_name
    if user_in.last_name is not None:
        user.last_name = user_in.last_name
    if user_in.phone is not None:
        user.phone = user_in.phone
    if user_in.role is not None:
        if current_user.role != models.UserRole.SUPER_ADMIN and user_in.role in [models.UserRole.SUPER_ADMIN, models.UserRole.ADMIN]:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot assign ADMIN or SUPER_ADMIN role.")
        user.role = user_in.role
    if user_in.is_active is not None:
        user.is_active = user_in.is_active
        
    # Audit log
    log = models.ActivityLog(
        user_id=current_user.id,
        action="User Edited",
        performed_by=current_user.username,
        target_user=user.username,
        role=str(user.role.value if hasattr(user.role, 'value') else user.role),
        details=f"Updated details for {user.username}"
    )
    db.add(log)
    
    db.commit()
    db.refresh(user)
    return user

@router.put("/{user_id}/password")
def reset_user_password(
    user_id: int,
    req: PasswordResetRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Reset a user's password.
    """
    query = db.query(models.User).filter(models.User.id == user_id)
    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.User.tenant_id == current_user.tenant_id,
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.role != models.UserRole.ADMIN
        )
    user = query.first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        
    user.password_hash = get_password_hash(req.new_password)
    
    # Audit log
    log = models.ActivityLog(
        user_id=current_user.id,
        action="Password Reset",
        performed_by=current_user.username,
        target_user=user.username,
        role=str(user.role.value if hasattr(user.role, 'value') else user.role),
        details=f"Reset password for {user.username}"
    )
    db.add(log)
    
    db.commit()
    return {"message": f"Password for {user.username} has been reset successfully."}

@router.put("/{user_id}/status")
def toggle_user_status(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Toggle active / inactive status of a user.
    """
    query = db.query(models.User).filter(models.User.id == user_id)
    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.User.tenant_id == current_user.tenant_id,
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.role != models.UserRole.ADMIN
        )
    user = query.first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        
    user.is_active = not user.is_active
    action_text = "User Activated" if user.is_active else "User Deactivated"
    
    # Audit log
    log = models.ActivityLog(
        user_id=current_user.id,
        action="Status Changed",
        performed_by=current_user.username,
        target_user=user.username,
        role=str(user.role.value if hasattr(user.role, 'value') else user.role),
        details=f"Changed status of {user.username} to {'Active' if user.is_active else 'Inactive'}"
    )
    db.add(log)
    
    db.commit()
    return {"message": f"User status updated to {'Active' if user.is_active else 'Inactive'}.", "is_active": user.is_active}

@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Delete a user account.
    """
    query = db.query(models.User).filter(models.User.id == user_id)
    if current_user.role != models.UserRole.SUPER_ADMIN:
        query = query.filter(
            models.User.tenant_id == current_user.tenant_id,
            models.User.role != models.UserRole.SUPER_ADMIN,
            models.User.role != models.UserRole.ADMIN
        )
    user = query.first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        
    if user.id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account.")
        
    # Audit log
    log = models.ActivityLog(
        user_id=current_user.id,
        action="User Deleted",
        performed_by=current_user.username,
        target_user=user.username,
        role=str(user.role.value if hasattr(user.role, 'value') else user.role),
        details=f"Deleted user account {user.username}"
    )
    db.add(log)
    
    db.delete(user)
    db.commit()
    return None
