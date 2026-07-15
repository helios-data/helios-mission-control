import { useEffect, useState } from "react";
import { Panel } from "../components/Panel";
import { StateBadge } from "../components/StateBadge";
import { AltitudeChart } from "../components/AltitudeChart";
import { GpsMap } from "../components/GpsMap";
import { getStore, useStore } from "../lib/store";
import { sourceState, type DataState } from "../lib/fallback";
import { useTheme } from "../lib/theme";
import { ThemeToggle } from "../components/ThemeToggle";
import { AudioToggle } from "../components/AudioToggle";
import { useAudioCallouts, useAudioEnabled } from "../lib/audio";
import { api } from "../lib/api";
import { clock, feet, fmt, fmtInt, haversine, M_TO_FT } from "../lib/units";
import { SradPanel, CotsPanel } from "./PacketPanel";
import { CommandConsole } from "./CommandConsole";

const store = getStore("admin");
type Tab = "mission" | "config";

function useUtcClock(): string {
  const [t, setT] = useState(() => new Date().toISOString().slice(11, 19));
  useEffect(() => {
    const id = setInterval(() => setT(new Date().toISOString().slice(11, 19)), 500);
    return () => clearInterval(id);
  }, []);
  return t;
}

export function App() {
  useStore(store);
  const [theme, toggleTheme] = useTheme();
  const [audioOn, toggleAudio] = useAudioEnabled();
  const [tab, setTab] = useState<Tab>("mission");
  useAudioCallouts(store, audioOn);
  const utc = useUtcClock();
  const cfg = store.config;
  const ui = cfg.ui ?? {};
  const sradDs = sourceState(store.link, "srad", ui.srad_stale_seconds ?? 5);
  const cotsDs = sourceState(store.link, "cots", ui.cots_stale_seconds ?? 60);
  const m = store.mission;

  return (
    <div className="admin-page">
      <header className="admin-header">
        <img
          className="logo"
          src={theme === "light" ? "/brand/UBCRocket_Logo_Coloured_Long.png" : "/brand/UBCRocket_Logo_White_Long.png"}
          alt="UBC Rocket"
        />
        <span className="title mono">{cfg.mission_name ?? "MISSION"} · {cfg.event_name ?? ""}</span>
        <nav className="tab-bar">
          <button className={tab === "mission" ? "active" : ""} onClick={() => setTab("mission")}>Mission Control</button>
          <button className={tab === "config" ? "active" : ""} onClick={() => setTab("config")}>Configuration</button>
        </nav>
        <StateBadge state={m?.flight_state} />
        <span className="mono dim" style={{ fontSize: 13 }}>
          T{m?.t_plus_s != null ? "+" : "−"} {clock(m?.t_plus_s ?? m?.t_minus_s ?? null)}
        </span>
        <span className="clock">{utc}Z</span>
        <span className="mono" style={{ fontSize: 11, color: store.connected ? "var(--ok)" : "var(--err)" }}>
          {store.connected ? "WS ●" : "WS ○"}
        </span>
        <AudioToggle on={audioOn} onToggle={toggleAudio} />
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>

      {tab === "mission" ? (
        <MissionTab theme={theme} sradDs={sradDs} cotsDs={cotsDs} />
      ) : (
        <ConfigTab />
      )}
    </div>
  );
}

