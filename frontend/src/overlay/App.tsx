import { useEffect, useState, type ReactNode } from "react";
import { StateBadge } from "../components/StateBadge";
import { AltitudeChart, type Profile } from "../components/AltitudeChart";
import { GpsMap } from "../components/GpsMap";
import { Rocket3D } from "../components/Rocket3D";
import { SignalDot } from "../components/SignalDot";
import { EventTicker } from "../components/EventTicker";
import { getStore, useStore } from "../lib/store";
import { sourceState, type DataState } from "../lib/fallback";
import { useTheme } from "../lib/theme";
import { ThemeToggle } from "../components/ThemeToggle";
import { stateColor } from "../lib/colors";
import { clock, feet, fmt, fmtLatLon, M_TO_FT } from "../lib/units";
import { VideoPanel } from "./VideoPanel";

const store = getStore("overlay");

function useClocks() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setT(new Date()), 500); return () => clearInterval(id); }, []);
  return t;
}

// Load optional expected flight profile: CSV "time_s,altitude_m".
function useProfile(): Profile | undefined {
  const [p, setP] = useState<Profile | undefined>(undefined);
  useEffect(() => {
    fetch("/brand/expected_profile.csv")
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((txt) => {
        const rows = txt.trim().split(/\r?\n/).slice(1)
          .map((l) => l.split(",").map(Number))
          .filter((r) => r.length >= 2 && !Number.isNaN(r[0]))
          .map((r) => [r[0], r[1]] as [number, number]);
        if (rows.length) setP(rows);
      })
      .catch(() => setP(undefined));
  }, []);
  return p;
}

function Panel({ h, children, className = "", stale = false }: {
  h: string; children: ReactNode; className?: string; stale?: boolean;
}) {
  return (
    <div className={`ov-panel panel-corner ${className} ${stale ? "stale" : ""}`}>
      <div className="h">{h}</div>
      {children}
    </div>
  );
}

