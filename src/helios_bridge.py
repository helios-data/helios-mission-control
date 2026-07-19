"""Helios bridge: SDK subscriptions -> MissionState -> WS broadcast (§3.1).

Used when the helios-python-sdk + falcon-protos submodules are present. Imports
are lazy so this module is importable (and the app boots in STANDALONE mode)
even when the SDK is not installed.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .hub import ConnectionHub
from .state import MissionState
from .telemetry import MIN_PACKET_BYTES, normalize_cots, normalize_srad

log = logging.getLogger("mission-control.bridge")

SRAD_ADDRESS = "Helios.FALCON.SRAD_Telemetry"
SRAD_EVENT = "telemetry"
COTS_ADDRESS = "Helios.FALCON.APRS_Telemetry"
COTS_EVENT = "aprs"
NODE_URI = "Helios.Services.MissionControl"

# Bound the one-shot seed get_event. If a component (e.g. TeleGPS) hasn't
# registered its address yet, the core replies with event_error and the SDK
# never resolves the pending future — so an unbounded seed would hang forever
# and the subscriptions below (in the gather) would never start. See _seed_latest.
SEED_TIMEOUT_S = 2.0


def _load_proto_classes() -> tuple[Any, Any]:
    """Import the generated betterproto packet classes (raises if missing)."""
    from src.generated import TelemetryPacket  # noqa: PLC0415 - lazy by design

    try:
        from src.generated import AprsPacket  # type: ignore  # noqa: PLC0415
    except ImportError:
        # SDK ships a generated AprsPacket; prefer it (as helios-dashboard does).
        from helios.generated.helios.transport import AprsPacket  # type: ignore  # noqa: PLC0415
    return TelemetryPacket, AprsPacket


def _proto_fields(cls: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Keep only payload keys that are real fields on the betterproto message."""
    fields = getattr(cls, "__dataclass_fields__", {})
    return {k: v for k, v in payload.items() if k in fields}


