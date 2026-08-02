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

# --- NMEA fix quality (mirrors helios-protos NmeaPosition.FixQuality) --------
# Index = the proto enum value. INVALID (0) means the receiver has no fix, so the
# lat/lon in that sentence are meaningless and the ground station falls back to
# the configured coordinates. Mirrored in frontend/src/lib/telemetry.ts.
NMEA_FIX_QUALITY: tuple[str, ...] = (
    "INVALID",     # 0 - no fix
    "GPS",         # 1 - standard
    "DGPS",        # 2 - differential
    "PPS",         # 3
    "RTK_FIXED",   # 4
    "RTK_FLOAT",   # 5
    "ESTIMATED",   # 6 - dead reckoning
    "MANUAL",      # 7
    "SIMULATION",  # 8
)
NMEA_FIX_INVALID = 0

# Sentence types that can carry a position — mirrors helios-ground-gps
# `decoder.nmea.POSITION_SENTENCES`. Everything else the receiver emits (VTG,
# GSA, GSV, ...) is forwarded as raw text with no Fix, and must NEVER be read as
# "we lost the position": those sentences structurally cannot carry one. Treating
# them as a loss made the ground station strobe back to the configured
# coordinates several times a second, since only ~1 in 4 sentences is positional.
NMEA_POSITION_SENTENCES: frozenset[str] = frozenset({"GGA", "RMC", "GLL"})


def nmea_fix_name(value: object) -> str:
    """Fix-quality enum value (or betterproto enum) -> name, UNKNOWN if out of range."""
    try:
        idx = int(getattr(value, "value", value))
    except (TypeError, ValueError):
        return "UNKNOWN"
    return NMEA_FIX_QUALITY[idx] if 0 <= idx < len(NMEA_FIX_QUALITY) else "UNKNOWN"

# --- RFD900x ground-modem S-register limits (§4.7) ---------------------------
# Accepted values for an `rfd_config` command. Keys must match falcon-protos
# `RfdConfig` exactly -- `helios_bridge._proto_fields` drops anything that isn't
# a real proto field, so an unknown key here would silently no-op.
#
# Mirrored in the frontend at `frontend/src/lib/rfd.ts` (RFD_FIELDS); keep the
# two in sync. The admin form validates before sending, but this is the
# authoritative check: a bad S-register write can take the ground link down.
#
# AIR_SPEED (S2), TXPOWER (S4) and NUM_CHANNELS (S10) are confirmed against the
# RFD900x manual's S-register table. MIN_FREQ / MAX_FREQ (S8/S9) are the 900 MHz
# ISM band edges and have NOT been confirmed against the modem -- check `ATI5`
# before trusting them.
RFD_RANGES: dict[str, tuple[int, int]] = {
    "min_freq_khz": (902000, 927000),  # S8
    "max_freq_khz": (903000, 928000),  # S9
    "net_id": (0, 499),                # S3
    "tx_power_dbm": (0, 30),           # S4  (30 dBm = 1 W)
    "num_channels": (1, 51),           # S10
}
RFD_CHOICES: dict[str, tuple[int, ...]] = {
    # S2, "one-byte form": the value is the rate in kbps, i.e. 64 -> 64000 bps.
    "air_speed_kbps": (12, 56, 64, 100, 125, 188, 200, 224, 500, 750),
}
RFD_FIELDS: frozenset[str] = frozenset(RFD_RANGES) | frozenset(RFD_CHOICES)

# RfdConfig fields in proto declaration order, for reading a reported config off
# the `current_rfd_config` event. Same set as RFD_FIELDS, but ordered.
RFD_CONFIG_FIELDS: tuple[str, ...] = (
    "min_freq_khz", "max_freq_khz", "net_id", "tx_power_dbm", "air_speed_kbps", "num_channels",
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
