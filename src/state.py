"""MissionState: authoritative in-memory state for both endpoints.

Holds the latest SRAD/COTS packets, bounded history rings, per-source link
health, and all server-side derived stats (max altitude/velocity, Mach, apogee,
mission clock, state-transition log). Everything derived lives here so /admin,
/overlay, and any OBS capture agree on the numbers (§3.1).

Frames are plain JSON-able dicts using the normalized schema documented in
docs/telemetry-schema.md and mirrored by frontend/src/lib/telemetry.ts. Both the
real SDK bridge and the STANDALONE generator emit that schema, so nothing below
depends on protobuf being importable.
"""

from __future__ import annotations

import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .constants import mach_estimate

SRAD_RING_DEFAULT = 10_000
COTS_RING_DEFAULT = 5_000

# Standard gravity. The FALCON IMU reports specific force in m/s^2 (~9.81 at
# rest, i.e. 1 g), matching the 3D-attitude convention in Rocket3D.tsx. We divide
# the accel magnitude by this to report G-force in g.
STANDARD_GRAVITY = 9.80665

# FALCON firmware flight states annotated on entry (STANDBY = pre-launch, skipped).
_FLIGHT_STATE_EVENTS = ("ASCENT", "MACH_LOCK", "DROGUE_DESCENT", "MAIN_DESCENT", "LANDED")


def compute_primary_altitude(srad: dict[str, Any]) -> tuple[float, bool]:
    """Return (altitude_msl_m, degraded) per the §3.1 baro rules.

    both baro healthy -> average; one healthy -> that one; neither -> kf_altitude
    (degraded=True).
    """
    b0 = srad.get("baro0", {})
    b1 = srad.get("baro1", {})
    h0, h1 = bool(b0.get("healthy")), bool(b1.get("healthy"))
    a0, a1 = b0.get("altitude"), b1.get("altitude")
    if h0 and h1 and a0 is not None and a1 is not None:
        return (a0 + a1) / 2.0, False
    if h0 and a0 is not None:
        return float(a0), False
    if h1 and a1 is not None:
        return float(a1), False
    kf = srad.get("kf_altitude")
    return (float(kf) if kf is not None else 0.0), True


@dataclass
class StateTransition:
    state: str
    at_epoch: float
    t_plus_s: float | None


@dataclass
class LinkTracker:
    """Per-source freshness + rate tracking, drives the signal indicators."""

    stale_after_s: float
    last_monotonic: float | None = None
    last_epoch: float | None = None
    count: int = 0
    error_count: int = 0
    _rate_hz: float = 0.0

    def mark(self) -> None:
        now = time.monotonic()
        if self.last_monotonic is not None:
            dt = now - self.last_monotonic
            if dt > 0:
                inst = 1.0 / dt
                # EWMA so the rate readout is stable at 10-50 Hz.
                self._rate_hz = inst if self._rate_hz == 0 else 0.8 * self._rate_hz + 0.2 * inst
        self.last_monotonic = now
        self.last_epoch = time.time()
        self.count += 1

    def mark_error(self) -> None:
        self.error_count += 1

    @property
    def age_s(self) -> float | None:
        if self.last_monotonic is None:
            return None
        return time.monotonic() - self.last_monotonic

    @property
    def status(self) -> str:
        age = self.age_s
        if age is None:
            return "no_data"
        return "live" if age <= self.stale_after_s else "stale"

    def snapshot(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "age_s": round(self.age_s, 2) if self.age_s is not None else None,
            "rate_hz": round(self._rate_hz, 1),
            "count": self.count,
            "errors": self.error_count,
            "last_epoch": self.last_epoch,
        }