function MissionTab({ theme, sradDs, cotsDs }: { theme: "dark" | "light"; sradDs: DataState; cotsDs: DataState }) {
  const cfg = store.config;
  const gs = cfg.ground_station;
  const gps = store.srad?.gps;
  let dist = "—", bearing = "—";
  if (gs && gps?.lat != null && gps?.lon != null) {
    const r = haversine(gs.lat, gs.lon, gps.lat, gps.lon);
    dist = `${fmt(r.distance, 0)} m`;
    bearing = `${fmt(r.bearing, 0)}°`;
  }

  return (
    <div className="mc-tab">
      <div className="mc-top">
        <FlightStatePanel live={sradDs.status === "live"} />
        <SradPanel latest={store.srad} ds={sradDs} />
        <CotsPanel latest={store.cots} ds={cotsDs} />
        <RocketStatsPanel downrange={dist} />
      </div>

      <div className="mc-mid">
        <Panel title="Altitude — baro avg AGL / Kalman / COTS" className="mc-panel">
          <div className="mc-fill">
            {sradDs.status === "no_data" ? (
              <div className="empty-note upper" style={{ height: "100%", display: "grid", placeItems: "center" }}>
                Awaiting telemetry
              </div>
            ) : (
              <AltitudeChart store={store} dark={theme === "dark"} fill />
            )}
          </div>
        </Panel>
        <Panel title="GPS Tracks" className="mc-panel"
          right={<span className="mono faint" style={{ fontSize: 11 }}>dist {dist} · brg {bearing}</span>}>
          <div className="mc-fill">
            <GpsMap store={store} theme={theme} fill />
          </div>
        </Panel>
      </div>

      <LinkHealth sradDs={sradDs} cotsDs={cotsDs} />
    </div>
  );
}

function ConfigTab() {
  return (
    <div className="cfg-tab">
      <ConfigPanel />
      <CommandConsole store={store} />
    </div>
  );
}

