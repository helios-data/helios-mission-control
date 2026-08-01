import { useEffect, useState } from "react";
import { Panel } from "../components/Panel";
import { StateBadge } from "../components/StateBadge";
import { AltitudeChart } from "../components/AltitudeChart";
import { GpsMap } from "../components/GpsMap";
import { getStore, useStore, hasGpsFix } from "../lib/store";
import { sourceState, type DataState } from "../lib/fallback";
import { useTheme } from "../lib/theme";
import { ThemeToggle } from "../components/ThemeToggle";
import { AudioToggle } from "../components/AudioToggle";
import { useAudioCallouts, useAudioEnabled } from "../lib/audio";
import { api } from "../lib/api";
import { dbmToWatts, formatWatts } from "../lib/rfd";
import { clock, feet, fmt, fmtInt, fmtLatLon, haversine, M_TO_FT } from "../lib/units";
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
  const [autoFit, setAutoFit] = useState(true);
  // Live GNSS position when the ground receiver has a fix, configured pad
  // otherwise — so downrange/bearing are measured from where we actually are.
  const gs = store.groundStation();
  const gps = store.srad?.gps;
  let dist = "—", bearing = "—";
  // 0,0 is the flight computer's pre-lock default, not a real position — don't
  // let it produce a bogus ~thousands-of-km downrange reading.
  if (gs.lat != null && gs.lon != null && hasGpsFix(gps?.lon, gps?.lat)) {
    const r = haversine(gs.lat, gs.lon, gps!.lat!, gps!.lon!);
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
        <LandingPredictionPanel />
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
          right={
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                className="mono"
                onClick={() => setAutoFit((v) => !v)}
                title="Auto-fit the map to the rocket + landing zone (re-fits as it grows or shrinks)"
                style={{
                  fontSize: 10, letterSpacing: "0.06em", padding: "1px 6px", borderRadius: 3, cursor: "pointer",
                  border: `1px solid ${autoFit ? "var(--accent-cyan)" : "rgba(140,148,166,0.5)"}`,
                  background: autoFit ? "rgba(90,209,255,0.14)" : "transparent",
                  color: autoFit ? "var(--accent-cyan)" : "var(--text-dim)",
                }}
              >
                AUTO-FIT {autoFit ? "●" : "○"}
              </button>
              <span className="mono faint" style={{ fontSize: 11 }}>dist {dist} · brg {bearing}</span>
            </span>
          }>
          <div className="mc-fill">
            <GpsMap store={store} theme={theme} fill showPrediction autoFit={autoFit} />
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
  const g = s?.g_force ?? null;
  return (
    <Panel title="Rocket Stats">
      <div className="rs-grid">
        <StatCell label="Current G" value={g == null ? "—" : `${fmt(g, 1)} g`} />
        <StatCell label="Max G" value={`${fmt(m?.max_g ?? 0, 1)} g`} />
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

// Human labels/colors for the LandingPrediction status enum.
const PRED_STATUS: Record<string, { label: string; color: string }> = {
  final: { label: "FINAL", color: "var(--ok)" },
  predicting: { label: "PREDICTING", color: "var(--accent-cyan)" },
  not_descending: { label: "PRE-DESCENT", color: "var(--text-dim)" },
};

// Expected landing zone from Helios.Services.LandingPredictor: predicted touchdown
// coordinates + distance from pad, downrange-to-landing, and the 90% zone size.
// Before the rocket flies there is no touchdown estimate to show, so on the pad
// this slot carries the ground station's own GNSS instead — the operator's most
// useful pre-launch numbers (are we located, how good is the fix) in the space
// that would otherwise read "Awaiting prediction" for the whole countdown.
function GroundStationStats() {
  const gs = store.groundStation();
  const g = store.ground;
  const pos = g?.position ?? null;
  const live = gs.source === "gnss";
  return (
    <div className="rs-grid">
      <StatCell label="Pad lat" value={fmtLatLon(gs.lat)} />
      <StatCell label="Pad lon" value={fmtLatLon(gs.lon)} />
      <StatCell label="Elevation" value={gs.alt_m != null ? `${fmt(gs.alt_m, 0)} m` : "—"}
        sub={pos?.alt_m != null ? "from GNSS" : "from config"} />
      <StatCell
        label="Fix"
        value={g?.fix_quality_name ?? "NO DATA"}
        sub={g ? `${g.talker_id ?? "--"}${g.sentence_type ?? ""}` : "no NMEA yet"}
        color={live ? "var(--ok)" : "var(--warn)"}
      />
      <StatCell label="Satellites" value={pos?.sats != null ? String(pos.sats) : "—"} />
      <StatCell label="HDOP" value={pos?.hdop != null ? fmt(pos.hdop, 1) : "—"}
        sub={pos?.hdop != null && pos.hdop <= 2 ? "good" : undefined} />
      <StatCell
        label="Source"
        value={live ? "GNSS" : "CONFIG"}
        sub={live ? "live receiver" : "fallback"}
        color={live ? "var(--ok)" : "var(--warn)"}
      />
      <StatCell label="Checksum" value={g ? (g.checksum_valid ? "OK" : "BAD") : "—"}
        color={g && !g.checksum_valid ? "var(--err)" : undefined} />
    </div>
  );
}

function LandingPredictionPanel() {
  const lp = store.activeLanding();
  const gs = store.groundStation();
  const best = lp?.best_estimate ?? null;
  // Pre-launch, with nothing predicted yet, show the ground station instead.
  const showGround = !best && store.mission?.flight_state === "STANDBY";

  let fromPad = "—", brg = "—", downrange = "—", zone = "—";
  if (best && gs.lat != null && gs.lon != null) {
    const r = haversine(gs.lat, gs.lon, best.lat, best.lon);
    fromPad = `${fmt(r.distance, 0)} m`;
    brg = `${fmt(r.bearing, 0)}°`;
  }
  const cur = store.srad?.gps;
  if (best && hasGpsFix(cur?.lon, cur?.lat)) {
    downrange = `${fmt(haversine(cur!.lat!, cur!.lon!, best.lat, best.lon).distance, 0)} m`;
  }
  // 90% zone radius ≈ farthest ellipse vertex from the best estimate.
  if (best && lp && lp.ellipse_90.length) {
    const maxR = Math.max(...lp.ellipse_90.map((p) => haversine(best.lat, best.lon, p.lat, p.lon).distance));
    zone = `±${fmt(maxR, 0)} m`;
  }
  const st = lp?.status
    ? PRED_STATUS[lp.status] ?? { label: lp.status.toUpperCase(), color: "var(--text-dim)" }
    : null;

  return (
    <Panel
      title={showGround ? "Ground Station · GNSS" : "Landing Prediction"}
      right={
        showGround ? (
          <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>PRE-LAUNCH</span>
        ) : st ? (
          <span className="mono" style={{ fontSize: 11, color: st.color }}>{st.label}</span>
        ) : undefined
      }>
      {showGround ? (
        <GroundStationStats />
      ) : !lp || !best ? (
        <div className="empty-note" style={{ padding: "12px 4px", color: "var(--text-dim)", fontSize: 12 }}>
          Awaiting prediction
        </div>
      ) : (
        <div className="rs-grid">
          <StatCell label="Pred lat" value={fmtLatLon(best.lat)} />
          <StatCell label="Pred lon" value={fmtLatLon(best.lon)} />
          <StatCell label="From pad" value={fromPad} sub={`brg ${brg}`} />
          <StatCell label="Remaining" value={downrange} sub="to landing" />
          <StatCell label="90% zone" value={zone} color={lp.final ? "var(--ok)" : undefined} />
          <StatCell label="Descent alt" value={lp.current_alt_agl != null ? `${fmt(lp.current_alt_agl, 0)} m` : "—"} />
          <StatCell label="Model" value={lp.descent_model ?? "—"} sub={`wind ${lp.wind_source ?? "—"}`} />
          <StatCell label="Source" value={(lp.current_source ?? "—").toUpperCase()} sub={`pkt ${lp.based_on_packet_counter}`} />
        </div>
      )}
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
        {/* Ground GNSS: an optional node, so "no_data" here means not deployed —
            distinct from deployed-but-unlocked, which shows a fix quality. */}
        <LinkStat label="gnd gps"
          value={store.link?.ground ? store.link.ground.status.toUpperCase().replace("_", " ") : "—"}
          color={store.ground?.position ? "var(--ok)" : "var(--warn)"} />
        <LinkStat label="gnd pkts" value={fmtInt(store.link?.ground?.count ?? 0)} />
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
  const gsEff = store.groundStation();
  // Ground-modem registers as reported by helios-cots-telemetry
  // (current_rfd_config). Empty until that node reports in, so the rows below
  // read "—" rather than showing a stale config-file copy.
  const rfd = store.rfdConfig?.config ?? {};
  return (
    <Panel title="Configuration">
      <div className="kv">
        <span className="k">rocket</span><span className="v">{cfg.rocket_name ?? "—"}</span>
        {/* Read-only: callsign comes from mission_config.json (mirrors TeleGPS
            direwolf.conf MYCALL), so it is not editable here. */}
        <span className="k">callsign</span>
        <span className="v">{cfg.callsign || "—"}</span>
        <span className="k">expected apogee</span><span className="v">{fmt(cfg.expected_apogee_m ?? 0, 0)} m</span>
        <span className="k">refresh</span><span className="v">{cfg.ui?.refresh_hz ?? "—"} Hz</span>
        <span className="k">video src</span><span className="v">{cfg.ui?.video_source ?? "—"}</span>
        {/* Pad position: live from the ground receiver's NMEA when it has a fix,
            otherwise the mission_config.json fallback. The tag says which. */}
        <span className="k">pad</span>
        <span className="v">
          {gsEff.lat != null ? `${fmtLatLon(gsEff.lat)}, ${fmtLatLon(gsEff.lon)}` : "—"}
          <span
            className="mono"
            title={gsEff.source === "gnss"
              ? `Live from Helios.Services.GroundGPS (${store.ground?.fix_quality_name})`
              : "No GNSS fix — using mission_config.json ground_station"}
            style={{
              fontSize: 10, marginLeft: 6,
              color: gsEff.source === "gnss" ? "var(--ok)" : "var(--warn)",
            }}>
            {gsEff.source === "gnss" ? "GNSS" : "CONFIG"}
          </span>
        </span>
        <span className="k">ground alt</span><span className="v">{fmt(gsEff.alt_m ?? 0, 0)} m</span>
        <span className="k">RFD net/freq</span>
        <span className="v">{String(rfd.net_id ?? "—")} / {String(rfd.min_freq_khz ?? "—")}–{String(rfd.max_freq_khz ?? "—")}</span>
        <span className="k">RFD tx/air</span>
        <span className="v">
          {rfd.tx_power_dbm != null
            ? `${rfd.tx_power_dbm}dBm (${formatWatts(dbmToWatts(rfd.tx_power_dbm))})`
            : "—"} / {String(rfd.air_speed_kbps ?? "—")}kbps
        </span>
        <span className="k">RFD channels</span>
        <span className="v">{String(rfd.num_channels ?? "—")}</span>
      </div>
    </Panel>
  );
}
