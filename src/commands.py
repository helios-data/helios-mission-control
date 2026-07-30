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

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from .constants import IN_FLIGHT_STATES, RFD_CHOICES, RFD_FIELDS, RFD_RANGES
from .hub import ConnectionHub
from .state import MissionState

log = logging.getLogger("mission-control.commands")

PublishFn = Callable[[int, str, dict[str, Any]], Awaitable[None]]
# Camera command payload keys that telemetry (srad.camera) confirms.
_CAMERA_KEYS = ("power", "recording")


class CommandError(Exception):
    """Rejected by an interlock or validation; surfaced to the operator."""


class CommandStatus(StrEnum):
    PENDING = "pending"            # record created, not yet published
    SENT = "sent"                  # published on the core / uplinked, awaiting confirmation
    ACKNOWLEDGED = "acknowledged"  # telemetry confirms the commanded state took effect
    ERROR = "error"                # publish failed or no publisher configured


def _camera_matches(payload: dict[str, Any], cam: dict[str, Any]) -> bool:
    """True when telemetry camera state satisfies every camera field in payload."""
    keys = [k for k in _CAMERA_KEYS if k in payload]
    return bool(keys) and all(bool(payload[k]) == bool(cam.get(k)) for k in keys)


def _validate_rfd(payload: dict[str, Any]) -> None:
    """Reject an rfd_config payload the ground modem wouldn't accept.

    Every field is optional (a command may change one S-register), but anything
    present must be an in-range integer. The admin form checks the same table
    (frontend/src/lib/rfd.ts) before sending; this is the authoritative pass, so
    the API can't be used to write a value that breaks the link.
    """
    unknown = sorted(set(payload) - RFD_FIELDS)
    if unknown:
        raise CommandError(f"unknown RFD field(s): {', '.join(unknown)}")

    for key, value in list(payload.items()):
        # JSON has no int/float distinction, so accept 30.0 but not 30.5.
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise CommandError(f"{key} must be a whole number, got {value!r}")
        if value != int(value):
            raise CommandError(f"{key} must be a whole number, got {value!r}")
        value = payload[key] = int(value)
        if key in RFD_RANGES:
            lo, hi = RFD_RANGES[key]
            if not lo <= value <= hi:
                raise CommandError(f"{key}={value} out of range; must be {lo}-{hi}")
        else:
            choices = RFD_CHOICES[key]
            if value not in choices:
                raise CommandError(
                    f"{key}={value} unsupported; must be one of "
                    f"{', '.join(str(c) for c in choices)}"
                )

    lo_f, hi_f = payload.get("min_freq_khz"), payload.get("max_freq_khz")
    if lo_f is not None and hi_f is not None and lo_f >= hi_f:
        raise CommandError(f"min_freq_khz={lo_f} must be below max_freq_khz={hi_f}")


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
            # Override skips the flight-state lockout, never the value check.
            _validate_rfd(payload)
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

    # ---- telemetry-driven acknowledgement --------------------------------
    def observe_srad(self, frame: dict[str, Any]) -> None:
        """Flip SENT camera commands to ACKNOWLEDGED when telemetry confirms them.

        Confirmation is baked into the TelemetryPacket (srad.camera) rather than a
        CommandAck, so we watch the telemetry stream: a published camera command is
        acknowledged once srad.camera reflects its requested state. Called from a
        MissionState sink on the running loop, so we can schedule the WS re-broadcast.
        """
        cam = frame.get("camera")
        if not cam:
            return
        for rec in self.records.values():
            if (
                rec.type == "camera"
                and rec.status is CommandStatus.SENT
                and _camera_matches(rec.payload, cam)
            ):
                rec.status = CommandStatus.ACKNOWLEDGED
                rec.message = "confirmed by telemetry"
                asyncio.create_task(self.hub.broadcast(rec.frame()))

    def observe_rfd_config(self, frame: dict[str, Any]) -> None:
        """Flip SENT rfd_config commands to ACKNOWLEDGED when the modem reports back.

        helios-cots-telemetry re-publishes `current_rfd_config` after it writes
        the ground modem, so a command is confirmed once every register it asked
        for is reflected in the reported config. Same shape as observe_srad: a
        MissionState sink on the running loop, so the WS re-broadcast can be
        scheduled.
        """
        cfg = frame.get("config")
        if not cfg:
            return
        for rec in self.records.values():
            if rec.type != "rfd_config" or rec.status is not CommandStatus.SENT:
                continue
            if all(cfg.get(k) == v for k, v in rec.payload.items()):
                rec.status = CommandStatus.ACKNOWLEDGED
                rec.message = "confirmed by ground modem"
                asyncio.create_task(self.hub.broadcast(rec.frame()))
