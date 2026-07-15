import { statusColor } from "../lib/colors";
import type { SourceStatus } from "../lib/telemetry";
import { clock } from "../lib/units";
import type { DataState } from "../lib/fallback";

export function SignalDot({ status }: { status: SourceStatus }) {
  return <span className={`dot ${status}`} style={{ background: statusColor(status) }} />;
}

// Compact per-source link indicator: dot + label + age.
export function SignalIndicator({ label, state }: { label: string; state: DataState }) {
  const ageTxt =
    state.status === "no_data"
      ? "NO DATA"
      : state.ageS !== null && state.ageS >= 1
        ? `${clock(state.ageS)} AGO`
        : "LIVE";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11 }}>
      <SignalDot status={state.status} />
      <span className="dim upper">{label}</span>
      <span className="mono faint">{ageTxt}</span>
    </span>
  );
}
