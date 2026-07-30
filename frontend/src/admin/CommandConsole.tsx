import { useRef, useState } from "react";
import { Panel } from "../components/Panel";
import { api } from "../lib/api";
import type { MissionStore } from "../lib/store";
import { IN_FLIGHT } from "../lib/flightmeta";
import { RFD_FIELDS, validateRfd, type RfdFieldSpec } from "../lib/rfd";

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

// One S-register field. Blank = leave that register alone, so a command can
// change one setting at a time (RfdConfig fields are all `optional`). Out-of-
// range entries render an inline error and block ARM rather than being clamped
// silently — a bad S-register write can take the ground link down.
function RfdField({ spec, value, error, disabled, current, onChange }: {
  spec: RfdFieldSpec;
  value: string;
  error?: string;
  disabled: boolean;
  current?: number | boolean;
  onChange: (v: string) => void;
}) {
  const unit = spec.unit ? ` (${spec.unit})` : "";
  // Sub-label doubles as the accepted-range spec until the operator gets it
  // wrong, then it's replaced by the error. A dropdown already shows what it
  // accepts, so it gets the label only.
  const allowed = spec.kind === "range" ? `${spec.min}–${spec.max}${spec.unit ? ` ${spec.unit}` : ""}` : "";
  // Selects have no placeholder, so the "leave alone" option carries the
  // current value the way the number inputs' placeholder does.
  const unchanged = current !== undefined ? `— unchanged (now ${current}) —` : "— unchanged —";

  return (
    <label>
      <span>
        {spec.label}{unit} <span className="faint">{spec.reg}</span>
      </span>
      {spec.kind === "enum" ? (
        <select
          className={error ? "invalid" : ""}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{unchanged}</option>
          {spec.values.map((v) => (
            <option key={v} value={String(v)}>{v}</option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          className={error ? "invalid" : ""}
          min={spec.min}
          max={spec.max}
          step={1}
          placeholder={current !== undefined ? `now ${current}` : "unchanged"}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error
        ? <span className="rfd-err">{error}</span>
        : <span className="rfd-hint">{spec.hint ?? allowed}</span>}
    </label>
  );
}

export function CommandConsole({ store }: { store: MissionStore }) {
  const [operator, setOperator] = useState("operator");
  // Raw text per field so "" stays "unchanged" instead of collapsing to 0.
  const [rfd, setRfd] = useState<Record<string, string>>({});
  const [armed, setArmed] = useState(false);
  const [override, setOverride] = useState(false);
  const inFlight = IN_FLIGHT.has(store.mission?.flight_state ?? "STANDBY");
  const rfdLocked = inFlight && !override;
  // Live registers off `current_rfd_config`; mission_config.json is the
  // fallback until helios-cots-telemetry reports in.
  const configured = store.rfdConfig?.config ?? store.config.rfd900x ?? {};
  const liveConfig = store.rfdConfig !== null;

  // Latest rfd_config command, for the confirmed-by-modem readout.
  const lastRfdAck = store.acks.filter((a) => a.command_type === "rfd_config").at(-1) ?? null;

  const check = validateRfd(rfd);
  // Editing after arming re-arms: never execute a payload the operator hasn't
  // seen validated in its final form.
  const setField = (key: string, v: string) => {
    setArmed(false);
    setRfd({ ...rfd, [key]: v });
  };

  const submitRfd = async () => {
    try {
      await api.command("rfd_config", check.payload, operator, override);
      setArmed(false);
      setRfd({});
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
            RFD900x — ground modem + uplink
            <span className="faint" style={{ textTransform: "none", marginLeft: 6 }}>
              {liveConfig ? "current values from modem" : "modem not reporting — showing config file"}
            </span>
          </div>
          <div className="rfd-form">
            {RFD_FIELDS.map((spec) => (
              <RfdField
                key={spec.key}
                spec={spec}
                value={rfd[spec.key] ?? ""}
                error={check.errors[spec.key]}
                disabled={rfdLocked}
                current={configured[spec.key] ?? undefined}
                onChange={(v) => setField(spec.key, v)}
              />
            ))}
          </div>
          {!check.valid && (
            <div className="errbox">
              {Object.keys(check.errors).length} field
              {Object.keys(check.errors).length > 1 ? "s are" : " is"} out of range — fix before arming
            </div>
          )}
          {check.valid && check.warnings.map((w) => (
            <div className="warnbox" key={w}>{w}</div>
          ))}
          {inFlight && (
            <label className="warnbox" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              Override in-flight lockout ({store.mission?.flight_state}) — can break the RF link
            </label>
          )}
          <div className="row-actions">
            {!armed ? (
              <button
                className="danger"
                disabled={rfdLocked || !check.valid || check.empty}
                onClick={() => setArmed(true)}
              >
                ARM
              </button>
            ) : (
              <>
                <button className="rec" onClick={submitRfd}>
                  EXECUTE — write {Object.keys(check.payload).length} S-register
                  {Object.keys(check.payload).length > 1 ? "s" : ""}
                </button>
                <button onClick={() => setArmed(false)}>Cancel</button>
              </>
            )}
          </div>

          {/* Confirmation: helios-cots-telemetry re-publishes current_rfd_config
              after it writes the modem, which flips the command to acknowledged. */}
          {lastRfdAck && (
            <div className="rfd-status">
              {lastRfdAck.status === "acknowledged" ? (
                <span className="cam-on">✓ ground modem confirmed #{lastRfdAck.command_id}</span>
              ) : lastRfdAck.status === "error" ? (
                <span className="cam-rec">✗ #{lastRfdAck.command_id} failed — {lastRfdAck.message}</span>
              ) : (
                <span className="faint">awaiting ground modem confirmation for #{lastRfdAck.command_id}…</span>
              )}
            </div>
          )}
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
