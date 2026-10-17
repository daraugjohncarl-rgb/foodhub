from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from app.db import get_db
import app.models as models
from app.schemas import UserResponse
from app.core.security import verify_password, create_access_token
from app.core.dependencies import get_current_user

router = APIRouter(
    prefix="/auth",
    tags=["Authentication"]
)

@router.post("/login")
def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    """
    Authenticate a user using OAuth2 Username & Password.
    Returns access token along with user role, tenant_id, and username.
    """
    # Look up user by username or email
    user = db.query(models.User).filter(
        (models.User.username == form_data.username) | (models.User.email == form_data.username)
    ).first()
    
    # Verify username and password hash match
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )
        
    # Verify the user account is active
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your account is deactivated.",
            headers={"WWW-Authenticate": "Bearer"},
        )
        
    # Enforce single-device login: increment token_version to invalidate any previous device sessions
    user.token_version = (user.token_version or 0) + 1
    db.commit()
    db.refresh(user)

    # Construct JWT token payload
    # Ensure role is converted to its string representation
    role_str = user.role.value if hasattr(user.role, "value") else str(user.role)
    token_payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": role_str,
        "tenant_id": user.tenant_id,
        "token_version": user.token_version
    }
    
    # Generate the access token (valid for exactly 1 day / 24 hours)
    access_token = create_access_token(data=token_payload, expires_delta=timedelta(days=1))
    
    # Audit log: record login event
    try:
        log = models.ActivityLog(
            user_id=user.id,
            action="Login",
            performed_by=user.username,
            target_user=user.username,
            role=role_str,
            details=f"User '{user.username}' logged in successfully."
        )
        db.add(log)
        db.commit()
    except Exception:
        pass  # Never block login due to log failure
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "role": user.role,
        "tenant_id": user.tenant_id,
        "username": user.username
    }

from app.schemas import UserResponse, UserUpdate, PasswordChangeRequest, CustomerRegisterRequest
from app.core.security import verify_password, create_access_token, get_password_hash
from sqlalchemy import func

@router.post("/customer-register", status_code=status.HTTP_201_CREATED, summary="Create a new Customer account")
@router.post("/register", status_code=status.HTTP_201_CREATED, summary="Register a customer account")
def register_customer(
    body: CustomerRegisterRequest,
    db: Session = Depends(get_db)
):
    """
    Allows a customer to create a customer account.
    Returns immediate JWT access token and user info so they are logged in instantly.
    """
    clean_username = body.username.strip()
    if len(clean_username) < 3:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username must be at least 3 characters long."
        )

    # Check username uniqueness
    existing_user = db.query(models.User).filter(
        func.lower(models.User.username) == clean_username.lower()
    ).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Username '{clean_username}' is already taken. Please choose another username."
        )

    # Check email uniqueness if provided
    clean_email = body.email.strip().lower() if body.email and body.email.strip() else None
    if clean_email:
        existing_email = db.query(models.User).filter(
            func.lower(models.User.email) == clean_email
        ).first()
        if existing_email:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Email '{clean_email}' is already registered."
            )

    # Determine tenant
    tenant_id = body.tenant_id
    if not tenant_id:
        first_tenant = db.query(models.Tenant).first()
        tenant_id = first_tenant.id if first_tenant else 1

    hashed_pw = get_password_hash(body.password)

    new_user = models.User(
        tenant_id=tenant_id,
        username=clean_username,
        first_name=body.first_name.strip() if body.first_name else None,
        last_name=body.last_name.strip() if body.last_name else None,
        email=clean_email,
        phone=body.phone.strip() if body.phone else None,
        password_hash=hashed_pw,
        role=models.UserRole.CUSTOMER,
        is_active=True
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    # Build customer display name
    name_parts = [p for p in [new_user.first_name, new_user.last_name] if p]
    display_name = " ".join(name_parts) if name_parts else new_user.username

    # Generate access token so customer is logged in immediately
    token_payload = {
        "sub": str(new_user.id),
        "username": new_user.username,
        "role": "CUSTOMER",
        "tenant_id": new_user.tenant_id,
        "token_version": new_user.token_version or 0
    }
    # Generate access token so customer is logged in immediately (valid for 1 day / 24 hours)
    access_token = create_access_token(data=token_payload, expires_delta=timedelta(days=1))

    return {
        "success": True,
        "message": f"Welcome, {display_name}! Customer account created successfully.",
        "access_token": access_token,
        "token_type": "bearer",
        "role": "CUSTOMER",
        "tenant_id": new_user.tenant_id,
        "username": new_user.username,
        "customer_name": display_name
    }

@router.get("/me", response_model=UserResponse)
def read_users_me(current_user: models.User = Depends(get_current_user)):
    """
    Retrieve details of the currently authenticated active user.
    """
    return current_user

@router.put("/me", response_model=UserResponse)
def update_users_me(
    user_in: UserUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Update profile details for the currently authenticated user.
    """
    if user_in.username is not None:
        # Check uniqueness if username changed
        existing = db.query(models.User).filter(models.User.username == user_in.username, models.User.id != current_user.id).first()
        if existing:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already in use.")
        current_user.username = user_in.username
        
    if user_in.email is not None:
        existing_email = db.query(models.User).filter(models.User.email == user_in.email, models.User.id != current_user.id).first()
        if existing_email:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already in use.")
        current_user.email = user_in.email
        
    if user_in.first_name is not None:
        current_user.first_name = user_in.first_name
    if user_in.last_name is not None:
        current_user.last_name = user_in.last_name
    if user_in.phone is not None:
        current_user.phone = user_in.phone
        
    db.commit()
    db.refresh(current_user)
    
    # Audit log: profile updated
    try:
        log = models.ActivityLog(
            tenant_id=current_user.tenant_id,
            user_id=current_user.id,
            action="Profile Updated",
            performed_by=current_user.username,
            target_user=current_user.username,
            role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
            details=f"Profile details updated for {current_user.username}"
        )
        db.add(log)
        db.commit()
    except Exception:
        pass
    
    return current_user

@router.put("/change-password")
def change_password(
    req: PasswordChangeRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Change password for the currently authenticated user.
    """
    if not verify_password(req.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password does not match."
        )
        
    current_user.password_hash = get_password_hash(req.new_password)
    db.commit()
    
    # Audit log: password change by self
    try:
        log = models.ActivityLog(
            tenant_id=current_user.tenant_id,
            user_id=current_user.id,
            action="Password Reset",
            performed_by=current_user.username,
            target_user=current_user.username,
            role=str(current_user.role.value if hasattr(current_user.role, 'value') else current_user.role),
            details=f"Password changed by {current_user.username} (self-service)"
        )
        db.add(log)
        db.commit()
    except Exception:
        pass
    
    return {"message": "Password updated successfully."}