class MissionState:
    def __init__(
        self,
        config: dict[str, Any],
        srad_ring: int = SRAD_RING_DEFAULT,
        cots_ring: int = COTS_RING_DEFAULT,
    ) -> None:
        self.config = config
        ui = config.get("ui", {})
        self.srad_link = LinkTracker(stale_after_s=ui.get("srad_stale_seconds", 5))
        self.cots_link = LinkTracker(stale_after_s=ui.get("cots_stale_seconds", 60))
        # Landing-prediction node (Helios.Services.LandingPredictor) is low-rate and
        # optional; a generous stale window so a paused predictor reads STALE, not gone.
        self.landing_link = LinkTracker(stale_after_s=ui.get("landing_stale_seconds", 30))
        self.core_connected = False

        self.srad_latest: dict[str, Any] | None = None
        self.cots_latest: dict[str, Any] | None = None
        self.landing_latest: dict[str, Any] | None = None
        self.srad_history: deque[dict[str, Any]] = deque(maxlen=srad_ring)
        self.cots_history: deque[dict[str, Any]] = deque(maxlen=cots_ring)

        # Derived mission stats
        self.flight_state = "STANDBY"
        self.transitions: list[StateTransition] = []
        self.t0_epoch: float | None = None       # liftoff (auto on STANDBY->ASCENT)
        self.t_minus_target_epoch: float | None = None  # manual countdown target
        self.max_altitude_agl_m = 0.0
        self.max_altitude_msl_m = 0.0
        self.max_velocity_ms = 0.0
        self.max_mach = 0.0
        self.max_g = 0.0
        self.apogee: dict[str, Any] | None = None

        # Mission events (one per type) = FALCON firmware flight-state
        # transitions, for chart annotations + the overlay ticker + admin audio.
        self.events: list[dict[str, Any]] = []
        self._event_types: set[str] = set()

        # Sinks (e.g. packet logger) invoked with (source, frame) on every ingest.
        self.sinks: list[Callable[[str, dict[str, Any]], None]] = []

    def subscribe(self, sink: Callable[[str, dict[str, Any]], None]) -> None:
        self.sinks.append(sink)

    def _emit(self, source: str, frame: dict[str, Any]) -> None:
        for sink in self.sinks:
            try:
                sink(source, frame)
            except Exception:  # noqa: BLE001 - a bad sink must not break ingest
                pass

    # ---- ingest ----------------------------------------------------------
    def ingest_srad(self, srad: dict[str, Any]) -> dict[str, Any]:
        """Normalize derived fields, update stats/history, return the enriched frame."""
        msl, degraded = compute_primary_altitude(srad)
        ground = srad.get("ground_altitude") or 0.0
        agl = msl - ground
        srad["altitude_msl_m"] = round(msl, 2)
        srad["altitude_agl_m"] = round(agl, 2)
        srad["altitude_degraded"] = degraded

        vel = float(srad.get("kf_velocity") or 0.0)
        srad["mach"] = round(mach_estimate(abs(vel), msl), 3)

        # G-force = magnitude of the accel vector, converted from m/s^2 to g. The
        # IMU reports specific force (gravity + thrust), so this reads ~1 g at rest.
        accel = srad.get("accel", {})
        ax, ay, az = accel.get("x"), accel.get("y"), accel.get("z")
        if ax is not None and ay is not None and az is not None:
            g_force = math.hypot(ax, ay, az) / STANDARD_GRAVITY
            srad["g_force"] = round(g_force, 3)
        else:
            g_force = None
            srad["g_force"] = None

        self._update_flight_state(srad.get("flight_state", "STANDBY"))

        # Max trackers (only count ascent-region positive altitude for sanity)
        if agl > self.max_altitude_agl_m:
            self.max_altitude_agl_m = agl
        if msl > self.max_altitude_msl_m:
            self.max_altitude_msl_m = msl
        if abs(vel) > self.max_velocity_ms:
            self.max_velocity_ms = abs(vel)
        if srad["mach"] > self.max_mach:
            self.max_mach = srad["mach"]
        if g_force is not None and g_force > self.max_g:
            self.max_g = g_force
        self._detect_apogee(agl)
        self._detect_events(srad, agl)

        srad["t_plus_s"] = self.t_plus_s
        self.srad_latest = srad
        self.srad_history.append(srad)
        self.srad_link.mark()
        self._emit("srad", srad)
        return srad

    def ingest_cots(self, cots: dict[str, Any]) -> dict[str, Any]:
        self.cots_latest = cots
        self.cots_history.append(cots)
        self.cots_link.mark()
        self._emit("cots", cots)
        return cots

    def ingest_landing(self, pred: dict[str, Any]) -> dict[str, Any]:
        """Store the latest landing prediction and mark the predictor link fresh."""
        self.landing_latest = pred
        self.landing_link.mark()
        self._emit("landing", pred)
        return pred

    def record_srad_error(self) -> None:
        self.srad_link.mark_error()

    def record_cots_error(self) -> None:
        self.cots_link.mark_error()

    # ---- derived helpers -------------------------------------------------
    def _update_flight_state(self, new_state: object) -> None:
        state = str(new_state).upper() if not isinstance(new_state, str) else new_state.upper()
        if state == self.flight_state:
            return
        prev = self.flight_state
        self.flight_state = state
        # Auto-start T+ on STANDBY -> ASCENT (liftoff).
        if prev == "STANDBY" and state == "ASCENT" and self.t0_epoch is None:
            self.t0_epoch = time.time()
        self.transitions.append(
            StateTransition(state=state, at_epoch=time.time(), t_plus_s=self.t_plus_s)
        )

    def _detect_apogee(self, agl: float) -> None:
        # Apogee = the max-altitude sample once we've begun descending past it.
        if self.flight_state in ("DROGUE_DESCENT", "MAIN_DESCENT", "LANDED") and self.apogee is None:
            self.apogee = {
                "altitude_agl_m": round(self.max_altitude_agl_m, 2),
                "at_epoch": time.time(),
                "t_plus_s": self.t_plus_s,
            }

    def _add_event(
        self, type_: str, t_plus: float | None, altitude_agl: float, timestamp_ms: int, note: str = ""
    ) -> None:
        if type_ in self._event_types:
            return
        self._event_types.add(type_)
        self.events.append({
            "type": type_,
            "t_plus_s": t_plus,
            "altitude_agl_m": round(altitude_agl, 1),
            "timestamp_ms": timestamp_ms,
            "at_epoch": time.time(),
            "note": note,
        })
        self.events.sort(key=lambda e: (e["timestamp_ms"] or 0))

    def _detect_events(self, srad: dict[str, Any], agl: float) -> None:
        """Emit a mission event on entry into each FALCON firmware flight state.

        Types mirror the TelemetryPacket ``FlightState`` enum (ASCENT, MACH_LOCK,
        DROGUE_DESCENT, MAIN_DESCENT, LANDED) so the altitude-plot annotations,
        overlay ticker, and audio callouts all read the actual onboard states.
        Each fires once, stamped with the current SRAD ``timestamp_ms`` for exact
        chart-x placement.
        """
        state = self.flight_state
        if state in _FLIGHT_STATE_EVENTS:
            self._add_event(state, self.t_plus_s, agl, int(srad.get("timestamp_ms") or 0))

    @property
    def t_plus_s(self) -> float | None:
        if self.t0_epoch is None:
            return None
        return round(time.time() - self.t0_epoch, 2)

    # ---- manual controls (admin) ----------------------------------------
    def arm_countdown(self, seconds_from_now: float) -> None:
        self.t_minus_target_epoch = time.time() + seconds_from_now

    def reset_clock(self) -> None:
        self.t0_epoch = None
        self.t_minus_target_epoch = None

    def force_liftoff(self) -> None:
        self.t0_epoch = time.time()

    # ---- snapshots -------------------------------------------------------
    def link_snapshot(self) -> dict[str, Any]:
        return {
            "type": "link",
            "core_connected": self.core_connected,
            "srad": self.srad_link.snapshot(),
            "cots": self.cots_link.snapshot(),
            "landing": self.landing_link.snapshot(),
        }

    def mission_snapshot(self) -> dict[str, Any]:
        t_minus = None
        if self.t_minus_target_epoch is not None:
            t_minus = round(self.t_minus_target_epoch - time.time(), 2)
        return {
            "type": "mission",
            "flight_state": self.flight_state,
            "t_plus_s": self.t_plus_s,
            "t_minus_s": t_minus,
            "max_altitude_agl_m": round(self.max_altitude_agl_m, 2),
            "max_altitude_msl_m": round(self.max_altitude_msl_m, 2),
            "max_velocity_ms": round(self.max_velocity_ms, 2),
            "max_mach": round(self.max_mach, 3),
            "max_g": round(self.max_g, 2),
            "apogee": self.apogee,
            "events": self.events,
            "transitions": [t.__dict__ for t in self.transitions[-32:]],
        }

    def full_snapshot(self) -> dict[str, Any]:
        """Everything a late-joining client needs to render immediately."""
        return {
            "type": "snapshot",
            "config": self.config,
            "link": self.link_snapshot(),
            "mission": self.mission_snapshot(),
            "srad": self.srad_latest,
            "cots": self.cots_latest,
            "prediction": self.landing_latest,
        }
