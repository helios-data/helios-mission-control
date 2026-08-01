"""Normalizers: betterproto packet -> normalized JSON frame.

These run only when the real protos are compiled (make protos) and packets flow
from the SDK bridge. The STANDALONE generator emits the same schema directly, so
the frontend never sees two shapes.

IMPORTANT: field names below follow the §1.2 description of falcon-protos'
`TelemetryPacket` and helios-protos' `AprsPacket`. They are accessed defensively
(getattr with fallbacks) so a naming mismatch degrades to `None` rather than
crashing — but reconcile them against the real .proto once the submodule lands.
"""

from __future__ import annotations

import time
from typing import Any

from .constants import (
    FT_TO_M,
    KNOTS_TO_MS,
    NMEA_FIX_INVALID,
    RFD_CONFIG_FIELDS,
    flight_state_name,
    nmea_fix_name,
)

MIN_PACKET_BYTES = 15  # skip runts (§1.2 robustness pattern)


def _get(obj: object, *names: str) -> Any:
    for n in names:
        if hasattr(obj, n):
            v = getattr(obj, n)
            if v is not None:
                return v
    return None


def _num(obj: object, *names: str) -> float | None:
    v = _get(obj, *names)
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _int(obj: object, *names: str) -> int | None:
    v = _get(obj, *names)
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _epoch(obj: object, *names: str) -> float | None:
    """A proto ``google.protobuf.Timestamp`` field -> epoch seconds, or None.

    betterproto2 surfaces those as ``datetime``, which is **not** JSON
    serializable — and these frames are required to be plain JSON-able dicts
    (see the module docstring) because they go straight out over the WebSocket.
    Leaking a datetime here silently killed every ``/ws`` connection at the
    snapshot send and put the browser in a 1.5 s reconnect loop. Epoch seconds
    also match `received_at` and the frontend's `timestamp: number | null`.
    """
    v = _get(obj, *names)
    if v is None:
        return None
    ts = getattr(v, "timestamp", None)
    if callable(ts):  # datetime
        try:
            return float(ts())
        except (TypeError, ValueError, OSError):
            return None
    try:
        return float(v)  # already numeric
    except (TypeError, ValueError):
        return None


def normalize_srad(pkt: object) -> dict[str, Any]:
    """betterproto TelemetryPacket -> normalized SRAD frame."""

    def baro(i: int) -> dict[str, Any]:
        p = f"baro{i}_"
        return {
            "healthy": bool(_get(pkt, f"{p}healthy")),
            "pressure": _num(pkt, f"{p}pressure"),
            "temp": _num(pkt, f"{p}temp", f"{p}temperature"),
            "altitude": _num(pkt, f"{p}altitude"),
            "nis": _num(pkt, f"{p}nis"),
            "faults": _get(pkt, f"{p}faults") or 0,
        }

    return {
        "type": "srad",
        "counter": _get(pkt, "counter") or 0,
        "timestamp_ms": _get(pkt, "timestamp_ms") or 0,
        "flight_state": flight_state_name(_get(pkt, "flight_state", "state")),
        "accel": {"x": _num(pkt, "accel_x"), "y": _num(pkt, "accel_y"), "z": _num(pkt, "accel_z")},
        "gyro": {"x": _num(pkt, "gyro_x"), "y": _num(pkt, "gyro_y"), "z": _num(pkt, "gyro_z")},
        "kf_altitude": _num(pkt, "kf_altitude", "kalman_altitude"),
        "kf_velocity": _num(pkt, "kf_velocity", "kalman_velocity"),
        "kf_altitude_var": _num(pkt, "kf_alt_variance", "kf_altitude_variance"),
        "kf_velocity_var": _num(pkt, "kf_vel_variance", "kf_velocity_variance"),
        "baro0": baro(0),
        "baro1": baro(1),
        "ground_altitude": _num(pkt, "ground_altitude") or 0.0,
        # Onboard camera status reported by the FC firmware (confirmation is now
        # baked into telemetry, not a separate CommandAck): the VTX/RunCam power
        # switch and RunCam recording state.
        "camera": {
            "power": bool(_get(pkt, "runcam_power")),
            "recording": bool(_get(pkt, "runcam_recording")),
        },
        "gps": {
            "lat": _num(pkt, "gps_lat", "gps_latitude"),
            "lon": _num(pkt, "gps_lon", "gps_longitude"),
            "alt": _num(pkt, "gps_alt", "gps_altitude"),
            "speed": _num(pkt, "gps_speed"),
            "sats": _get(pkt, "gps_sats", "gps_satellites") or 0,
            "fix": _get(pkt, "gps_fix") or 0,
        },
    }


