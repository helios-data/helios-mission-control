"""STANDALONE mode: drive the app from an internal synthetic flight (no core).

Enabled with STANDALONE=1. Lets the entire stack (WS, REST, both UIs) run and be
demoed with zero submodules and zero hardware — the same path the frontend is
developed against.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .commands import CommandManager
from .flight_model import SyntheticFlight
from .hub import ConnectionHub
from .state import MissionState

log = logging.getLogger("mission-control.standalone")

# Simulated ground->uplink->FC->telemetry round-trip before a camera command
# shows up as confirmed in the telemetry stream.
CAMERA_APPLY_DELAY_S = 0.4


def _attach_camera_publisher(commands: CommandManager, flight: SyntheticFlight) -> None:
    """Reflect camera commands back into the synthetic flight after a short delay.

    Replaces the old CommandAck simulator: the confirmation now arrives via the
    telemetry stream (srad.camera), just like on real hardware. RFD config is
    ground-local, so there is nothing to reflect for it in STANDALONE.
    """

    async def _publish(command_id: int, cmd_type: str, payload: dict[str, Any]) -> None:
        if cmd_type != "camera":
            return

        async def _apply() -> None:
            await asyncio.sleep(CAMERA_APPLY_DELAY_S)
            if "power" in payload:
                flight.camera["power"] = bool(payload["power"])
                if not flight.camera["power"]:
                    flight.camera["recording"] = False  # no recording without power
            if "recording" in payload:
                flight.camera["recording"] = bool(payload["recording"]) and flight.camera["power"]

        asyncio.create_task(_apply())

    commands.publish_fn = _publish


async def run_standalone(
    state: MissionState, hub: ConnectionHub, commands: CommandManager | None = None
) -> None:
    ui = state.config.get("ui", {})
    hz = float(ui.get("refresh_hz", 20)) or 20.0
    dt = 1.0 / hz
    gs = state.config.get("ground_station", {})
    flight = SyntheticFlight(
        ground_alt_m=gs.get("alt_m", 1401.0),
        base_lat=gs.get("lat", 32.9903),
        base_lon=gs.get("lon", -106.9749),
    )
    if commands is not None:
        _attach_camera_publisher(commands, flight)
    callsign = state.config.get("callsign", "N0CALL")
    state.core_connected = True

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
