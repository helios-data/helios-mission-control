"""WebSocket fan-out hub.

The bridge (or standalone generator) pushes typed JSON frames here; the hub
broadcasts them to every connected browser, filtered by role. Overlay clients
never receive command/ack traffic (§3.2).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from starlette.websockets import WebSocket, WebSocketState

log = logging.getLogger("mission-control.hub")

# Frame types an overlay client is allowed to receive (read-only surface).
_OVERLAY_ALLOWED = {"srad", "cots", "link", "mission", "config", "snapshot", "prediction"}


class ConnectionHub:
    def __init__(self) -> None:
        self._conns: dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()

    async def register(self, ws: WebSocket, role: str) -> None:
        async with self._lock:
            self._conns[ws] = role

    async def unregister(self, ws: WebSocket) -> None:
        async with self._lock:
            self._conns.pop(ws, None)

    @property
    def count(self) -> int:
        return len(self._conns)

    async def broadcast(self, frame: dict[str, Any]) -> None:
        ftype = frame.get("type")
        text = json.dumps(frame, default=_json_default)
        async with self._lock:
            targets = list(self._conns.items())
        dead: list[WebSocket] = []
        for ws, role in targets:
            if role == "overlay" and ftype not in _OVERLAY_ALLOWED:
                continue
            if ws.client_state != WebSocketState.CONNECTED:
                dead.append(ws)
                continue
            try:
                await ws.send_text(text)
            except Exception:  # noqa: BLE001 - drop broken clients silently
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._conns.pop(ws, None)


def _json_default(o: object) -> Any:
    if hasattr(o, "__dict__"):
        return o.__dict__
    return str(o)