class HeliosBridge:
    def __init__(self, state: MissionState, hub: ConnectionHub) -> None:
        self.state = state
        self.hub = hub
        self.client: Any = None
        self._telemetry_cls: Any = None
        self._aprs_cls: Any = None
        self.commands: Any = None  # set by main._attach_bridge_publisher

    async def run(self) -> None:
        from helios import HeliosClient  # noqa: PLC0415

        self._telemetry_cls, self._aprs_cls = _load_proto_classes()
        cfg = self.state.config
        backoff = 1.0
        while True:
            try:
                self.client = HeliosClient(
                    core_address=cfg.get("core_address", "Helios"),
                    core_port=cfg.get("core_port", 5000),
                    node_uri=NODE_URI,
                )
                await self.client.connect()
                self.state.core_connected = True
                backoff = 1.0
                log.info("connected to Helios core")
                await self._seed_latest()
                await asyncio.gather(
                    self._subscribe_srad(),
                    self._subscribe_cots(),
                    self._subscribe_acks(),
                    self._housekeeping(),
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.state.core_connected = False
                await self.hub.broadcast(self.state.link_snapshot())
                log.warning("core connection lost (%s); retrying in %.0fs", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _seed_latest(self) -> None:
        """One-shot get_event on both addresses so 'latest' is populated at once."""
        for addr, event, parse, ingest, on_err in (
            (SRAD_ADDRESS, SRAD_EVENT, self._parse_srad, self.state.ingest_srad,
             self.state.record_srad_error),
            (COTS_ADDRESS, COTS_EVENT, self._parse_cots, self.state.ingest_cots,
             self.state.record_cots_error),
        ):
            try:
                ev = await asyncio.wait_for(
                    self.client.get_event(address=addr, event_name=event),
                    timeout=SEED_TIMEOUT_S,
                )
                if ev and getattr(ev, "data", None):
                    frame = parse(ev.data)
                    if frame is not None:
                        await self.hub.broadcast(ingest(frame))
            except Exception:  # noqa: BLE001 - incl. TimeoutError; count + move on so subscriptions start
                on_err()

    async def _subscribe_srad(self) -> None:
        async with self.client.subscribe_event(address=SRAD_ADDRESS, event_name=SRAD_EVENT) as events:
            async for event in events:
                frame = self._parse_srad(event.data)
                if frame is not None:
                    await self.hub.broadcast(self.state.ingest_srad(frame))

    async def _subscribe_cots(self) -> None:
        async with self.client.subscribe_event(address=COTS_ADDRESS, event_name=COTS_EVENT) as events:
            async for event in events:
                frame = self._parse_cots(event.data)
                if frame is not None:
                    await self.hub.broadcast(self.state.ingest_cots(frame))

    def _parse_srad(self, data: bytes) -> dict[str, Any] | None:
        if not data or len(data) < MIN_PACKET_BYTES:
            self.state.record_srad_error()
            return None
        try:
            return normalize_srad(self._telemetry_cls.parse(data))
        except Exception:  # noqa: BLE001 - keep last-good, count errors (§1.2)
            self.state.record_srad_error()
            return None

    def _parse_cots(self, data: bytes) -> dict[str, Any] | None:
        if not data or len(data) < MIN_PACKET_BYTES:
            self.state.record_cots_error()
            return None
        try:
            return normalize_cots(self._aprs_cls.parse(data))
        except Exception:  # noqa: BLE001
            self.state.record_cots_error()
            return None

    # ---- command path (§5) ----------------------------------------------
    async def publish_command(
        self, command_id: int, cmd_type: str, payload: dict[str, Any], commands: Any
    ) -> None:
        """Serialize a GroundCommand (proposed protos) and publish it on the core.

        RFD config + camera control both publish on the FALCON telemetry address
        with event_name='command'; helios-cots-telemetry (owner of the RFD serial
        port) consumes it and replies with 'command_ack' (§5). Requires
        `make protos` to have compiled protos-proposed/ground_command.proto.
        """
        try:
            from src.generated.helios.ground import (  # noqa: PLC0415
                CameraControl,
                GroundCommand,
                RfdConfig,
            )
        except ImportError as exc:
            raise RuntimeError(
                "GroundCommand proto not compiled; run `make protos` after adding "
                "the falcon-protos submodule (see protos-proposed/ground_command.proto)"
            ) from exc

        cmd = GroundCommand(command_id=command_id, issued_at_ms=int(payload.get("issued_at_ms", 0)),
                            operator=str(payload.get("operator", "")))
        if cmd_type == "rfd_config":
            cmd.rfd_config = RfdConfig(**_proto_fields(RfdConfig, payload))
        elif cmd_type == "camera":
            cmd.camera = CameraControl(**_proto_fields(CameraControl, payload))
        await self.client.publish_event(
            event_name="command", data=bytes(cmd), override_address=SRAD_ADDRESS,
        )

    async def _subscribe_acks(self) -> None:
        try:
            from src.generated.helios.ground import CommandAck  # noqa: PLC0415
        except ImportError:
            log.warning("CommandAck proto not compiled; acks disabled until `make protos`")
            return
        async with self.client.subscribe_event(
            address=SRAD_ADDRESS, event_name="command_ack"
        ) as events:
            async for event in events:
                try:
                    ack = CommandAck.parse(event.data)
                except Exception:  # noqa: BLE001
                    continue
                if self.commands is not None:
                    await self.commands.deliver_ack(
                        ack.command_id, bool(ack.success), ack.message or ""
                    )

    async def _housekeeping(self) -> None:
        """Emit link + mission frames at ~4 Hz so ages/rates stay fresh."""
        while True:
            await self.hub.broadcast(self.state.link_snapshot())
            await self.hub.broadcast(self.state.mission_snapshot())
            await asyncio.sleep(0.25)
