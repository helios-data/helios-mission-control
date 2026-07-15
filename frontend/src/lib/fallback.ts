// Per-source data-state derivation for the universal fallback system (§6.1).
import type { LinkFrame, SourceStatus } from "./telemetry";

export interface DataState {
  status: SourceStatus; // no_data | stale | live
  ageS: number | null;
}

// Smoothly recompute age client-side from last_epoch so "LAST PACKET mm:ss AGO"
// counts up between the backend's 4 Hz link frames.
export function sourceState(
  link: LinkFrame | null,
  source: "srad" | "cots",
  staleAfterS: number,
): DataState {
  const snap = link?.[source];
  if (!snap || snap.count === 0 || snap.last_epoch === null) {
    return { status: "no_data", ageS: null };
  }
  const ageS = Math.max(0, Date.now() / 1000 - snap.last_epoch);
  const status: SourceStatus = ageS > staleAfterS ? "stale" : "live";
  return { status, ageS };
}
