import type { EventType } from "./telemetry";

// Display metadata for FALCON firmware flight-state transitions (annotations,
// ticker, audio). Labels/short-codes mirror the TelemetryPacket FlightState enum.
export const EVENT_META: Record<EventType, { label: string; short: string; color: string; say: string }> = {
  ASCENT: { label: "Ascent", short: "ASCENT", color: "#3ddc84", say: "Ascent" },
  MACH_LOCK: { label: "Mach Lock", short: "MACH LOCK", color: "#ffb020", say: "Mach lock" },
  DROGUE_DESCENT: { label: "Drogue Descent", short: "DROGUE", color: "#5ad1ff", say: "Drogue descent" },
  MAIN_DESCENT: { label: "Main Descent", short: "MAIN", color: "#2ad0c0", say: "Main descent" },
  LANDED: { label: "Landed", short: "LANDED", color: "#f2f5f9", say: "Landed" },
};

// Spoken callout for a flight-state transition.
export function eventSpeech(type: EventType, _altitudeAglM: number): string {
  return EVENT_META[type].say;
}
