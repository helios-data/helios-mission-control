import type { FlightState, SourceStatus } from "./telemetry";

// Per-state accent colors — must match backend constants.FLIGHT_STATE_COLORS.
export const FLIGHT_STATE_COLORS: Record<FlightState, string> = {
  STANDBY: "#8a94a6",
  ASCENT: "#3ddc84",
  MACH_LOCK: "#ffb020",
  DROGUE_DESCENT: "#4aa3ff",
  MAIN_DESCENT: "#2ad0c0",
  LANDED: "#f2f5f9",
  UNKNOWN: "#5a6070",
};

export function stateColor(s: FlightState | undefined): string {
  return FLIGHT_STATE_COLORS[s ?? "UNKNOWN"] ?? FLIGHT_STATE_COLORS.UNKNOWN;
}

// Signal-dot colors for per-source link health.
export const STATUS_COLORS: Record<SourceStatus, string> = {
  live: "#3ddc84",
  stale: "#ffb020",
  no_data: "#e0555f",
};

export function statusColor(s: SourceStatus | undefined): string {
  return STATUS_COLORS[s ?? "no_data"];
}

// Chart series colors.
export const SERIES = {
  baroAvg: "#5ad1ff",
  kf: "#8b93a7",
  baro0: "#3d6b8a",
  baro1: "#6a4f8a",
  cots: "#ffb020",
  expected: "#4a5568",
  sradTrack: "#5ad1ff",
  cotsTrack: "#ffb020",
};
