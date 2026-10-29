"""
Real-Time WebSocket Router
Authenticated WebSocket endpoint for live updates between staff portals and the backend.

Security model:
- The handshake must carry a valid session (HttpOnly `session_token` cookie or a Bearer header).
- The tenant is derived from the verified user. A tenant id in the URL is only accepted if it
  matches the user's own tenant (SUPER_ADMIN may name any existing tenant).
- CUSTOMER accounts and anonymous clients are refused.
"""
import asyncio
import logging
import os
from urllib.parse import urlparse
from typing import Optional

from fastapi import APIRouter, WebSocket
from fastapi.websockets import WebSocketDisconnect
from app.core.websocket import manager
from app.core.dependencies import authenticate_token
from app.db import SessionLocal
import app.models as models

logger = logging.getLogger("pos_realtime")
router = APIRouter(tags=["Real-Time"])

IDLE_TIMEOUT_SECONDS = int(os.getenv("WS_IDLE_TIMEOUT_SECONDS", "90"))  # clients ping every 25s
MAX_MESSAGE_BYTES = 64

# Close codes (4000-4999 are application defined)
WS_UNAUTHENTICATED = 4401
WS_FORBIDDEN = 4403
WS_TRY_LATER = 4429


def _origin_allowed(websocket: WebSocket) -> bool:
    """Reject cross-site handshakes (cookie-authenticated WebSockets are otherwise hijackable)."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True  # non-browser clients do not send Origin
    host = urlparse(origin).netloc.lower()
    if host == (websocket.headers.get("host") or "").lower():
        return True
    allowed = [o.strip().lower() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
    return origin.lower() in allowed


def _extract_token(websocket: WebSocket) -> Optional[str]:
    auth = websocket.headers.get("authorization", "")
    if auth.lower().startswith("bearer ") and auth[7:].strip():
        return auth[7:].strip()
    return websocket.cookies.get("session_token")


def _authorize(websocket: WebSocket, requested_tenant: Optional[int]):
    """Return (user_id, tenant_id, token) on success, or (None, close_code, None)."""
    token = _extract_token(websocket)
    if not token:
        return None, WS_UNAUTHENTICATED, None
    db = SessionLocal()
    try:
        user = authenticate_token(token, db)
        if user is None:
            return None, WS_UNAUTHENTICATED, None
        if user.role == models.UserRole.CUSTOMER:
            return None, WS_FORBIDDEN, None
        if user.role == models.UserRole.SUPER_ADMIN:
            tenant_id = requested_tenant
            if not tenant_id or not db.query(models.Tenant.id).filter(models.Tenant.id == tenant_id).first():
                return None, WS_FORBIDDEN, None
        else:
            tenant_id = user.tenant_id
            if not tenant_id or (requested_tenant is not None and requested_tenant != tenant_id):
                return None, WS_FORBIDDEN, None
        return user.id, tenant_id, token
    finally:
        db.close()


def _session_still_valid(token: str, user_id: int) -> bool:
    db = SessionLocal()
    try:
        user = authenticate_token(token, db)
        return user is not None and user.id == user_id
    finally:
        db.close()


@router.websocket("/ws")
@router.websocket("/ws/{tenant_id}")
async def websocket_endpoint(websocket: WebSocket, tenant_id: Optional[int] = None):
    if not _origin_allowed(websocket):
        await websocket.close(code=WS_FORBIDDEN)
        return

    user_id, resolved, token = await asyncio.to_thread(_authorize, websocket, tenant_id)
    if user_id is None:
        await websocket.close(code=resolved)
        return
    if not manager.can_accept(resolved, user_id):
        await websocket.close(code=WS_TRY_LATER)
        return

    await manager.connect(websocket, resolved, user_id)
    try:
        while True:
            # Idle clients are dropped; live clients send "ping" every ~25s.
            data = await asyncio.wait_for(websocket.receive_text(), timeout=IDLE_TIMEOUT_SECONDS)
            if len(data) > MAX_MESSAGE_BYTES:
                await websocket.close(code=1009)
                break
            if data == "ping":
                # Re-validate the session so deactivation / logout / password change cuts the stream.
                if not await asyncio.to_thread(_session_still_valid, token, user_id):
                    await websocket.close(code=WS_UNAUTHENTICATED)
                    break
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    except asyncio.TimeoutError:
        # Idle client: tell it explicitly (1001 going away) so the connection is released.
        try:
            await websocket.close(code=1001)
        except Exception:
            pass
    except Exception as e:
        logger.warning("WebSocket error: %s", type(e).__name__)
    finally:
        manager.disconnect(websocket, resolved)
