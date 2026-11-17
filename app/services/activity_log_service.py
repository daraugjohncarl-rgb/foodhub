"""
Activity Logs & Audit Trail Service
Authoritative, append-only activity tracking service exclusively for Superadmin audits.
Enforces Philippine Standard Time (Asia/Manila, UTC+08:00).
Explicitly excludes SUPERADMIN actions from tracking.
"""

import json
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
from sqlalchemy.orm import Session
from fastapi import Request
import app.models as models

# Philippine Timezone: Asia/Manila (UTC+08:00)
MANILA_TZ = timezone(timedelta(hours=8))

# Sensitive fields that must NEVER be logged or stored in metadata
SENSITIVE_KEYS = {
    "password", "password_hash", "access_token", "token", "refresh_token",
    "secret", "auth", "authorization", "cookie", "credentials"
}

def get_manila_now() -> datetime:
    """Returns current datetime in Philippine Standard Time (naive UTC-aligned or aware)."""
    return datetime.now(MANILA_TZ)

def format_manila_date(dt: Optional[datetime]) -> str:
    """Formats datetime to 'November 11, 2026'."""
    if not dt:
        return "—"
    if dt.tzinfo is None:
        # DB DATETIME columns store Asia/Manila wall-clock time via func.now() / get_manila_now()
        dt = dt.replace(tzinfo=MANILA_TZ)
    else:
        dt = dt.astimezone(MANILA_TZ)
    return dt.strftime("%B %d, %Y")

def format_manila_time(dt: Optional[datetime]) -> str:
    """Formats datetime to 12-hour format '07:45:32 PM'."""
    if not dt:
        return "—"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=MANILA_TZ)
    else:
        dt = dt.astimezone(MANILA_TZ)
    return dt.strftime("%I:%M:%S %p")

def sanitize_metadata(meta: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Sanitizes metadata dictionary removing sensitive keys."""
    if not meta:
        return None
    cleaned = {}
    for k, v in meta.items():
        if k.lower() in SENSITIVE_KEYS:
            continue
        if isinstance(v, dict):
            cleaned[k] = sanitize_metadata(v)
        elif isinstance(v, (str, int, float, bool, list)):
            cleaned[k] = v
        else:
            cleaned[k] = str(v)
    return cleaned

def extract_ip_and_ua(request: Optional[Request] = None) -> tuple:
    """Extracts client IP address and user-agent from FastAPI request."""
    if not request:
        return ("127.0.0.1", "Internal Process")
    
    # Priority: X-Forwarded-For -> X-Real-IP -> Client Host
    ip = None
    xff = request.headers.get("x-forwarded-for")
    if xff:
        ip = xff.split(",")[0].strip()
    if not ip:
        ip = request.headers.get("x-real-ip")
    if not ip and request.client:
        ip = request.client.host
    if not ip:
        ip = "127.0.0.1"

    ua = request.headers.get("user-agent", "Unknown Browser / Client")[:255]
    return (ip[:45], ua)

def record_activity(
    db: Session,
    activity_type: str,
    description: str,
    user: Optional[models.User] = None,
    user_id: Optional[int] = None,
    username: Optional[str] = None,
    full_name: Optional[str] = None,
    role: Optional[str] = None,
    tenant_id: Optional[int] = None,
    target_user: Optional[str] = None,
    status: str = "SUCCESS",
    request: Optional[Request] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
    session_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    commit: bool = True
) -> Optional[models.ActivityLog]:
    """
    Core activity logging function.
    CRITICAL: Excludes SUPERADMIN accounts from being tracked.
    Guaranteed non-blocking: catches exceptions so operations never crash on log failure.
    """
    try:
        # Determine user details if user model passed
        if user:
            u_role = user.role.value if hasattr(user.role, "value") else str(user.role)
            # CRITICAL RULE: EXCLUDE SUPERADMIN
            if u_role.upper() in ("SUPER_ADMIN", "SUPERADMIN"):
                return None
            user_id = user.id
            username = user.username
            full_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.username
            role = u_role
            tenant_id = user.tenant_id if tenant_id is None else tenant_id
        else:
            u_role = str(role or "").upper()
            if u_role in ("SUPER_ADMIN", "SUPERADMIN"):
                return None

        # Extract client IP and user agent if request provided
        if request and (not ip_address or not user_agent):
            req_ip, req_ua = extract_ip_and_ua(request)
            ip_address = ip_address or req_ip
            user_agent = user_agent or req_ua

        # Default fallback strings
        username = username or "Anonymous"
        full_name = full_name or username
        role = role or "USER"
        ip_address = ip_address or "127.0.0.1"
        user_agent = user_agent or "Unknown Device"
        status = status.upper()

        # Sanitize metadata
        meta_cleaned = sanitize_metadata(metadata)
        meta_json_str = json.dumps(meta_cleaned) if meta_cleaned else None

        # Create record with both legacy and extended fields populated
        log = models.ActivityLog(
            tenant_id=tenant_id,
            user_id=user_id,
            action=activity_type[:50],  # Legacy compatibility
            performed_by=username[:100],  # Legacy compatibility
            target_user=target_user[:100] if target_user else None,
            role=role[:50],
            details=description[:255] if description else "",  # Legacy compatibility
            username=username[:100],
            full_name=full_name[:150],
            activity_type=activity_type[:100],
            description=description,
            ip_address=ip_address[:45],
            user_agent=user_agent[:255],
            session_id=session_id[:100] if session_id else None,
            status=status[:50],
            metadata_json=meta_json_str,
            created_at=get_manila_now()
        )

        db.add(log)
        if commit:
            db.commit()
            db.refresh(log)
        return log
    except Exception as e:
        # Never break main transaction/POS flow if activity log fails
        print(f"[ActivityLog] Warning: failed to record activity '{activity_type}': {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return None

