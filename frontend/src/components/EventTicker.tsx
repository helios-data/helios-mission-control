import { EVENT_META } from "../lib/eventmeta";
import type { MissionEvent } from "../lib/telemetry";
import { clock } from "../lib/units";

// Horizontal strip of auto-detected mission events (overlay).
export function EventTicker({ events }: { events: MissionEvent[] }) {
  if (!events.length) {
    return <div className="event-ticker empty-note">Awaiting mission events</div>;
  }
  return (
    <div className="event-ticker">
      {events.map((e) => {
        const m = EVENT_META[e.type];
        return (
          <span key={e.type} className="event-chip" style={{ borderColor: m.color }}>
            <span style={{ color: m.color }}>{m.label}</span>
            <span className="faint mono"> T+{clock(e.t_plus_s)}</span>
          </span>
        );
      })}
    </div>
  );
}
