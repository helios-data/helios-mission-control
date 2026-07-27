import { useRef, useState } from "react";
import { Panel } from "../components/Panel";
import { api } from "../lib/api";
import type { MissionStore } from "../lib/store";
import { IN_FLIGHT } from "../lib/flightmeta";

// Confirmed on/off pill driven by telemetry (srad.camera). `null` = no telemetry
// yet, so we can't confirm the onboard state.
function Confirmed({ value, onLabel = "ON", offLabel = "OFF", rec = false }: {
  value: boolean | null;
  onLabel?: string;
  offLabel?: string;
  rec?: boolean;
}) {
  if (value === null) return <span className="cam-unknown mono">—</span>;
  if (!value) return <span className="cam-off mono">{offLabel}</span>;
  return <span className={`mono ${rec ? "cam-rec" : "cam-on"}`}>{onLabel}</span>;
}

// Single switch that powers the whole onboard camera chain (VTX + RunCam) plus
// the RunCam recording toggle. "commanded" = last thing we uplinked; "confirmed"
// = what the FC firmware reports back in telemetry (srad.camera).
function CameraControls({ store, operator }: { store: MissionStore; operator: string }) {
  const commanded = store.cameraState;               // { power, recording }
  const confirmed = store.srad?.camera ?? null;      // { power, recording } | null
  const pending = store.acks.some((a) => a.command_type === "camera" && a.status === "pending");
  // Recording is allowed only when the camera has power (confirmed if we have
  // telemetry, otherwise the commanded state).
  const powerOn = confirmed ? confirmed.power : commanded.power;

  // Debounce: disable both buttons for 1s after a press so they can't be spammed.
  const [cooling, setCooling] = useState(false);
  const timer = useRef<number | null>(null);
  const send = (payload: Record<string, boolean>) => {
    if (cooling) return;
    setCooling(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCooling(false), 1000);
    api.command("camera", payload, operator).catch((e) => alert((e as Error).message));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="toggle-row">
        <span>
          <span className="upper" style={{ fontSize: 12 }}>Camera power (VTX + RunCam)</span>
          <br />
          <span className="cam-status">
            <span className="faint mono">commanded {commanded.power ? "ON" : "OFF"}{pending ? " ·" : ""}</span>
            <span className="faint">·</span>
            <span className="faint">confirmed</span>
            <Confirmed value={confirmed ? confirmed.power : null} />
          </span>
        </span>
        <button
          className={commanded.power ? "on" : ""}
          disabled={cooling}
          onClick={() => send({ power: !commanded.power, ...(commanded.power ? { recording: false } : {}) })}
        >
          {commanded.power ? "ON" : "OFF"}
        </button>
      </div>

      <div className="toggle-row">
        <span>
          <span className="upper" style={{ fontSize: 12 }}>RunCam recording</span>
          <br />
          <span className="cam-status">
            <span className="faint mono">commanded {commanded.recording ? "REC" : "OFF"}</span>
            <span className="faint">·</span>
            <span className="faint">confirmed</span>
            <Confirmed value={confirmed ? confirmed.recording : null} onLabel="REC" rec />
          </span>
        </span>
        <button
          className={commanded.recording ? "on" : ""}
          disabled={!powerOn || cooling}
          onClick={() => send({ recording: !commanded.recording })}
        >
          {commanded.recording ? "REC" : "OFF"}
        </button>
      </div>

      {!powerOn && (
        <div className="faint" style={{ fontSize: 10 }}>
          recording disabled while camera power is off
        </div>
      )}
    </div>
  );
}

// RFD900x S-registers exposed for ground-modem reconfiguration (falcon-protos
// RfdConfig). All map to SiK/RFD900x AT S-registers.
const RFD_FIELDS: [string, string][] = [
  ["min_freq_khz", "Min freq (kHz)"],
  ["max_freq_khz", "Max freq (kHz)"],
  ["net_id", "Net ID"],
  ["tx_power_dbm", "TX power (dBm)"],
  ["air_speed_kbps", "Air speed (kbps)"],
  ["num_channels", "Num channels"],
];

export function CommandConsole({ store }: { store: MissionStore }) {
  const [operator, setOperator] = useState("operator");
  const [rfd, setRfd] = useState<Record<string, number>>({});
  const [armed, setArmed] = useState(false);
  const [override, setOverride] = useState(false);
  const inFlight = IN_FLIGHT.has(store.mission?.flight_state ?? "STANDBY");
  const rfdLocked = inFlight && !override;

  const submitRfd = async () => {
    try {
      await api.command("rfd_config", { ...rfd }, operator, override);
      setArmed(false);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <Panel title="Command Console" className="span-all">
      <div className="cmd-grid">
        {/* Camera uplink controls */}
        <div>
          <div className="dim upper" style={{ fontSize: 11, marginBottom: 6 }}>
            Onboard camera (RF uplink)
          </div>
          <CameraControls store={store} operator={operator} />
        </div>

        {/* RFD900x ground-modem config */}
        <div>
          <div className="dim upper" style={{ fontSize: 11, marginBottom: 6 }}>
            RFD900x — ground modem only
          </div>
          <div className="rfd-form">
            {RFD_FIELDS.map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  disabled={rfdLocked}
                  value={rfd[key] ?? ""}
                  onChange={(e) => setRfd({ ...rfd, [key]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          {inFlight && (
            <label className="warnbox" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              Override in-flight lockout ({store.mission?.flight_state}) — can break the RF link
            </label>
          )}
          <div className="row-actions">
            {!armed ? (
              <button className="danger" disabled={rfdLocked} onClick={() => setArmed(true)}>
                ARM
              </button>
            ) : (
              <>
                <button className="rec" onClick={submitRfd}>EXECUTE — write S-registers</button>
                <button onClick={() => setArmed(false)}>Cancel</button>
              </>
            )}
          </div>
        </div>
      </div>

      <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10, fontSize: 11 }}>
        <span className="dim upper">Operator</span>
        <input value={operator} onChange={(e) => setOperator(e.target.value)} style={{ width: 140 }} />
      </label>

      {/* Command log */}
      <div className="field-table-wrap" style={{ marginTop: 8 }}>
        <table>
          <thead>
            <tr><th>#</th><th>type</th><th>payload</th><th>op</th><th>status</th><th>msg</th></tr>
          </thead>
          <tbody>
            {store.acks.slice().reverse().map((a) => (
              <tr key={a.command_id}>
                <td>{a.command_id}</td>
                <td>{a.command_type}</td>
                <td>{JSON.stringify(a.payload)}</td>
                <td>{a.operator}</td>
                <td className={`badge-${a.status}`}>{a.status}</td>
                <td className="faint">{a.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