function FlightStatePanel({ live }: { live: boolean }) {
  const m = store.mission;
  return (
    <Panel title="Flight State & Mission Clock">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <StateBadge state={m?.flight_state} size="lg" live={live} />
        <div className="row-actions">
          <button onClick={() => { const s = prompt("Arm T- countdown seconds", "10"); if (s) api.clock("arm", Number(s)); }}>Arm T−</button>
          <button onClick={() => api.clock("liftoff")}>Force T+0</button>
          <button onClick={() => api.clock("reset")}>Reset clock</button>
        </div>
        <div className="field-table-wrap" style={{ maxHeight: 140 }}>
          <table>
            <thead><tr><th>state</th><th>T+</th><th>UTC</th></tr></thead>
            <tbody>
              {(m?.transitions ?? []).slice().reverse().map((tr, i) => (
                <tr key={i}>
                  <td>{tr.state}</td>
                  <td>{clock(tr.t_plus_s)}</td>
                  <td className="faint">{new Date(tr.at_epoch * 1000).toISOString().slice(11, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

function StatCell({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rs-cell">
      <span className="rs-label">{label}</span>
      <span className="rs-val" style={color ? { color } : undefined}>{value}</span>
      {sub && <span className="rs-sub">{sub}</span>}
    </div>
  );
}

// Mission-control at-a-glance summary: flight-performance peaks + a couple of
// live recovery-relevant numbers. Reads from the mission snapshot + latest SRAD.
function RocketStatsPanel({ downrange }: { downrange: string }) {
  const m = store.mission;
  const s = store.srad;
  const maxV = m?.max_velocity_ms ?? 0;
  const maxAgl = m?.max_altitude_agl_m ?? 0;
  const vv = s?.kf_velocity ?? null;
  return (
    <Panel title="Rocket Stats">
      <div className="rs-grid">
        <StatCell label="Max speed" value={`${fmt(maxV, 0)} m/s`} sub={`${fmt(maxV * M_TO_FT, 0)} ft/s`} />
        <StatCell label="Max Mach" value={fmt(m?.max_mach ?? 0, 2)} />
        <StatCell label="Max alt AGL" value={`${fmt(maxAgl, 0)} m`} sub={feet(maxAgl)} />
        <StatCell label="Max alt MSL" value={`${fmt(m?.max_altitude_msl_m ?? 0, 0)} m`} />
        <StatCell label="Apogee" value={m?.apogee ? `T+${clock(m.apogee.t_plus_s)}` : "—"}
          sub={m?.apogee ? feet(m.apogee.altitude_agl_m) : undefined} />
        <StatCell label="Vert speed" value={vv == null ? "—" : `${fmt(vv, 0)} m/s`}
          sub={vv == null ? undefined : vv >= 0.5 ? "climbing" : vv <= -0.5 ? "descending" : "—"}
          color={vv == null ? undefined : vv >= 0.5 ? "var(--ok)" : vv <= -0.5 ? "var(--accent-cyan)" : undefined} />
        <StatCell label="Downrange" value={downrange} sub="from pad" />
      </div>
    </Panel>
  );
}

function LinkHealth({ sradDs, cotsDs }: { sradDs: DataState; cotsDs: DataState }) {
  return (
    <Panel title="Link Health" className="mc-bottom">
      <div className="link-strip">
        <LinkStat label="core" value={store.link?.core_connected ? "CONNECTED" : "DOWN"}
          color={store.link?.core_connected ? "var(--ok)" : "var(--err)"} />
        <LinkStat label="srad rate" value={`${fmt(store.link?.srad.rate_hz ?? 0, 1)} Hz`} />
        <LinkStat label="srad age" value={sradDs.ageS != null ? `${clock(sradDs.ageS)}` : "—"} />
        <LinkStat label="srad pkts" value={fmtInt(store.link?.srad.count ?? 0)} />
        <LinkStat label="srad errs" value={fmtInt(store.link?.srad.errors ?? 0)}
          color={(store.link?.srad.errors ?? 0) > 0 ? "var(--warn)" : undefined} />
        <LinkStat label="cots rate" value={`${fmt(store.link?.cots.rate_hz ?? 0, 2)} Hz`} />
        <LinkStat label="cots age" value={cotsDs.ageS != null ? `${clock(cotsDs.ageS)}` : "—"} />
        <LinkStat label="cots pkts" value={fmtInt(store.link?.cots.count ?? 0)} />
        <LinkStat label="cots errs" value={fmtInt(store.link?.cots.errors ?? 0)}
          color={(store.link?.cots.errors ?? 0) > 0 ? "var(--warn)" : undefined} />
      </div>
    </Panel>
  );
}

function LinkStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="link-stat">
      <span className="lbl">{label}</span>
      <span className="mono" style={{ color }}>{value}</span>
    </div>
  );
}

function ConfigPanel() {
  const cfg = store.config;
  const rfd = cfg.rfd900x ?? {};
  const [callsign, setCallsign] = useState("");
  useEffect(() => { setCallsign(cfg.callsign ?? ""); }, [cfg.callsign]);
  return (
    <Panel title="Configuration">
      <div className="kv">
        <span className="k">rocket</span><span className="v">{cfg.rocket_name ?? "—"}</span>
        <span className="k">callsign</span>
        <span className="v">
          <input value={callsign} onChange={(e) => setCallsign(e.target.value)}
            onBlur={() => api.patchConfig({ callsign })} style={{ width: 100, textAlign: "right" }} />
        </span>
        <span className="k">expected apogee</span><span className="v">{fmt(cfg.expected_apogee_m ?? 0, 0)} m</span>
        <span className="k">refresh</span><span className="v">{cfg.ui?.refresh_hz ?? "—"} Hz</span>
        <span className="k">video src</span><span className="v">{cfg.ui?.video_source ?? "—"}</span>
        <span className="k">ground alt</span><span className="v">{fmt(cfg.ground_station?.alt_m ?? 0, 0)} m</span>
        <span className="k">RFD net/freq</span>
        <span className="v">{String(rfd.net_id ?? "—")} / {String(rfd.min_freq_khz ?? "—")}–{String(rfd.max_freq_khz ?? "—")}</span>
        <span className="k">RFD tx/air</span>
        <span className="v">{String(rfd.tx_power_dbm ?? "—")}dBm / {String(rfd.air_speed_kbps ?? "—")}kbps</span>
      </div>
    </Panel>
  );
}
