"""Pure kinematic flight model shared by STANDALONE mode and sim/replay.py.

Produces a normalized SRAD frame for a real-time synthetic CloudBurst flight:
STANDBY -> boost (~8 g) -> coast -> apogee (~3 km AGL) -> drogue -> main -> LANDED.
No protobuf / SDK dependency, so it runs anywhere.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from typing import Any

from .constants import FLIGHT_STATES, mach_estimate

G = 9.80665

# Synthetic landing-prediction model (the real estimator is a separate node,
# Helios.Services.LandingPredictor). A nominal wind carries the rocket downwind
# during descent; the uncertainty zone shrinks as remaining altitude drops.
_PRED_DESCENT_RATE_MS = 8.0     # nominal descent rate for the time-aloft estimate
_PRED_WIND_SPEED_MS = 6.0
_PRED_WIND_BEARING_DEG = 65.0   # direction the wind pushes the rocket (ENE)

# LandingPrediction.status values (mirror the predictor node / proto docs).
STATUS_NOT_DESCENDING = "not_descending"
STATUS_PREDICTING = "predicting"
STATUS_FINAL = "final"

# The sim only estimates a landing point once the rocket is past apogee (i.e.
# descending). Before that there is no meaningful touchdown estimate to publish.
_POST_APOGEE_PHASES = ("DROGUE_DESCENT", "MAIN_DESCENT", "LANDED")

# Synthetic ground-station GNSS (the real source is Helios.Services.GroundGPS).
# The receiver takes a few seconds to lock, so the demo starts on the configured
# fallback and switches to live — and it sits a short way off the pad, since the
# operator's table is not the launch rail.
_GROUND_ACQUIRE_S = 3.0
# One second of a real receiver's output, in order (see the GPS serial capture in
# .claude/memory). Only GGA and RMC carry a position; VTG/GSA/GSV are raw text.
_GROUND_SENTENCE_CYCLE = ("VTG", "GGA", "GSA", "RMC", "GSV")
_GROUND_OFFSET_N_M = 35.0
_GROUND_OFFSET_E_M = -20.0


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
    # Onboard camera switch state, mutated by ground commands in STANDALONE so the
    # telemetry stream confirms them (there is no separate CommandAck). Persists
    # across flight loops — it is a physical switch, not integrator state.
    camera: dict[str, bool] = field(default_factory=lambda: {"power": False, "recording": False})

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
        # Axial axis is Z (nose = +Z, matching the real FALCON IMU and Rocket3D).
        # The IMU reports the gravity vector, so the axial reads -1 g at rest
        # (accel points "down" the nose), roll rate on gyro.z.
        gz = -(acc_vert + G)  # axial accel in m/s^2, ~-9.81 (= -1 g) at rest
        return {
            "type": "srad",
            "counter": self.counter,
            "timestamp_ms": int(self.t * 1000),
            "flight_state": self.phase,
            "accel": {"x": n(0.05), "y": n(0.05), "z": round(gz + n(0.05), 3)},
            "gyro": {"x": n(2.0), "y": n(2.0), "z": round(120.0 + n(3.0), 2)},
            "kf_altitude": round(alt_msl + n(0.8), 2),
            "kf_velocity": round(self.vel + n(0.3), 2),
            "kf_altitude_var": 0.5,
            "kf_velocity_var": 0.2,
            "baro0": {"healthy": healthy, "pressure": None, "temp": 20.0,
                      "altitude": round(baro0_alt, 2), "nis": 0.4, "faults": 0},
            "baro1": {"healthy": healthy, "pressure": None, "temp": 20.0,
                      "altitude": round(baro1_alt, 2), "nis": 0.5, "faults": 0},
            "ground_altitude": self.ground_alt_m,
            "camera": {"power": self.camera["power"], "recording": self.camera["recording"]},
            "gps": {"lat": round(lat, 6), "lon": round(lon, 6),
                    "alt": round(alt_msl, 1), "speed": round(abs(self.vel), 1),
                    "sats": 12, "fix": 3},
        }

    def landing_prediction(
        self, wind_override: tuple[float, float] | None = None
    ) -> dict[str, Any] | None:
        """A synthetic LandingPrediction frame (mirrors telemetry.normalize_landing).

        Returns None until the rocket is past apogee — the sim only estimates a
        touchdown once descending (DROGUE/MAIN/LANDED). The predicted point sits
        downwind of the pad and its 50/90% ellipses + dispersion cloud tighten as
        the rocket descends, matching what the real LandingPredictor node publishes.

        ``wind_override`` is ``(speed_ms, from_deg)`` — a manual wind the operator
        set via LandingConfig, met convention (direction it comes FROM). When set,
        the estimate uses it and the frame reports ``wind_source = "manual"``;
        otherwise it uses the model's nominal live wind. This is what closes the
        override loop in STANDALONE (the real predictor does the same over RF).
        """
        if self.phase not in _POST_APOGEE_PHASES:
            return None

        if wind_override is not None:
            wind_speed, wind_from_deg = wind_override
            # Internally we work in the "toward" bearing the wind pushes the rocket.
            wind_toward_deg = (wind_from_deg + 180.0) % 360.0
            wind_mode = "manual"
        else:
            wind_speed = _PRED_WIND_SPEED_MS
            wind_toward_deg = _PRED_WIND_BEARING_DEG
            wind_from_deg = (wind_toward_deg + 180.0) % 360.0
            wind_mode = "live"

        remaining = max(0.0, self.alt_agl)
        time_aloft = remaining / _PRED_DESCENT_RATE_MS
        drift_m = wind_speed * time_aloft
        br = math.radians(wind_toward_deg)
        m_per_deg_lat = 111320.0
        m_per_deg_lon = 111320.0 * math.cos(math.radians(self.base_lat))

        landed = self.phase == "LANDED"
        # Ground track returns toward the pad as alt->0 in this toy model; the wind
        # offsets the touchdown from it. Once landed, freeze on the pad.
        best_lat = self.base_lat + (0.0 if landed else drift_m * math.cos(br) / m_per_deg_lat)
        best_lon = self.base_lon + (0.0 if landed else drift_m * math.sin(br) / m_per_deg_lon)

        r90 = 0.0 if landed else max(25.0, remaining * 0.25 + drift_m * 0.4)
        r50 = r90 * 0.6

        def ring(radius: float) -> list[dict[str, float]]:
            if radius <= 0:
                return [{"lat": round(best_lat, 6), "lon": round(best_lon, 6)}]
            pts: list[dict[str, float]] = []
            for i in range(24):
                th = 2 * math.pi * i / 24
                along = radius * 1.4 * math.cos(th)   # elongated down-range (wind axis)
                cross = radius * 0.7 * math.sin(th)
                e = along * math.sin(br) + cross * math.cos(br)
                n = along * math.cos(br) - cross * math.sin(br)
                pts.append({"lat": round(best_lat + n / m_per_deg_lat, 6),
                            "lon": round(best_lon + e / m_per_deg_lon, 6)})
            return pts

        cloud: list[dict[str, float]] = []
        if not landed:
            for _ in range(40):
                n = random.gauss(0, r90 * 0.5)
                e = random.gauss(0, r90 * 0.5)
                cloud.append({"lat": round(best_lat + n / m_per_deg_lat, 6),
                              "lon": round(best_lon + e / m_per_deg_lon, 6)})

        return {
            "type": "prediction",
            "based_on_packet_counter": self.counter,
            "computed_at_ms": int(self.t * 1000),
            "final": landed,
            "best_estimate": {"lat": round(best_lat, 6), "lon": round(best_lon, 6)},
            "dispersion_cloud": cloud,
            "ellipse_50": ring(r50),
            "ellipse_90": ring(r90),
            "current_lat": round(self.base_lat + self.alt_agl * 1.5e-6, 6),
            "current_lon": round(self.base_lon + self.alt_agl * 1.0e-6, 6),
            "current_source": "srad",
            "wind_source": wind_mode,
            "wind_speed_ms": round(wind_speed, 1),
            "wind_dir_deg": round(wind_from_deg, 1),
            "descent_model": "constant",
            "current_alt_agl": round(remaining, 2),
            "flight_state": float(FLIGHT_STATES.index(self.phase)) if self.phase in FLIGHT_STATES else -1.0,
            "status": STATUS_FINAL if landed else STATUS_PREDICTING,
        }

    def ground_frame(self) -> dict[str, Any]:
        """A synthetic ground-receiver NMEA sentence (mirrors telemetry.normalize_ground).

        Models a real GNSS receiver at the ground station: no fix for the first
        few seconds while it acquires (which exercises the fall-back to the
        configured coordinates), then a GPS fix that wanders a couple of metres
        sample to sample. The receiver sits a short distance off the configured
        pad — as it would in reality, being at the operator's table rather than on
        the rail — so it is visibly the live source rather than an echo of config.

        Alternates GGA and RMC: only GGA carries altitude, so the RMC samples
        exercise the "keep the configured elevation" branch in
        MissionState.ground_station.
        """
        # Walk the receiver's real sentence cycle rather than alternating two
        # position sentences: a u-blox-class receiver emits VTG, GGA, GSA, RMC
        # (+ occasional GSV) once a second, and only GGA/RMC carry a position at
        # all. Reproducing that here is what makes the "flashes back to config"
        # bug visible in STANDALONE instead of only against real hardware.
        self._ground_seq = getattr(self, "_ground_seq", -1) + 1
        kind = _GROUND_SENTENCE_CYCLE[self._ground_seq % len(_GROUND_SENTENCE_CYCLE)]
        acquiring = self.t < _GROUND_ACQUIRE_S
        gga = kind == "GGA"
        if kind not in ("GGA", "RMC"):
            # Non-positional sentence: raw text only, exactly as helios-ground-gps
            # forwards it. Must not disturb the ground station's position.
            return {
                "type": "ground", "talker_id": "GP", "sentence_type": kind,
                "checksum_valid": True, "timestamp": time.time(),
                "fix_quality": 0, "fix_quality_name": "INVALID",
                "position": None,
                "raw_sentence": f"$GP{kind},0.00,T,,M,0.00,N,0.00,K,N*32",
            }
        if acquiring:
            # Receiver alive but not yet locked. A real one still emits GGA/RMC,
            # just with the coordinate fields empty (GGA quality 0, RMC status V)
            # — see the serial capture in .claude/memory — and helios-ground-gps
            # forwards those as raw_sentence because there is no Fix to decode.
            # Keeping the real sentence_type exercises the "positional sentence
            # reporting no fix" path rather than inventing a GSV.
            return {
                "type": "ground", "talker_id": "GP", "sentence_type": kind,
                "checksum_valid": True, "timestamp": time.time(),
                "fix_quality": 0, "fix_quality_name": "INVALID",
                "position": None,
                "raw_sentence": ("$GPGGA,235957.800,,,,,0,00,,,M,,M,,*7F" if gga
                                 else "$GPRMC,235957.800,V,,,,,0.00,0.00,050180,,,N*46"),
                "received_at": time.time(),
            }
        m_per_deg_lat = 111320.0
        m_per_deg_lon = 111320.0 * math.cos(math.radians(self.base_lat))
        lat = self.base_lat + (_GROUND_OFFSET_N_M + random.gauss(0, 1.5)) / m_per_deg_lat
        lon = self.base_lon + (_GROUND_OFFSET_E_M + random.gauss(0, 1.5)) / m_per_deg_lon
        return {
            "type": "ground",
            "talker_id": "GN",
            "sentence_type": "GGA" if gga else "RMC",
            "checksum_valid": True,
            # Real GGA/RMC always carry a UTC time; epoch seconds here to match
            # what telemetry._epoch produces from the proto's Timestamp.
            "timestamp": time.time(),
            "fix_quality": 1,
            "fix_quality_name": "GPS",
            "position": {
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                # RMC carries no altitude — leave it None so the configured
                # elevation is kept rather than blanked.
                "alt_m": round(self.ground_alt_m + random.gauss(0, 0.8), 1) if gga else None,
                "geoid_separation_m": -22.4 if gga else None,
                "course": None,
                "speed_knots": 0.0,
                "speed_ms": 0.0,
                "sats": random.randint(9, 13),
                "hdop": round(random.uniform(0.7, 1.3), 1),
            },
            "raw_sentence": None,
        }

    def aprs_frame(self, callsign: str = "N0CALL", with_position: bool = True) -> dict[str, Any]:
        """A COTS/APRS sample offset slightly from the SRAD fix.

        ``with_position=False`` produces a non-position packet (status/telemetry),
        i.e. the ``raw_info`` arm of AprsPacket's payload oneof — the shape the
        admin panel flags as NO FIX and which must still log as a packet.
        """
        if not with_position:
            return {
                "type": "cots",
                "source_callsign": callsign,
                "source_ssid": 11,
                "destination": "APRS",
                "path": ["WIDE1-1", "WIDE2-1"],
                "timestamp": None,
                "position": None,
                "raw_info": ">CloudBurst status: batt 8.02V, no GPS lock",
            }
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
