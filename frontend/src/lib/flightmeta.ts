import type { FlightState } from "./telemetry";

// States during which RFD reconfig is locked out (mirrors backend IN_FLIGHT_STATES).
export const IN_FLIGHT = new Set<FlightState>([
  "ASCENT", "MACH_LOCK", "DROGUE_DESCENT", "MAIN_DESCENT",
]);
