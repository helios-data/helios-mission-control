"""/ws WebSocket endpoint: server pushes typed JSON frames to browsers.

role=admin gets everything; role=overlay is filtered to the read-only frame set
by the hub. On connect the client is sent a `snapshot` frame so it can render
immediately; chart backfill comes from the REST history endpoints (§3.3).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger("mission-control.ws")
router = APIRouter()


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    role = ws.query_params.get("role", "overlay")
    role = role if role in ("admin", "overlay") else "overlay"
    state = ws.app.state.mission
    hub = ws.app.state.hub

    await ws.accept()
    await hub.register(ws, role)
    try:
        await ws.send_json(state.full_snapshot())
        # Server-push only; we just drain client keepalives/pings.
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        await hub.unregister(ws)
