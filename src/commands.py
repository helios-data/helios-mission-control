"""Command path: construction, publish, ack tracking, safety interlocks (§5).

Transport-agnostic: the CommandManager builds command records and hands the
payload to a `publish_fn`. In real mode the bridge wires that to serialize a
`GroundCommand` proto and publish it on the core, and feeds `deliver_ack` from
the `command_ack` subscription. In STANDALONE mode a simulator acks locally so
the admin console is fully testable without hardware.
"""

from __future__ import annotations

import asyncio
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

ACK_TIMEOUT_S = 8.0
PublishFn = Callable[[int, str, dict[str, Any]], Awaitable[None]]


class CommandError(Exception):
    """Rejected by an interlock or validation; surfaced to the operator."""


class AckStatus(StrEnum):
    PENDING = "pending"
    OK = "ok"
    ERROR = "error"
    TIMEOUT = "timeout"


@dataclass
class CommandRecord:
    command_id: int
    type: str
    payload: dict[str, Any]
    operator: str
    issued_at: float
    status: AckStatus = AckStatus.PENDING
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
        # Commanded (not rocket-confirmed) camera state (§4.7).
        self.camera_state = {"vtx_power": False, "runcam_power": False, "recording": False}

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

        if cmd_type == "camera":  # track commanded (unconfirmed) state immediately
            for k in ("vtx_power", "runcam_power", "recording"):
                if k in payload:
                    self.camera_state[k] = bool(payload[k])

        await self.hub.broadcast(rec.frame())
        if self.publish_fn is not None:
            await self.publish_fn(cid, cmd_type, payload)
        else:
            rec.status = AckStatus.ERROR
            rec.message = "no publisher configured"
            await self.hub.broadcast(rec.frame())
            return rec

        asyncio.create_task(self._ack_timeout(cid))
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
            # Recording requires RunCam power on (§4.7).
            wants_recording = payload.get("recording") is True
            powering_off = payload.get("runcam_power") is False
            currently_on = self.camera_state["runcam_power"]
            if wants_recording and (powering_off or not currently_on) and not payload.get("runcam_power"):
                raise CommandError("cannot start recording while RunCam power is off")
        else:
            raise CommandError(f"unknown command type: {cmd_type}")

    # ---- ack -------------------------------------------------------------
    async def deliver_ack(self, command_id: int, success: bool, message: str = "") -> None:
        rec = self.records.get(command_id)
        if rec is None or rec.status is not AckStatus.PENDING:
            return
        rec.status = AckStatus.OK if success else AckStatus.ERROR
        rec.message = message
        await self.hub.broadcast(rec.frame())

    async def _ack_timeout(self, command_id: int) -> None:
        await asyncio.sleep(ACK_TIMEOUT_S)
        rec = self.records.get(command_id)
        if rec is not None and rec.status is AckStatus.PENDING:
            rec.status = AckStatus.TIMEOUT
            rec.message = "no ack within timeout"
            await self.hub.broadcast(rec.frame())

    def history(self) -> list[dict[str, Any]]:
        return [r.frame() for r in sorted(self.records.values(), key=lambda r: r.command_id)]


def attach_standalone_simulator(mgr: CommandManager) -> None:
    """Wire publish_fn to a local simulator that acks after a short delay."""

    async def _sim(command_id: int, cmd_type: str, payload: dict[str, Any]) -> None:
        async def _later() -> None:
            await asyncio.sleep(0.4)
            await mgr.deliver_ack(command_id, True, f"[sim] {cmd_type} applied")

        asyncio.create_task(_later())

    mgr.publish_fn = _sim
