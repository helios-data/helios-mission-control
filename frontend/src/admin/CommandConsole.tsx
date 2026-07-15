import { useState } from "react";
import { Panel } from "../components/Panel";
import { api } from "../lib/api";
import type { MissionStore } from "../lib/store";
import { IN_FLIGHT } from "../lib/flightmeta";

function CameraToggle({
  label, field, store, operator, disabled,
}: {
  label: string;
  field: "vtx_power" | "runcam_power" | "recording";
  store: MissionStore;
  operator: string;
  disabled?: boolean;
}) {
  const on = store.cameraState[field];
  const pending = store.acks.some((a) => a.command_type === "camera" && a.status === "pending");
  return (
    <div className="toggle-row">
      <span>
        <span className="upper" style={{ fontSize: 12 }}>{label}</span>
        <br />
        <span className="faint mono" style={{ fontSize: 10 }}>
          commanded: {on ? "ON" : "OFF"} {pending ? "· ?" : ""}
        </span>
      </span>
      <button
        className={on ? "on" : ""}
        disabled={disabled}
        onClick={() => api.command("camera", { [field]: !on }, operator).catch((e) => alert(e.message))}
      >
        {on ? "ON" : "OFF"}
      </button>
    </div>
  );
}

// Single switch that powers the whole onboard camera chain (VTX + RunCam Split)
// together. Powering off also clears recording so its interlock stays consistent.
function CameraPowerToggle({ store, operator }: { store: MissionStore; operator: string }) {
  const vtx = store.cameraState.vtx_power;
  const runcam = store.cameraState.runcam_power;
  const on = vtx && runcam;
  const pending = store.acks.some((a) => a.command_type === "camera" && a.status === "pending");
  const toggle = () =>
    api
      .command(
        "camera",
        on
          ? { vtx_power: false, runcam_power: false, recording: false }
          : { vtx_power: true, runcam_power: true },
        operator,
      )
      .catch((e) => alert(e.message));
  return (
    <div className="toggle-row">
      <span>
        <span className="upper" style={{ fontSize: 12 }}>Camera power (VTX + RunCam)</span>
        <br />
        <span className="faint mono" style={{ fontSize: 10 }}>
          commanded: VTX {vtx ? "ON" : "OFF"} · RunCam {runcam ? "ON" : "OFF"} {pending ? "· ?" : ""}
        </span>
      </span>
      <button className={on ? "on" : ""} onClick={toggle}>
        {on ? "ON" : "OFF"}
      </button>
    </div>
  );
}

const RFD_FIELDS: [string, string][] = [
  ["min_freq_khz", "Min freq (kHz)"],
  ["max_freq_khz", "Max freq (kHz)"],
  ["net_id", "Net ID"],
  ["tx_power_dbm", "TX power (dBm)"],
  ["air_speed_kbps", "Air speed (kbps)"],
];

export function CommandConsole({ store }: { store: MissionStore }) {
  const [operator, setOperator] = useState("operator");
  const [rfd, setRfd] = useState<Record<string, number>>({});
  const [armed, setArmed] = useState(false);
  const [override, setOverride] = useState(false);
  const inFlight = IN_FLIGHT.has(store.mission?.flight_state ?? "STANDBY");
  const rfdLocked = inFlight && !override;
  const runcamOn = store.cameraState.runcam_power;

  const submitRfd = async () => {
    try {
      await api.command("rfd_config", { ...rfd, write_eeprom: true, operator }, operator, override);
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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <CameraPowerToggle store={store} operator={operator} />
            <CameraToggle
              label="RunCam recording" field="recording" store={store} operator={operator}
              disabled={!runcamOn}
            />
          </div>
          {!runcamOn && <div className="faint" style={{ fontSize: 10, marginTop: 4 }}>
            recording disabled while RunCam power is off
          </div>}
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

      {/* Command history */}
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
