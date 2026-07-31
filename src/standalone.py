"""STANDALONE mode: drive the app from an internal synthetic flight (no core).

Enabled with STANDALONE=1. Lets the entire stack (WS, REST, both UIs) run and be
demoed with zero submodules and zero hardware — the same path the frontend is
developed against.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Any

from .commands import CommandManager
from .constants import RFD_CONFIG_FIELDS
from .flight_model import SyntheticFlight
from .hub import ConnectionHub
from .state import MissionState

log = logging.getLogger("mission-control.standalone")

# Simulated ground->uplink->FC->telemetry round-trip before a camera command
# shows up as confirmed in the telemetry stream.
CAMERA_APPLY_DELAY_S = 0.4
# Simulated AT-command round-trip on the ground modem before helios-cots-telemetry
# re-publishes `current_rfd_config` with the new registers.
RFD_APPLY_DELAY_S = 1.0

# Registers the fake ground modem reports at startup, standing in for what
# helios-cots-telemetry reads off the real one. Values are all inside the
# accepted set in constants.RFD_RANGES / RFD_CHOICES, so the demo starts from a
# config the form itself would accept.
STANDALONE_RFD_CONFIG: dict[str, int] = {
    "min_freq_khz": 902000,
    "max_freq_khz": 928000,
    "net_id": 25,
    "tx_power_dbm": 30,
    "air_speed_kbps": 64,
    "num_channels": 50,
}


def _rfd_config_frame(cfg: dict[str, Any]) -> dict[str, Any]:
    """Build a `current_rfd_config` frame, matching telemetry.normalize_rfd_config."""
    return {
        "type": "rfd_config",
        "config": {k: cfg.get(k) for k in RFD_CONFIG_FIELDS},
        "received_at": time.time(),
    }


def _attach_publisher(
    commands: CommandManager, flight: SyntheticFlight, state: MissionState, hub: ConnectionHub
) -> None:
    """Reflect commands back the way real hardware confirms them.

    Replaces the old CommandAck simulator; both confirmations now arrive on the
    same paths as in LIVE mode. Camera state comes back through the telemetry
    stream (srad.camera). RFD config comes back as a `current_rfd_config` frame,
    standing in for helios-cots-telemetry re-publishing after it writes the
    ground modem — which is what acknowledges the command.
    """

    async def _publish(command_id: int, cmd_type: str, payload: dict[str, Any]) -> None:
        if cmd_type == "camera":

            async def _apply_camera() -> None:
                await asyncio.sleep(CAMERA_APPLY_DELAY_S)
                if "power" in payload:
                    flight.camera["power"] = bool(payload["power"])
                    if not flight.camera["power"]:
                        flight.camera["recording"] = False  # no recording without power
                if "recording" in payload:
                    flight.camera["recording"] = (
                        bool(payload["recording"]) and flight.camera["power"]
                    )

            asyncio.create_task(_apply_camera())

        elif cmd_type == "rfd_config":

            async def _apply_rfd() -> None:
                await asyncio.sleep(RFD_APPLY_DELAY_S)
                current = dict((state.rfd_config_latest or {}).get("config") or {})
                current.update(payload)
                await hub.broadcast(state.ingest_rfd_config(_rfd_config_frame(current)))

            asyncio.create_task(_apply_rfd())

    commands.publish_fn = _publish


async def run_standalone(
    state: MissionState,
    hub: ConnectionHub,
    commands: CommandManager | None = None,
    located: asyncio.Task[None] | None = None,
) -> None:
    ui = state.config.get("ui", {})
    hz = float(ui.get("refresh_hz", 20)) or 20.0
    dt = 1.0 / hz
    # The synthetic rocket has to lift off from the same pad the map marks, so
    # let the (time-bounded) ground-station geolocation settle before sampling
    # coordinates — otherwise the flight starts at the config fallback while the
    # pad marker jumps to wherever this node really is.
    if located is not None:
        with contextlib.suppress(Exception):
            await located
    gs = state.config.get("ground_station", {})
    flight = SyntheticFlight(
        ground_alt_m=gs.get("alt_m", 1401.0),
        base_lat=gs.get("lat", 32.9903),
        base_lon=gs.get("lon", -106.9749),
    )
    if commands is not None:
        _attach_publisher(commands, flight, state, hub)
    callsign = state.config.get("callsign", "N0CALL")
    state.core_connected = True

    # Stand in for helios-cots-telemetry's startup publish of the modem's current
    # registers, so the admin panel has real values to show.
    state.ingest_rfd_config(_rfd_config_frame(STANDALONE_RFD_CONFIG))

    log.info("STANDALONE synthetic flight running at %.0f Hz", hz)
    tick = 0
    aprs_period_ticks = max(1, int(hz / 0.2))  # ~0.2 Hz APRS
    pred_period_ticks = max(1, int(hz / 1.0))   # ~1 Hz landing predictions
    housekeeping_ticks = max(1, int(hz / 4))    # link/mission ~4 Hz

    # Deadline-based pacing: sleep only for the time left until the next tick, not
    # a full `dt` after the work. Sleeping `dt` *after* ingest+broadcast makes the
    # true period `work + dt`, so the delivered rate lands well under `hz` (e.g.
    # ~15 Hz for a nominal 20). Advancing a fixed deadline holds the real rate at
    # `hz` as long as per-tick work stays under `dt`.
    loop = asyncio.get_running_loop()
    next_deadline = loop.time()
    while True:
        frame = flight.step(dt)
        await hub.broadcast(state.ingest_srad(frame))

        if tick % aprs_period_ticks == 0:
            await hub.broadcast(state.ingest_cots(flight.aprs_frame(callsign)))

        if tick % pred_period_ticks == 0:
            pred = flight.landing_prediction()
            if pred is not None:
                await hub.broadcast(state.ingest_landing(pred))

        if tick % housekeeping_ticks == 0:
            await hub.broadcast(state.link_snapshot())
            await hub.broadcast(state.mission_snapshot())

        tick += 1
        next_deadline += dt
        delay = next_deadline - loop.time()
        if delay < 0:
            # Fell behind (work exceeded dt); reset the phase so we don't emit a
            # catch-up burst that would spike the measured rate.
            next_deadline = loop.time()
            delay = 0
        await asyncio.sleep(delay)
