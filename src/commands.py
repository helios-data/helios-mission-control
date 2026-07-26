"""Command path: construction, publish, safety interlocks (§5).

Transport-agnostic: the CommandManager builds command records and hands the
payload to a `publish_fn`. In real mode the bridge wires that to serialize a
`GroundCommand` proto (falcon-protos) and publish it on the core. In STANDALONE
mode the publisher reflects camera commands back into the synthetic flight so the
telemetry stream confirms them.

There is no separate CommandAck any more: the onboard camera state is confirmed
via the TelemetryPacket (runcam_power / runcam_recording, surfaced as
srad.camera). A command record therefore only tracks whether we managed to
publish it (SENT) or not (ERROR) — the operator watches srad.camera for the
actual, rocket-reported result.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from .constants import IN_FLIGHT_STATES
from .hub import ConnectionHub
from .state import MissionState

log = logging.getLogger("mission-control.commands")

PublishFn = Callable[[int, str, dict[str, Any]], Awaitable[None]]


class CommandError(Exception):
    """Rejected by an interlock or validation; surfaced to the operator."""


class CommandStatus(StrEnum):
    PENDING = "pending"  # record created, not yet published
    SENT = "sent"        # published on the core / uplinked
    ERROR = "error"      # publish failed or no publisher configured


@dataclass
class CommandRecord:
    command_id: int
    type: str
    payload: dict[str, Any]
    operator: str
    issued_at: float
    status: CommandStatus = CommandStatus.PENDING
    message: str = ""

    def frame(self) -> dict[str, Any]:
        return {
            "type": "ack",
            "command_id": self.command_id,
            "command_type": self.type,
            "payload": self.payload,
            "operator": self.operator,
            "issued_at": self.issued_at,
            "status": self.status.value,
            "message": self.message,
        }


class CommandManager:
    def __init__(self, state: MissionState, hub: ConnectionHub) -> None:
        self.state = state
        self.hub = hub
        self.publish_fn: PublishFn | None = None  # set by bridge or standalone
        self._next_id = 1
        self.records: dict[int, CommandRecord] = {}
        # Last *commanded* camera state (§4.7). This is what the operator asked
        # for; the confirmed state comes back over telemetry (srad.camera).
        self.camera_state = {"power": False, "recording": False}

    # ---- issue -----------------------------------------------------------
    async def issue(
        self, cmd_type: str, payload: dict[str, Any], operator: str, override: bool = False
    ) -> CommandRecord:
        self._check_interlocks(cmd_type, payload, override)

        cid = self._next_id
        self._next_id += 1
        rec = CommandRecord(
            command_id=cid, type=cmd_type, payload=payload,
            operator=operator or "unknown", issued_at=time.time(),
        )
        self.records[cid] = rec

        if cmd_type == "camera":  # track commanded state immediately
            for k in ("power", "recording"):
                if k in payload:
                    self.camera_state[k] = bool(payload[k])

        await self.hub.broadcast(rec.frame())
        if self.publish_fn is None:
            rec.status = CommandStatus.ERROR
            rec.message = "no publisher configured"
        else:
            try:
                await self.publish_fn(cid, cmd_type, payload)
                rec.status = CommandStatus.SENT
            except Exception as exc:  # noqa: BLE001 - surface any transport error to the operator
                rec.status = CommandStatus.ERROR
                rec.message = str(exc)
        await self.hub.broadcast(rec.frame())
        return rec

    def _check_interlocks(self, cmd_type: str, payload: dict[str, Any], override: bool) -> None:
        if cmd_type == "rfd_config":
            # Disable RFD reconfig in flight unless override (§4.7): it can break the link.
            if self.state.flight_state in IN_FLIGHT_STATES and not override:
                raise CommandError(
                    f"RFD reconfig locked out during {self.state.flight_state}; "
                    "set override to proceed"
                )
        elif cmd_type == "camera":
            # Recording requires camera power on (§4.7): either it is already on and
            # this command isn't turning it off, or this command turns it on.
            wants_recording = payload.get("recording") is True
            powering_off = payload.get("power") is False
            powering_on = payload.get("power") is True
            currently_on = self.camera_state["power"]
            if wants_recording and not (powering_on or (currently_on and not powering_off)):
                raise CommandError("cannot start recording while camera power is off")
        else:
            raise CommandError(f"unknown command type: {cmd_type}")

    def history(self) -> list[dict[str, Any]]:
        return [r.frame() for r in sorted(self.records.values(), key=lambda r: r.command_id)]
