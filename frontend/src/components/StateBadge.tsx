import { stateColor } from "../lib/colors";
import type { FlightState } from "../lib/telemetry";

export function StateBadge({
  state, size = "md", live = true,
}: {
  state: FlightState | undefined;
  size?: "md" | "lg";
  live?: boolean;
}) {
  const s = state ?? "UNKNOWN";
  const color = stateColor(s);
  const big = size === "lg";
  return (
    <div
      className={live ? "" : "stale"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: big ? "10px 18px" : "5px 10px",
        border: `1px solid ${color}`,
        borderRadius: 4,
        background: `${color}18`,
      }}
    >
      <span className="dot" style={{ background: color }} />
      <span
        className="mono upper"
        style={{ color, fontSize: big ? 30 : 14, fontWeight: 700, letterSpacing: "0.06em" }}
      >
        {s.replace("_", " ")}
      </span>
    </div>
  );
}
