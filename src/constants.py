"""Shared constants: flight states, colors, unit conversions.

Kept in one place so backend derived stats and the frontend telemetry types
stay in agreement (the frontend mirrors these in lib/telemetry.ts).
"""

from __future__ import annotations

# --- Flight state enum (mirrors falcon-protos TelemetryPacket.FlightState) ---
FLIGHT_STATES: tuple[str, ...] = (
    "STANDBY",
    "ASCENT",
    "MACH_LOCK",
    "DROGUE_DESCENT",
    "MAIN_DESCENT",
    "LANDED",
)

# Per-state accent colors (§4.6 / §6.4). Shared with the frontend.
FLIGHT_STATE_COLORS: dict[str, str] = {
    "STANDBY": "#8a94a6",        # gray
    "ASCENT": "#3ddc84",         # green
    "MACH_LOCK": "#ffb020",      # amber
    "DROGUE_DESCENT": "#4aa3ff", # blue
    "MAIN_DESCENT": "#2ad0c0",   # teal
    "LANDED": "#f2f5f9",         # white
    "UNKNOWN": "#5a6070",
}

# States during which RFD reconfig is locked out unless overridden (§4.7).
IN_FLIGHT_STATES: frozenset[str] = frozenset(
    {"ASCENT", "MACH_LOCK", "DROGUE_DESCENT", "MAIN_DESCENT"}
)

# --- Unit conversions (mirror the rest of the codebase, §1.2) ---
FT_TO_M = 0.3048
KNOTS_TO_MS = 0.514444

# --- Standard atmosphere (for Mach estimate, §6.4) ---
# Speed of sound a = sqrt(gamma * R * T); T from ISA lapse rate.
ISA_SEA_LEVEL_TEMP_K = 288.15
ISA_LAPSE_RATE_K_PER_M = 0.0065
GAMMA = 1.4
R_SPECIFIC_AIR = 287.05  # J/(kg*K)


def speed_of_sound_at_altitude(altitude_m: float) -> float:
    """ISA speed of sound (m/s) at a geopotential altitude, clamped to troposphere."""
    temp_k = ISA_SEA_LEVEL_TEMP_K - ISA_LAPSE_RATE_K_PER_M * max(0.0, min(altitude_m, 11000.0))
    return (GAMMA * R_SPECIFIC_AIR * temp_k) ** 0.5


def mach_estimate(velocity_ms: float, altitude_m: float) -> float:
    a = speed_of_sound_at_altitude(altitude_m)
    return velocity_ms / a if a > 0 else 0.0


# ISA troposphere density (kg/m^3) for dynamic-pressure / max-Q estimation.
ISA_SEA_LEVEL_DENSITY = 1.225
_ISA_DENSITY_EXP = 9.80665 / (ISA_LAPSE_RATE_K_PER_M * R_SPECIFIC_AIR) - 1.0  # ~4.256


def isa_density(altitude_m: float) -> float:
    h = max(0.0, min(altitude_m, 11000.0))
    temp_ratio = (ISA_SEA_LEVEL_TEMP_K - ISA_LAPSE_RATE_K_PER_M * h) / ISA_SEA_LEVEL_TEMP_K
    return ISA_SEA_LEVEL_DENSITY * temp_ratio ** _ISA_DENSITY_EXP


def dynamic_pressure(velocity_ms: float, altitude_m: float) -> float:
    return 0.5 * isa_density(altitude_m) * velocity_ms * velocity_ms


def flight_state_name(value: object) -> str:
    """Normalize a FlightState (int index, enum, or str) to its canonical name."""
    if isinstance(value, str):
        name = value.upper()
        return name if name in FLIGHT_STATES else "UNKNOWN"
    if isinstance(value, int) and 0 <= value < len(FLIGHT_STATES):
        return FLIGHT_STATES[value]
    # betterproto enums stringify to their name; fall back to that.
    name = getattr(value, "name", None)
    if isinstance(name, str) and name.upper() in FLIGHT_STATES:
        return name.upper()
    return "UNKNOWN"
