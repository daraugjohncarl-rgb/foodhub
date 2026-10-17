"""
Blessie FoodHub POS - Real-Time WebSocket Connection Manager
Handles real-time push events to all connected clients (Kitchen, Cashier, Manager, Admin, Waiter).
"""
import asyncio
import json
import logging
from typing import Dict, List
from fastapi import WebSocket

logger = logging.getLogger("pos_realtime")

class ConnectionManager:
    def __init__(self):
        # Maps tenant_id -> list of active WebSockets
        self.active_connections: Dict[int, List[WebSocket]] = {}
        self.global_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket, tenant_id: int = 1):
        await websocket.accept()
        if tenant_id not in self.active_connections:
            self.active_connections[tenant_id] = []
        self.active_connections[tenant_id].append(websocket)
        logger.info(f"WebSocket client connected to tenant {tenant_id}. Active: {len(self.active_connections[tenant_id])}")

    def disconnect(self, websocket: WebSocket, tenant_id: int = 1):
        if tenant_id in self.active_connections and websocket in self.active_connections[tenant_id]:
            self.active_connections[tenant_id].remove(websocket)
            logger.info(f"WebSocket client disconnected from tenant {tenant_id}.")
        if websocket in self.global_connections:
            self.global_connections.remove(websocket)

    async def broadcast_to_tenant(self, tenant_id: int, message: dict):
        text_data = json.dumps(message)
        conns = list(self.active_connections.get(tenant_id, [])) + list(self.global_connections)
        dead_conns = []
        for connection in conns:
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
    Thread-safe & async-safe helper to broadcast a real-time event across all active clients.
    Can be called synchronously from any route without blocking.
    """
    message = {
        "event": event_type,
        "tenant_id": tenant_id,
        "data": data or {}
    }

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(manager.broadcast_to_tenant(tenant_id, message))
    except RuntimeError:
        try:
            asyncio.run(manager.broadcast_to_tenant(tenant_id, message))
        except Exception as e:
            logger.warning(f"Failed to broadcast real-time event {event_type}: {e}")
