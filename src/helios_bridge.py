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
from .telemetry import (
    MIN_PACKET_BYTES,
    normalize_cots,
    normalize_landing,
    normalize_rfd_config,
    normalize_srad,
)

log = logging.getLogger("mission-control.bridge")

SRAD_ADDRESS = "Helios.FALCON.SRAD_Telemetry"
SRAD_EVENT = "telemetry"
COTS_ADDRESS = "Helios.FALCON.APRS_Telemetry"
COTS_EVENT = "aprs"
# Landing predictor (separate Helios node; optional — may not be running).
LANDING_ADDRESS = "Helios.Services.LandingPredictor"
LANDING_EVENT = "landing_prediction"
# Ground modem's current S-registers, published by helios-cots-telemetry (which
# owns the RFD serial port): once at startup, then again after each write it
# applies. Same address we publish `command` on, since it's the same node.
RFD_CONFIG_ADDRESS = SRAD_ADDRESS
RFD_CONFIG_EVENT = "current_rfd_config"
NODE_URI = "Helios.Services.Mission_Control"

# Retry cadence for the (optional) landing-prediction subscription, kept isolated
# so a missing/idle predictor never tears down the SRAD/COTS subscriptions.
LANDING_RETRY_S = 5.0

# The one-shot seed of `current_rfd_config` races helios-cots-telemetry's startup
# — that node may not have registered its address or published yet when we
# connect. Retry on a 1s cadence, bounded, then give up and rely on the
# subscription (which picks up the next publish whenever it happens).
RFD_SEED_RETRY_S = 1.0
RFD_SEED_MAX_TRIES = 30
RFD_CONFIG_RETRY_S = 5.0

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
                    self._subscribe_landing(),
                    self._seed_rfd_config(),
                    self._subscribe_rfd_config(),
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

    # ---- landing prediction (optional predictor node) --------------------
    async def _subscribe_landing(self) -> None:
        """Subscribe to the LandingPredictor node, isolated + self-retrying.

        The predictor is a separate optional node, so its subscription runs in its
        own retry loop: if the address isn't registered yet (predictor not running)
        or the stream drops, we back off and retry here instead of letting the
        error propagate into the gather and cycle the telemetry subscriptions.
        """
        try:
            from src.generated import LandingPrediction  # noqa: PLC0415 - lazy by design
        except ImportError:
            log.warning(
                "LandingPrediction proto not compiled; landing predictions disabled "
                "until `make protos` (see protos-proposed/landing_prediction.proto)"
            )
            return
        while True:
            try:
                async with self.client.subscribe_event(
                    address=LANDING_ADDRESS, event_name=LANDING_EVENT
                ) as events:
                    async for event in events:
                        frame = self._parse_landing(LandingPrediction, event.data)
                        if frame is not None:
                            await self.hub.broadcast(self.state.ingest_landing(frame))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - predictor optional; retry, don't tear down telemetry
                log.warning(
                    "landing-prediction subscription error (%s); retrying in %.0fs",
                    exc, LANDING_RETRY_S,
                )
                await asyncio.sleep(LANDING_RETRY_S)

    def _parse_landing(self, cls: Any, data: bytes) -> dict[str, Any] | None:
        if not data:
            return None
        try:
            return normalize_landing(cls.parse(data))
        except Exception:  # noqa: BLE001 - a bad prediction frame must not drop the stream
            return None

    # ---- ground modem config (current_rfd_config) ------------------------
    def _rfd_config_cls(self) -> Any | None:
        try:
            from src.generated import RfdConfig  # noqa: PLC0415 - lazy by design
        except ImportError:
            log.warning(
                "RfdConfig proto not compiled; ground-modem config display disabled "
                "until `make protos`"
            )
            return None
        return RfdConfig

    async def _seed_rfd_config(self) -> None:
        """Pull the modem's current S-registers with get_event, retrying on a 1s cadence.

        helios-cots-telemetry publishes this once on startup, so we may well
        connect before it exists. Retry up to RFD_SEED_MAX_TRIES, then stop and
        let _subscribe_rfd_config catch the next publish — an unbounded loop here
        would hammer the core forever when the node simply isn't deployed.
        """
        cls = self._rfd_config_cls()
        if cls is None:
            return
        for attempt in range(1, RFD_SEED_MAX_TRIES + 1):
            if self.state.rfd_config_latest is not None:
                return  # the subscription beat us to it
            try:
                ev = await asyncio.wait_for(
                    self.client.get_event(
                        address=RFD_CONFIG_ADDRESS, event_name=RFD_CONFIG_EVENT
                    ),
                    timeout=SEED_TIMEOUT_S,
                )
                if ev and getattr(ev, "data", None):
                    frame = self._parse_rfd_config(cls, ev.data)
                    if frame is not None:
                        await self.hub.broadcast(self.state.ingest_rfd_config(frame))
                        log.info("seeded ground-modem config after %d attempt(s)", attempt)
                        return
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - incl. TimeoutError; node may not be up yet
                pass
            await asyncio.sleep(RFD_SEED_RETRY_S)
        log.warning(
            "no %s from %s after %d attempts; waiting on the subscription instead",
            RFD_CONFIG_EVENT, RFD_CONFIG_ADDRESS, RFD_SEED_MAX_TRIES,
        )

    async def _subscribe_rfd_config(self) -> None:
        """Live ground-modem config updates, self-retrying like the predictor.

        helios-cots-telemetry re-publishes after every write it applies, which is
        what acknowledges an rfd_config command. Isolated retry loop so a node
        that isn't running never tears down the telemetry subscriptions.
        """
        cls = self._rfd_config_cls()
        if cls is None:
            return
        while True:
            try:
                async with self.client.subscribe_event(
                    address=RFD_CONFIG_ADDRESS, event_name=RFD_CONFIG_EVENT
                ) as events:
                    async for event in events:
                        frame = self._parse_rfd_config(cls, event.data)
                        if frame is not None:
                            await self.hub.broadcast(self.state.ingest_rfd_config(frame))
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - optional node; retry, don't tear down telemetry
                log.warning(
                    "%s subscription error (%s); retrying in %.0fs",
                    RFD_CONFIG_EVENT, exc, RFD_CONFIG_RETRY_S,
                )
                await asyncio.sleep(RFD_CONFIG_RETRY_S)

    def _parse_rfd_config(self, cls: Any, data: bytes) -> dict[str, Any] | None:
        if not data:
            return None
        try:
            return normalize_rfd_config(cls.parse(data))
        except Exception:  # noqa: BLE001 - a bad config frame must not drop the stream
            log.warning("could not parse %s payload", RFD_CONFIG_EVENT)
            return None

    # ---- command path (§5) ----------------------------------------------
    async def publish_command(
        self, command_id: int, cmd_type: str, payload: dict[str, Any]
    ) -> None:
        """Serialize a GroundCommand (falcon-protos) and publish it on the core.

        RFD config + camera control both publish on the FALCON telemetry address
        with event_name='command'; helios-cots-telemetry (owner of the RFD serial
        port) consumes it — RFD config is applied to the ground modem, camera
        control is uplinked to FALCON over RF. There is no separate command_ack:
        the onboard camera state is confirmed via TelemetryPacket
        (runcam_power / runcam_recording, surfaced as srad.camera). Requires
        `make protos` to have compiled falcon-protos/GroundCommand.proto.
        """
        try:
            from src.generated import (  # noqa: PLC0415
                CameraControl,
                GroundCommand,
                RfdConfig,
            )
        except ImportError as exc:
            raise RuntimeError(
                "GroundCommand proto not compiled; run `make protos` after adding "
                "the falcon-protos submodule (GroundCommand.proto now lives there)"
            ) from exc

        cmd = GroundCommand(command_id=command_id, issued_at_ms=int(payload.get("issued_at_ms", 0)),
                            operator=str(payload.get("operator", "")))
        if cmd_type == "rfd_config":
            cmd.rfd_config = RfdConfig(**_proto_fields(RfdConfig, payload))
        elif cmd_type == "camera":
            # A single switch powers the VTX + RunCam together (vtx_runcam_power);
            # recording maps to camera_recording. Both optional so one command can
            # change one thing at a time.
            cam = CameraControl()
            if "power" in payload:
                cam.vtx_runcam_power = bool(payload["power"])
            if "recording" in payload:
                cam.camera_recording = bool(payload["recording"])
            cmd.camera = cam
        await self.client.publish_event(
            event_name="command", data=bytes(cmd), override_address=SRAD_ADDRESS,
        )

    async def _housekeeping(self) -> None:
        """Emit link + mission frames at ~4 Hz so ages/rates stay fresh."""
        while True:
            await self.hub.broadcast(self.state.link_snapshot())
            await self.hub.broadcast(self.state.mission_snapshot())
            await asyncio.sleep(0.25)