def _landing_point(p: object) -> dict[str, float] | None:
    """A LandingPoint (lat/lon) -> {"lat","lon"} dict, or None if incomplete/zero."""
    if p is None:
        return None
    lat = _num(p, "lat", "latitude")
    lon = _num(p, "lon", "longitude")
    # 0/0 is the predictor's unset default, not a real coordinate (§ GPS-fix rule).
    if lat is None or lon is None or (lat == 0.0 and lon == 0.0):
        return None
    return {"lat": lat, "lon": lon}


def _landing_points(seq: object) -> list[dict[str, float]]:
    out: list[dict[str, float]] = []
    for p in seq or []:
        pt = _landing_point(p)
        if pt is not None:
            out.append(pt)
    return out


def normalize_landing(pkt: object) -> dict[str, Any]:
    """betterproto LandingPrediction -> normalized prediction frame.

    Published by Helios.Services.LandingPredictor on the ``landing_prediction``
    event. Points are normalized to {"lat","lon"} dicts (0/0 dropped) so the map
    overlay never plots the predictor's unset default. Mirrors PredictionFrame in
    frontend/src/lib/telemetry.ts.
    """
    return {
        "type": "prediction",
        "based_on_packet_counter": _get(pkt, "based_on_packet_counter") or 0,
        "computed_at_ms": _get(pkt, "computed_at_ms") or 0,
        "final": bool(_get(pkt, "final")),
        "best_estimate": _landing_point(_get(pkt, "best_estimate")),
        "dispersion_cloud": _landing_points(_get(pkt, "dispersion_cloud")),
        "ellipse_50": _landing_points(_get(pkt, "ellipse_50")),
        "ellipse_90": _landing_points(_get(pkt, "ellipse_90")),
        "current_lat": _num(pkt, "current_lat"),
        "current_lon": _num(pkt, "current_lon"),
        "current_source": _get(pkt, "current_source"),
        "wind_source": _get(pkt, "wind_source"),
        "descent_model": _get(pkt, "descent_model"),
        "current_alt_agl": _num(pkt, "current_alt_agl"),
        "flight_state": _num(pkt, "flight_state"),
        "status": _get(pkt, "status"),
    }


def normalize_rfd_config(msg: object) -> dict[str, Any]:
    """betterproto RfdConfig -> normalized rfd_config frame.

    Published by helios-cots-telemetry on the ``current_rfd_config`` event: once
    at startup carrying the ground modem's current S-registers, and again after
    each successful write. Every RfdConfig field is `optional`, so a register the
    node didn't report stays ``None`` here rather than defaulting to 0 — the UI
    must be able to tell "unknown" from "actually zero". Mirrors RfdConfigFrame
    in frontend/src/lib/telemetry.ts.
    """
    return {
        "type": "rfd_config",
        "config": {k: _int(msg, k) for k in RFD_CONFIG_FIELDS},
        "received_at": time.time(),
    }


