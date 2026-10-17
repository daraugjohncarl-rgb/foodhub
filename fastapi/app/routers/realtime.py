"""
Real-Time WebSocket Router
WebSocket endpoint for live two-way updates between client portals and backend.
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.core.websocket import manager
import logging

logger = logging.getLogger("pos_realtime")
router = APIRouter(tags=["Real-Time"])

@router.websocket("/ws")
@router.websocket("/ws/{tenant_id}")
async def websocket_endpoint(websocket: WebSocket, tenant_id: int = 1):
    await manager.connect(websocket, tenant_id)
    try:
        while True:
            # Keep connection alive & respond to client ping
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket, tenant_id)
    except Exception as e:
        logger.warning(f"WebSocket error: {e}")
        manager.disconnect(websocket, tenant_id)