export function App() {
  useStore(store);
  const [theme, toggleTheme] = useTheme();
  const now = useClocks();
  const profile = useProfile();
  const cfg = store.config;
  const ui = cfg.ui ?? {};
  const sradDs = sourceState(store.link, "srad", ui.srad_stale_seconds ?? 5);
  const cotsDs = sourceState(store.link, "cots", ui.cots_stale_seconds ?? 60);
  const m = store.mission;
  const s = store.srad;
  const hasSrad = sradDs.status !== "no_data" && s != null;
  const stale = sradDs.status === "stale";

  // Tilt from vertical, estimated from the gravity vector when |a| ≈ 1 g.
  let tiltDeg = "—";
  if (s) {
    const ax = s.accel.x ?? 0, ay = s.accel.y ?? 1, az = s.accel.z ?? 0;
    const a = Math.hypot(ax, ay, az);
    if (a > 0.7 && a < 1.3) tiltDeg = fmt((Math.acos(Math.max(-1, Math.min(1, ay / a))) * 180) / Math.PI, 0);
  }

  const tClock = m?.t_plus_s != null ? clock(m.t_plus_s, true)
    : m?.t_minus_s != null ? clock(m.t_minus_s, true) : "T− --:--";

  return (
    <div className="overlay">
      <header className="ov-header">
        <img
          className="logo"
          src={theme === "light" ? "/brand/UBCRocket_Logo_Coloured_Long.png" : "/brand/UBCRocket_Logo_White_Long.png"}
          alt="UBC Rocket"
        />
        <div className="ov-mission">
          <span className="name">{cfg.mission_name ?? "CLOUDBURST"} · {cfg.event_name ?? "IREC 2026"}</span>
          <span className="sub">{cfg.callsign ?? "N0CALL"} · MISSION CONTROL</span>
        </div>
        <div className="ov-clocks">
          <div className="ov-tclock">
            <div className="big" style={{ color: stateColor(m?.flight_state) }}>{tClock}</div>
            <div className="lbl">MISSION CLOCK</div>
          </div>
          <div className="ov-tclock">
            <div className="big">{now.toISOString().slice(11, 19)}</div>
            <div className="lbl">UTC</div>
          </div>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      {/* LEFT */}
      <div className="ov-left">
        <Panel h="Attitude" stale={stale}>
          <Rocket3D store={store} height={260} hasData={hasSrad}
            gyroUnits={cfg.gyro_units ?? "deg"} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
            <Stat label="ROLL RATE" value={hasSrad ? `${fmt(s!.gyro.y, 0)}` : "—"} unit="°/s" size={20} />
            <Stat label="TILT" value={tiltDeg} unit="°" size={20} />
          </div>
        </Panel>
        <Panel h="Flight State & Speed" stale={stale}>
          <StateBadge state={m?.flight_state} size="lg" live={sradDs.status === "live"} />
          <div style={{ display: "flex", gap: 20, marginTop: 12 }}>
            <Stat label="VELOCITY" value={hasSrad ? fmt(s!.kf_velocity, 0) : "—"} unit="m/s" size={34} />
            <Stat label="MACH" value={hasSrad ? fmt(s!.mach, 2) : "—"} size={34} />
          </div>
          <div style={{ display: "flex", gap: 20, marginTop: 8 }}>
            <Stat label="MAX SPEED" value={fmt(m?.max_velocity_ms ?? 0, 0)} unit="m/s" size={18} />
            <Stat label="MAX MACH" value={fmt(m?.max_mach ?? 0, 2)} size={18} />
          </div>
        </Panel>
      </div>

      {/* CENTER */}
      <div className="ov-center">
        <Panel h="Live Video" className="video-panel">
          <VideoPanel config={cfg} />
        </Panel>
        <Panel h="Altitude · baro-average AGL vs expected profile" className="altitude-panel" stale={stale}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 24, marginBottom: 8 }}>
            <Stat label="ALTITUDE AGL" size={52} unit="m"
              value={hasSrad ? fmt(s!.altitude_agl_m, 0) : "—"}
              sub={hasSrad ? feet(s!.altitude_agl_m) : undefined} />
            <Stat label="MSL" size={22} unit="m" value={hasSrad ? fmt(s!.altitude_msl_m, 0) : "—"} />
            <Stat label="KALMAN" size={22} unit="m" value={hasSrad ? fmt(s!.kf_altitude, 0) : "—"} />
            <Stat label="MAX AGL" size={22} unit="m" value={fmt(m?.max_altitude_agl_m ?? 0, 0)}
              sub={`${feet(m?.max_altitude_agl_m ?? 0)}${m?.apogee ? ` · apogee T+${clock(m.apogee.t_plus_s)}` : ""}`} />
          </div>
          <div style={{ marginBottom: 8 }}><EventTicker events={store.events} /></div>
          {sradDs.status === "no_data" ? (
            <div className="awaiting" style={{ height: 200 }}>Awaiting telemetry</div>
          ) : (
            <AltitudeChart store={store} profile={profile} height={200} dark={theme === "dark"} />
          )}
          {hasSrad && s!.altitude_degraded && (
            <div className="mono" style={{ color: "var(--warn)", fontSize: 11, marginTop: 4 }}>
              ⚠ barometers degraded — showing Kalman altitude · ground {fmt(s!.ground_altitude, 0)} m MSL
            </div>
          )}
        </Panel>
      </div>

      {/* RIGHT */}
      <div className="ov-right">
        <Panel h="GPS" stale={cotsDs.status === "stale" && sradDs.status !== "live"}>
          {sradDs.status === "no_data" && cotsDs.status === "no_data" ? (
            <div className="awaiting" style={{ height: 220 }}>No GPS fix</div>
          ) : (
            <GpsMap store={store} height={220} theme={theme} />
          )}
          <div className="kv" style={{ marginTop: 8, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", fontFamily: "var(--mono)", fontSize: 12 }}>
            <span className="dim">lat</span><span style={{ textAlign: "right" }}>{fmtLatLon(s?.gps.lat)}</span>
            <span className="dim">lon</span><span style={{ textAlign: "right" }}>{fmtLatLon(s?.gps.lon)}</span>
            <span className="dim">fix / sats</span>
            <span style={{ textAlign: "right" }}>fix {s?.gps.fix ?? "—"} · {s?.gps.sats ?? 0} sats</span>
          </div>
        </Panel>
        <Panel h="Telemetry Health">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <SignalRow label="SRAD · FALCON" ds={sradDs} rate={store.link?.srad.rate_hz ?? 0} />
            <SignalRow label="COTS · APRS" ds={cotsDs} rate={store.link?.cots.rate_hz ?? 0} />
          </div>
        </Panel>
      </div>

      <footer className="ov-footer">
        <div className="sponsors">
          <img
            src={theme === "light" ? "/brand/UBCRocket_Logo_Coloured.png" : "/brand/UBCRocket_Logo_White.png"}
            alt="UBC Rocket"
          />
        </div>
        <span className="powered">POWERED BY PROJECT HELIOS</span>
      </footer>
    </div>
  );
}

function Stat({ label, value, unit, sub, size = 24 }: {
  label: string; value: string; unit?: string; sub?: string; size?: number;
}) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="big-num" style={{ fontSize: size }}>
        {value}{unit && <span className="unit" style={{ fontSize: "0.45em", color: "var(--text-dim)", marginLeft: 4 }}>{unit}</span>}
      </span>
      {sub && <span className="faint mono" style={{ fontSize: 11 }}>{sub}</span>}
    </div>
  );
}

function SignalRow({ label, ds, rate }: { label: string; ds: DataState; rate: number }) {
  const txt = ds.status === "no_data" ? "NO DATA"
    : ds.status === "stale" ? `LAST ${clock(ds.ageS ?? 0)} AGO` : `LIVE · ${fmt(rate, 1)} Hz`;
  return (
    <div className="signal-row">
      <SignalDot status={ds.status} />
      <span className="upper" style={{ fontSize: 12 }}>{label}</span>
      <span className="mono faint" style={{ marginLeft: "auto", fontSize: 11 }}>{txt}</span>
    </div>
  );
}
