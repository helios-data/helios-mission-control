"""Pure kinematic flight model shared by STANDALONE mode and sim/replay.py.

Produces a normalized SRAD frame for a real-time synthetic CloudBurst flight:
STANDBY -> boost (~8 g) -> coast -> apogee (~3 km AGL) -> drogue -> main -> LANDED.
No protobuf / SDK dependency, so it runs anywhere.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any

from .constants import mach_estimate

G = 9.80665


@dataclass
class SyntheticFlight:
    ground_alt_m: float = 1401.0
    base_lat: float = 32.9903
    base_lon: float = -106.9749
    liftoff_delay_s: float = 8.0
    burn_time_s: float = 3.0
    boost_g: float = 8.0
    drogue_rate_ms: float = -30.0
    main_deploy_agl_m: float = 300.0
    main_rate_ms: float = -8.0
    post_land_hold_s: float = 20.0

    # integrator state
    t: float = 0.0
    alt_agl: float = 0.0
    vel: float = 0.0
    phase: str = "STANDBY"
    counter: int = 0
    roll_deg: float = 0.0
    _apogee_alt: float = 0.0
    _land_t: float | None = None

    def reset(self) -> None:
        self.t = self.alt_agl = self.vel = 0.0
        self.phase = "STANDBY"
        self.counter = 0
        self.roll_deg = 0.0
        self._apogee_alt = 0.0
        self._land_t = None

    def step(self, dt: float) -> dict[str, Any]:
        """Advance the flight by dt seconds and return a normalized SRAD frame."""
        self.t += dt
        self.counter += 1
        acc_vert = -G  # default: free body

        if self.phase == "STANDBY":
            self.vel = 0.0
            acc_vert = 0.0
            if self.t >= self.liftoff_delay_s:
                self.phase = "ASCENT"
        elif self.phase in ("ASCENT", "MACH_LOCK"):
            burning = self.t < self.liftoff_delay_s + self.burn_time_s
            acc_vert = self.boost_g * G if burning else -G
            self.vel += acc_vert * dt
            self.alt_agl = max(0.0, self.alt_agl + self.vel * dt)
            mach = mach_estimate(abs(self.vel), self.ground_alt_m + self.alt_agl)
            # Demo: also flag MACH_LOCK on high subsonic so the state cycle is visible.
            fast = mach >= 0.9 or self.vel > 200
            self.phase = "MACH_LOCK" if (fast and self.vel > 0) else "ASCENT"
            if self.vel <= 0:  # apogee
                self._apogee_alt = self.alt_agl
                self.phase = "DROGUE_DESCENT"
                self.vel = self.drogue_rate_ms
        elif self.phase == "DROGUE_DESCENT":
            self.vel = self.drogue_rate_ms
            self.alt_agl += self.vel * dt
            acc_vert = 0.0
            if self.alt_agl <= self.main_deploy_agl_m:
                self.phase = "MAIN_DESCENT"
        elif self.phase == "MAIN_DESCENT":
            self.vel = self.main_rate_ms
            self.alt_agl += self.vel * dt
            acc_vert = 0.0
            if self.alt_agl <= 0:
                self.alt_agl = 0.0
                self.vel = 0.0
                self.phase = "LANDED"
                self._land_t = self.t
        elif self.phase == "LANDED":
            self.vel = 0.0
            acc_vert = 0.0
            if self._land_t is not None and self.t - self._land_t > self.post_land_hold_s:
                self.reset()  # loop the demo flight

        self.roll_deg = (self.roll_deg + 120.0 * dt) % 360.0  # steady spin for the 3D model
        return self._frame(acc_vert)

    def _frame(self, acc_vert: float) -> dict[str, Any]:
        alt_msl = self.ground_alt_m + self.alt_agl
        n = lambda s: random.gauss(0, s)  # noqa: E731
        healthy = self.phase != "STANDBY" or True
        baro0_alt = alt_msl + n(1.5)
        baro1_alt = alt_msl + n(1.5)
        # GPS drifts downrange with altitude (rough, for a moving map)
        lat = self.base_lat + self.alt_agl * 1.5e-6
        lon = self.base_lon + self.alt_agl * 1.0e-6
        # Axial axis is Y (matches the 3D model's long axis / world-up convention):
        # gravity+thrust specific force reads on accel.y, roll rate on gyro.y.
        gy = acc_vert / G + 1.0  # axial accel in g including gravity reaction
        return {
            "type": "srad",
            "counter": self.counter,
            "timestamp_ms": int(self.t * 1000),
            "flight_state": self.phase,
            "accel": {"x": n(0.05), "y": round(gy + n(0.05), 3), "z": n(0.05)},
            "gyro": {"x": n(2.0), "y": round(120.0 + n(3.0), 2), "z": n(2.0)},
            "kf_altitude": round(alt_msl + n(0.8), 2),
            "kf_velocity": round(self.vel + n(0.3), 2),
            "kf_altitude_var": 0.5,
            "kf_velocity_var": 0.2,
            "baro0": {"healthy": healthy, "pressure": None, "temp": 20.0,
                      "altitude": round(baro0_alt, 2), "nis": 0.4, "faults": 0},
            "baro1": {"healthy": healthy, "pressure": None, "temp": 20.0,
                      "altitude": round(baro1_alt, 2), "nis": 0.5, "faults": 0},
            "ground_altitude": self.ground_alt_m,
            "gps": {"lat": round(lat, 6), "lon": round(lon, 6),
                    "alt": round(alt_msl, 1), "speed": round(abs(self.vel), 1),
                    "sats": 12, "fix": 3},
        }

    def aprs_frame(self, callsign: str = "N0CALL") -> dict[str, Any]:
        """A COTS/APRS position sample offset slightly from the SRAD fix."""
        alt_m = self.ground_alt_m + self.alt_agl + random.gauss(0, 5)
        lat = self.base_lat + self.alt_agl * 1.5e-6 + random.gauss(0, 2e-5)
        lon = self.base_lon + self.alt_agl * 1.0e-6 + random.gauss(0, 2e-5)
        return {
            "type": "cots",
            "source_callsign": callsign,
            "source_ssid": 11,
            "destination": "APRS",
            "path": ["WIDE1-1", "WIDE2-1"],
            "timestamp": None,
            "position": {
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "altitude_ft": round(alt_m / 0.3048, 1),
                "altitude_m": round(alt_m, 2),
                "course": round(random.uniform(0, 360), 1),
                "speed_knots": round(abs(self.vel) / 0.514444, 1),
                "speed_ms": round(abs(self.vel), 2),
                "symbol": "/O",
                "comment": "CloudBurst COTS APRS",
            },
            "raw_info": None,
        }