def normalize_ground(pkt: object) -> dict[str, Any]:
    """betterproto NmeaSentence -> normalized ground_position frame.

    Published by ``Helios.Services.GroundGPS`` on the ``ground_position`` event,
    carrying whatever the ground receiver's GNSS is reporting right now. This is
    the live position of the ground station, and it supersedes the configured
    ``ground_station`` coordinates whenever it carries a usable fix.

    ``position`` is set **only** when the sentence actually locates us — the
    payload is a NmeaPosition (not a bare ``raw_sentence``), the fix quality is
    not INVALID, and the coordinates aren't the 0/0 unset default. Anything else
    leaves it ``None``, which is the signal for consumers to fall back to the
    configured coordinates. ``fix_quality``/``fix_quality_name`` are always
    reported so the UI can say *why* there's no fix rather than just going blank.

    Mirrors GroundFrame in frontend/src/lib/telemetry.ts.
    """
    pos = _get(pkt, "position")
    fix_raw = _get(pos, "fix_quality") if pos is not None else None
    fix_q = 0
    try:
        fix_q = int(getattr(fix_raw, "value", fix_raw) or 0)
    except (TypeError, ValueError):
        fix_q = 0

    position: dict[str, Any] | None = None
    if pos is not None and fix_q != NMEA_FIX_INVALID:
        lat = _num(pos, "latitude", "lat")
        lon = _num(pos, "longitude", "lon")
        # 0/0 is the unset default, not a coordinate — same rule as the SRAD GPS
        # and the landing predictor use.
        if lat is not None and lon is not None and not (lat == 0.0 and lon == 0.0):
            spd_kt = _num(pos, "speed_knots", "speed")
            position = {
                "lat": lat,
                "lon": lon,
                "alt_m": _num(pos, "altitude_m", "altitude"),
                "geoid_separation_m": _num(pos, "geoid_separation_m"),
                "course": _num(pos, "course_deg", "course"),
                "speed_knots": spd_kt,
                "speed_ms": round(spd_kt * KNOTS_TO_MS, 2) if spd_kt is not None else None,
                "sats": _int(pos, "satellites_used", "sats"),
                "hdop": _num(pos, "hdop"),
            }

    return {
        "type": "ground",
        "talker_id": _get(pkt, "talker_id"),
        "sentence_type": _get(pkt, "sentence_type"),
        "checksum_valid": bool(_get(pkt, "checksum_valid")),
        # GGA/RMC always carry a UTC time, so this is set on essentially every
        # sentence — it must be JSON-safe. See _epoch.
        "timestamp": _epoch(pkt, "timestamp"),
        "fix_quality": fix_q,
        "fix_quality_name": nmea_fix_name(fix_q),
        "position": position,
        "raw_sentence": _get(pkt, "raw_sentence"),
        "received_at": time.time(),
    }


def normalize_cots(pkt: object) -> dict[str, Any]:
    """betterproto AprsPacket -> normalized COTS frame."""
    pos = _get(pkt, "position")
    position: dict[str, Any] | None = None
    if pos is not None:
        alt_ft = _num(pos, "altitude", "altitude_ft")
        spd_kt = _num(pos, "speed", "speed_knots")
        position = {
            "lat": _num(pos, "lat", "latitude"),
            "lon": _num(pos, "lon", "longitude"),
            "altitude_ft": alt_ft,
            "altitude_m": round(alt_ft * FT_TO_M, 2) if alt_ft is not None else None,
            "course": _num(pos, "course_deg", "course"),
            "speed_knots": spd_kt,
            "speed_ms": round(spd_kt * KNOTS_TO_MS, 2) if spd_kt is not None else None,
            "symbol": _get(pos, "symbol"),
            "comment": _get(pos, "comment"),
        }
    return {
        "type": "cots",
        "source_callsign": _get(pkt, "source_callsign", "source"),
        "source_ssid": _get(pkt, "source_ssid") or 0,
        "destination": _get(pkt, "destination"),
        "path": list(_get(pkt, "digi_path", "path") or []),
        # Optional in AprsPacket and absent on most packet types, which is the
        # only reason this never blew up before NMEA arrived — but on @ and /
        # position reports it is a datetime, so it needs the same treatment.
        "timestamp": _epoch(pkt, "timestamp"),
        "position": position,
        "raw_info": _get(pkt, "raw_info"),
    }
