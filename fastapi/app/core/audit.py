"""
Audit-trail helper (H8). Actor, role and tenant always come from the authenticated server-side user, never from the
request body. Callers add the entry to the current session; it is committed together with the change it describes.
Never pass passwords, tokens or other secrets in `details`.
"""
from typing import Optional

from sqlalchemy.orm import Session

import app.models as models


def role_name(role) -> str:
    return role.value if hasattr(role, "value") else str(role)


def record(
    db: Session,
    actor: models.User,
    action: str,
    *,
    details: Optional[str] = None,
    target_user: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> models.ActivityLog:
    """
    tenant_id defaults to the actor's tenant. For actions on another account (e.g. a super admin resetting a branch
    user's password) pass the target's tenant so the branch admin sees the entry in their own audit log.
    """
    entry = models.ActivityLog(
        tenant_id=tenant_id if tenant_id is not None else actor.tenant_id,
        user_id=actor.id,
        action=action[:50],
        performed_by=actor.username[:100],
        target_user=target_user[:100] if target_user else None,
        role=role_name(actor.role),
        details=details[:255] if details else None,
    )
    db.add(entry)
    return entry
