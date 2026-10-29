"""
Blessie FoodHub POS - Real-Time WebSocket Connection Manager
Pushes live events to authenticated staff clients (Kitchen, Cashier, Manager, Admin).
Connections are registered per tenant, and a tenant's events are only ever sent to
sockets that were authenticated for that tenant.
"""
import asyncio
import json
import logging
import os
from typing import Dict, List
from fastapi import WebSocket

logger = logging.getLogger("pos_realtime")

MAX_CONNECTIONS_PER_TENANT = int(os.getenv("WS_MAX_CONNECTIONS_PER_TENANT", "100"))
MAX_CONNECTIONS_PER_USER = int(os.getenv("WS_MAX_CONNECTIONS_PER_USER", "5"))

# Keys that must never be pushed to a socket, whatever the caller passes in.
SENSITIVE_KEYS = {"tracking_token", "token", "access_token", "password", "password_hash"}


def _scrub(value):
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items() if k not in SENSITIVE_KEYS}
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    return value


class ConnectionManager:
    def __init__(self):
        # Maps tenant_id -> list of active WebSockets (already authenticated by the router)
        self.active_connections: Dict[int, List[WebSocket]] = {}
        self._owners: Dict[WebSocket, int] = {}
        # Event loop that owns the sockets; routes running in worker threads schedule onto it.
        self._loop = None

    def can_accept(self, tenant_id: int, user_id: int) -> bool:
        if len(self.active_connections.get(tenant_id, [])) >= MAX_CONNECTIONS_PER_TENANT:
            return False
        return sum(1 for owner in self._owners.values() if owner == user_id) < MAX_CONNECTIONS_PER_USER

    async def connect(self, websocket: WebSocket, tenant_id: int, user_id: int):
        """Register an authenticated socket. The caller must already have verified tenant access."""
        await websocket.accept()
        self._loop = asyncio.get_running_loop()
        self.active_connections.setdefault(tenant_id, []).append(websocket)
        self._owners[websocket] = user_id
        logger.info("WebSocket client connected to tenant %s. Active: %s", tenant_id, len(self.active_connections[tenant_id]))

    def disconnect(self, websocket: WebSocket, tenant_id: int):
        conns = self.active_connections.get(tenant_id)
        if conns and websocket in conns:
            conns.remove(websocket)
            if not conns:
                self.active_connections.pop(tenant_id, None)
            logger.info("WebSocket client disconnected from tenant %s.", tenant_id)
        self._owners.pop(websocket, None)

    async def broadcast_to_tenant(self, tenant_id: int, message: dict):
        text_data = json.dumps(_scrub(message))
        dead_conns = []
        for connection in list(self.active_connections.get(tenant_id, [])):
            try:
                await connection.send_text(text_data)
            except Exception:
                dead_conns.append(connection)

        # Cleanup dead connections
        for dead in dead_conns:
            self.disconnect(dead, tenant_id)

manager = ConnectionManager()

def notify_realtime_event(tenant_id: int, event_type: str, data: dict = None):
    """
    Thread-safe & async-safe helper to broadcast a real-time event to one tenant's connected staff.
    Can be called synchronously from any route without blocking.
    """
    if not tenant_id:
        logger.warning("Dropping real-time event %s without a tenant.", event_type)
        return
    message = {
        "event": event_type,
        "tenant_id": tenant_id,
        "data": data or {}
    }

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(manager.broadcast_to_tenant(tenant_id, message))
        return
    except RuntimeError:
        pass
    # Called from a worker thread (sync route): hand the broadcast to the loop that owns the sockets.
    owner_loop = manager._loop
    if owner_loop is None or owner_loop.is_closed() or not manager.active_connections.get(tenant_id):
        return  # nobody connected for this tenant
    try:
        asyncio.run_coroutine_threadsafe(manager.broadcast_to_tenant(tenant_id, message), owner_loop)
    except Exception as e:
        logger.warning("Failed to broadcast real-time event %s: %s", event_type, e)
