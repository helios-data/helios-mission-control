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

from typing import Any

from .constants import FT_TO_M, KNOTS_TO_MS, flight_state_name

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
        "timestamp": _get(pkt, "timestamp"),
        "position": position,
        "raw_info": _get(pkt, "raw_info"),
    }
