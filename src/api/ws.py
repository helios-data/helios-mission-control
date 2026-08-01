"""/ws WebSocket endpoint: server pushes typed JSON frames to browsers.

role=admin gets everything; role=overlay is filtered to the read-only frame set
by the hub. On connect the client is sent a `snapshot` frame so it can render
immediately; chart backfill comes from the REST history endpoints (§3.3).
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..hub import _json_default

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
        # NOT ws.send_json(): Starlette's helper calls json.dumps with no custom
        # encoder, so one non-JSON-able value anywhere in the snapshot (a proto
        # timestamp arriving as a datetime, say) raised here, was swallowed
        # below, and closed the socket before the client got its first frame —
        # which the browser answered by reconnecting every 1.5 s forever. Use the
        # hub's encoder so both push paths serialize identically and degrade
        # rather than disconnect.
        await ws.send_text(json.dumps(state.full_snapshot(), default=_json_default))
        # Server-push only; we just drain client keepalives/pings.
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - never let one client's failure escape
        # Logged, not silent: swallowing this is what made the reconnect storm
        # above invisible from the server side.
        log.exception("websocket (role=%s) closing after an unhandled error", role)
    finally:
        await hub.unregister(ws)
