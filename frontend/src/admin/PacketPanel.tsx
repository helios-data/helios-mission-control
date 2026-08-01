import { useState } from "react";
import { Panel } from "../components/Panel";
import { SignalIndicator } from "../components/SignalDot";
import { api } from "../lib/api";
import type { DataState } from "../lib/fallback";
import type { CotsFrame, SradFrame } from "../lib/telemetry";
import { fmt, fmtInt, fmtLatLon } from "../lib/units";

function LogControls({ source }: { source: "srad" | "cots" }) {
  const [recording, setRecording] = useState(false);
  const [msg, setMsg] = useState("");
  return (
    <div className="row-actions">
      <button onClick={async () => setMsg((await api.logNow(source) as { file?: string }).file ?? "logged")}>
        Log now
      </button>
      <button
        className={recording ? "rec" : ""}
        onClick={async () => {
          await api.record(source, recording ? "stop" : "start");
          setRecording(!recording);
        }}
      >
        {recording ? "● Recording — Stop" : "Record"}
      </button>
      <a href={`/api/logs`} target="_blank" rel="noreferrer">
        <button>Logs ▾</button>
      </a>
      {msg && <span className="faint mono" style={{ fontSize: 11 }}>saved {msg}</span>}
    </div>
  );
}

function Field({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <>
      <span className="k">{k}</span>
      <span className="v" style={warn ? { color: "var(--err)" } : undefined}>{v}</span>
    </>
  );
}

export function SradPanel({ latest, ds }: { latest: SradFrame | null; ds: DataState }) {
  const stale = ds.status === "stale";
  return (
    <Panel title="SRAD · FALCON Telemetry" right={<SignalIndicator label="srad" state={ds} />}>
      {ds.status === "no_data" || !latest ? (
        <div className="empty-note upper">No packets received</div>
      ) : (
        <div className={stale ? "stale" : ""}>
          <div className="kv">
            <Field k="counter" v={fmtInt(latest.counter)} />
            <Field k="state" v={latest.flight_state} />
            <Field k="alt AGL" v={`${fmt(latest.altitude_agl_m)} m`} warn={latest.altitude_degraded} />
            <Field k="alt MSL" v={`${fmt(latest.altitude_msl_m)} m`} />
            <Field k="kf alt / vel" v={`${fmt(latest.kf_altitude)} / ${fmt(latest.kf_velocity)}`} />
            <Field k="mach" v={fmt(latest.mach, 2)} />
            <Field k="accel xyz" v={`${fmt(latest.accel.x, 2)}, ${fmt(latest.accel.y, 2)}, ${fmt(latest.accel.z, 2)}`} />
            <Field k="gyro xyz" v={`${fmt(latest.gyro.x, 1)}, ${fmt(latest.gyro.y, 1)}, ${fmt(latest.gyro.z, 1)}`} />
            <Field k="baro0" v={`${latest.baro0.healthy ? "OK" : "FAULT"} ${fmt(latest.baro0.altitude)}m`} warn={!latest.baro0.healthy} />
            <Field k="baro1" v={`${latest.baro1.healthy ? "OK" : "FAULT"} ${fmt(latest.baro1.altitude)}m`} warn={!latest.baro1.healthy} />
            <Field k="ground alt" v={`${fmt(latest.ground_altitude)} m`} />
            <Field k="gps" v={`${fmtLatLon(latest.gps.lat)}, ${fmtLatLon(latest.gps.lon)}`} />
            <Field k="gps fix/sats" v={`fix ${latest.gps.fix} · ${latest.gps.sats} sats`} warn={latest.gps.fix < 2} />
            <Field k="camera" v={`VTX ${(latest.camera?.power ? "ON" : "OFF")} · REC ${(latest.camera?.recording ? "ON" : "OFF")}`} />
          </div>
        </div>
      )}
      <LogControls source="srad" />
    </Panel>
  );
}

// An APRS packet whose payload oneof is `raw_info` rather than `position` — a
// status/telemetry beacon, or a position beacon sent before the tracker locked.
// The packet is real and is logged like any other; it just doesn't locate the
// rocket, so the panel says so instead of silently showing the last known fix.
function NoFixChip() {
  return (
    <span
      className="mono"
      title="This APRS packet carried no position (raw info only). The packet is still received and logged; the map keeps the last known fix."
      style={{
        fontSize: 10, letterSpacing: "0.06em", padding: "1px 5px", borderRadius: 3,
        border: "1px solid var(--warn)", color: "var(--warn)",
        background: "rgba(255,176,32,0.12)",
      }}
    >
      NO FIX
    </span>
  );
}

export function CotsPanel({ latest, ds }: { latest: CotsFrame | null; ds: DataState }) {
  const stale = ds.status === "stale";
  const p = latest?.position;
  const noFix = !!latest && !p;
  return (
    <Panel
      title="COTS · TeleGPS APRS"
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {noFix && <NoFixChip />}
          <SignalIndicator label="cots" state={ds} />
        </span>
      }
    >
      {ds.status === "no_data" || !latest ? (
        <div className="empty-note upper">No packets received</div>
      ) : (
        <div className={stale ? "stale" : ""}>
          <div className="kv">
            <Field k="source" v={latest.source_callsign ?? "—"} />
            <Field k="dest" v={latest.destination ?? "—"} />
            <Field k="path" v={latest.path.join(" > ") || "—"} />
            {p ? (
              <>
                <Field k="position" v={`${fmtLatLon(p.lat)}, ${fmtLatLon(p.lon)}`} />
                <Field k="altitude" v={`${fmt(p.altitude_m)} m (${fmtInt(p.altitude_ft)} ft)`} />
                <Field k="speed" v={`${fmt(p.speed_ms)} m/s (${fmt(p.speed_knots)} kt)`} />
                <Field k="course" v={fmt(p.course, 0) + "°"} />
                <Field k="comment" v={p.comment ?? "—"} />
              </>
            ) : (
              <Field k="raw_info" v={latest.raw_info ?? "(non-position packet)"} />
            )}
          </div>
        </div>
      )}
      <LogControls source="cots" />
    </Panel>
  );
}
