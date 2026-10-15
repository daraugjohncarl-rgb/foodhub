from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
import app.models as models
from app.core import audit, config
from app.core.ratelimit import SlidingWindowLimiter, client_ip
from app.core.security import DUMMY_PASSWORD_HASH, create_access_token, get_password_hash, verify_password
from app.core.dependencies import get_current_user
from app.core.timeutils import as_utc, utcnow
from app.schemas import PasswordChangeRequest, SelfProfileUpdate, UserResponse

router = APIRouter(
    prefix="/auth",
    tags=["Authentication"]
)

# Per-IP failed-login limiter (per-account lockout lives in users.locked_until).
login_ip_limiter = SlidingWindowLimiter(config.LOGIN_MAX_ATTEMPTS_PER_IP, config.LOGIN_IP_WINDOW_MINUTES * 60)

_INVALID = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Incorrect username or password.",
    headers={"WWW-Authenticate": "Bearer"},
)


def _token_for(user: models.User) -> str:
    return create_access_token(data={
        "sub": str(user.id),
        "username": user.username,
        "role": audit.role_name(user.role),
        "tenant_id": user.tenant_id,
        "ver": user.token_version or 0,
    })


@router.post("/login")
def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    """
    Authenticate with username (case-insensitive) or email and password.
    Throttled per IP, and per account: after LOGIN_MAX_FAILED_ATTEMPTS consecutive failures the account is locked
    for LOGIN_LOCKOUT_MINUTES.
    """
    ip = client_ip(request)
    if login_ip_limiter.is_limited(ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Please wait and try again.",
        )

    identifier = (form_data.username or "").strip()
    user = db.query(models.User).filter(
        (func.lower(models.User.username) == identifier.lower()) | (models.User.email == identifier)
    ).first()

    if user is None:
        verify_password(form_data.password, DUMMY_PASSWORD_HASH)  # keep timing similar for unknown usernames
        login_ip_limiter.hit(ip)
        raise _INVALID

    now = utcnow()
    locked_until = as_utc(user.locked_until)
    if locked_until and locked_until > now:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="This account is temporarily locked after repeated failed logins. Try again later.",
        )

    if not verify_password(form_data.password, user.password_hash):
        login_ip_limiter.hit(ip)
        user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
        if user.failed_login_attempts >= config.LOGIN_MAX_FAILED_ATTEMPTS:
            user.locked_until = now + timedelta(minutes=config.LOGIN_LOCKOUT_MINUTES)
            user.failed_login_attempts = 0
            audit.record(db, user, "Account Locked", target_user=user.username,
                         details=f"Locked for {config.LOGIN_LOCKOUT_MINUTES} min after repeated failed logins")
        db.commit()
        raise _INVALID

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your account is deactivated.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user.failed_login_attempts = 0
    user.locked_until = None
    audit.record(db, user, "Login", target_user=user.username, details=f"User '{user.username}' logged in.")
    db.commit()

    return {
        "access_token": _token_for(user),
        "token_type": "bearer",
        "role": user.role,
        "tenant_id": user.tenant_id,
        "username": user.username,
        "must_change_password": bool(user.must_change_password),
    }


@router.get("/me", response_model=UserResponse)
def read_users_me(current_user: models.User = Depends(get_current_user)):
    """
    Retrieve details of the currently authenticated active user.
    """
    return current_user


@router.put("/me", response_model=UserResponse)
def update_users_me(
    user_in: SelfProfileUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Update your own profile. Changing username or email requires your current password.
    """
    changes = user_in.model_dump(exclude_unset=True)
    sensitive = [k for k in ("username", "email") if k in changes and changes[k] != getattr(current_user, k)]
    if sensitive:
        if not user_in.current_password or not verify_password(user_in.current_password, current_user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Enter your current password to change your username or email.",
            )

    if "username" in changes and changes["username"] is not None:
        existing = db.query(models.User).filter(
            func.lower(models.User.username) == changes["username"], models.User.id != current_user.id
        ).first()
        if existing:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already in use.")
        current_user.username = changes["username"]

    if "email" in changes:
        if changes["email"] is not None:
            existing_email = db.query(models.User).filter(
                models.User.email == changes["email"], models.User.id != current_user.id
            ).first()
            if existing_email:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already in use.")
        current_user.email = changes["email"]

    for field in ("first_name", "last_name", "phone"):
        if field in changes:
            setattr(current_user, field, changes[field])

    audit.record(db, current_user, "Profile Updated", target_user=current_user.username,
                 details=f"Profile details updated for {current_user.username}")
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username or email already in use.")
    db.refresh(current_user)
    return current_user


@router.put("/change-password")
def change_password(
    req: PasswordChangeRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Change your own password. All previously issued tokens stop working; the response carries a fresh token.
    """
    if not verify_password(req.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password does not match."
        )
    if verify_password(req.new_password, current_user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New password must differ from the current one.")

    current_user.password_hash = get_password_hash(req.new_password)
    current_user.must_change_password = False
    current_user.token_version = (current_user.token_version or 0) + 1
    audit.record(db, current_user, "Password Changed", target_user=current_user.username,
                 details=f"Password changed by {current_user.username} (self-service)")
    db.commit()
    db.refresh(current_user)

    return {
        "message": "Password updated successfully.",
        "access_token": _token_for(current_user),
        "token_type": "bearer",
    }
