// MissionStore: single WebSocket connection + accumulated live state.
//
// Number panels subscribe via useStore() and re-render on each frame (cheap).
// Heavy views (chart, map, 3D) read the ring buffers imperatively so they don't
// re-render React on every packet.

import { useSyncExternalStore } from "react";
import type {
  AckFrame, CotsFrame, EventType, Frame, GroundFrame, GroundPosition, GroundStation,
  LandingConfigFrame, LinkFrame, NmeaFixQuality,
  MissionConfig, MissionEvent, MissionFrame, PredictionFrame, RfdConfigFrame, SradFrame,
} from "./telemetry";
import { EVENT_META } from "./eventmeta";

export interface Annotation {
  x: number; // chart x (seconds since first packet)
  type: EventType;
  label: string;
  color: string;
  t_plus_s: number | null;
  altitude_agl_m: number;
}

const MAX_POINTS = 6000; // ~5 min at 20 Hz for charts
const MAX_TRACK = 4000;

export interface AltSeries {
  x: number[];        // seconds since first SRAD packet
  baroAvg: number[];
  kf: number[];
  cots: (number | null)[];
}

export class MissionStore {
  role: "admin" | "overlay";
  srad: SradFrame | null = null;
  cots: CotsFrame | null = null;
  link: LinkFrame | null = null;
  mission: MissionFrame | null = null;
  landing: PredictionFrame | null = null;
  // Current operator wind override for the landing predictor (null = none set).
  landingConfig: LandingConfigFrame | null = null;
  // Latest NMEA sentence from the ground receiver (Helios.Services.GroundGPS),
  // of any type — for showing what just arrived. Kept even with no fix, so the
  // UI can distinguish "receiver not locked" from "node not running".
  ground: GroundFrame | null = null;
  // Accumulated last-known-good position, built across sentence types: only
  // GGA/RMC/GLL carry a position at all, and only GGA carries altitude,
  // satellites and HDOP. Resolving from the newest sentence alone made every
  // field strobe back to the config fallback ~3 times a second. Resolve via
  // groundStation(); this mirrors MissionState.ingest_ground on the backend.
  groundFix: Partial<GroundPosition> | null = null;
  groundFixAt: number | null = null;          // epoch ms of the last position
  groundFixQuality: NmeaFixQuality | null = null;  // from the last positional sentence
  // Ground modem's live S-registers (`current_rfd_config`) — the only source
  // for them. Null until helios-cots-telemetry reports in.
  rfdConfig: RfdConfigFrame | null = null;
  config: MissionConfig = {};
  acks: AckFrame[] = [];
  events: MissionEvent[] = [];
  annotations: Annotation[] = [];
  // Last *commanded* camera state (a single switch powers VTX + RunCam together).
  // The confirmed state reported by the FC is on srad.camera.
  cameraState = { power: false, recording: false };
  connected = false;
  // Client-side receipt time of the last SRAD frame (epoch ms), null if none yet.
  // Deliberately not link.srad.age_s: that is computed server-side and freezes at
  // its last value if the socket itself drops, which is the case the RFD
  // watchdog most needs to catch.
  lastSradAt: number | null = null;

  // ring buffers for heavy views
  alt: AltSeries = { x: [], baroAvg: [], kf: [], cots: [] };
  sradTrack: [number, number][] = []; // [lon, lat]
  cotsTrack: [number, number][] = [];
  private _t0ms: number | null = null;
  private _lastCotsAlt: number | null = null;
  // True when a new COTS altitude has arrived since the last SRAD tick. The COTS
  // series shares the SRAD timebase but APRS is far slower, so we plot the real
  // COTS point only on the tick it arrives and null in between; with spanGaps the
  // chart draws a straight line between adjacent COTS points instead of the
  // staircase that re-pushing the held value on every tick produced.
  private _cotsFresh = false;

  private ws: WebSocket | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  private reconnectTimer: number | null = null;
  private seeded = false;

  constructor(role: "admin" | "overlay") {
    this.role = role;
  }

  connect() {
    void this.init();
  }

  // Backfill history from REST once, THEN open the live socket — so a client
  // joining mid-flight (e.g. the overlay on a stream) sees the whole flight,
  // not just data since page-load (§3.3).
  private async init() {
    if (!this.seeded) {
      try {
        await this.backfill();
      } catch {
        /* non-fatal: live data will still flow */
      }
      this.seeded = true;
    }
    this.openSocket();
  }

  private async backfill() {
    const [sr, ct] = await Promise.all([
      fetch("/api/history/srad?limit=6000").then((r) => (r.ok ? r.json() : { items: [] })),
      fetch("/api/history/cots?limit=4000").then((r) => (r.ok ? r.json() : { items: [] })),
    ]);
    const sradItems = (sr.items ?? []) as SradFrame[];
    const cotsItems = (ct.items ?? []) as CotsFrame[];
    const ground = sradItems.at(-1)?.ground_altitude ?? 0;
    for (const c of cotsItems) {
      const p = c.position;
      if (hasGpsFix(p?.lon, p?.lat)) push(this.cotsTrack, [p!.lon!, p!.lat!], MAX_TRACK);
      if (p?.altitude_m != null) this._lastCotsAlt = p.altitude_m - ground;
    }
    if (cotsItems.length) this.cots = cotsItems.at(-1)!;
    for (const f of sradItems) this._pushSradSeries(f);
    // Backfilled ticks carry null COTS (we can't align sparse APRS to each SRAD
    // frame after the fact); anchor the last-known COTS altitude at the newest
    // tick so a mid-flight join starts its COTS line from a real point.
    if (cotsItems.length && this._lastCotsAlt !== null && this.alt.cots.length) {
      this.alt.cots[this.alt.cots.length - 1] = this._lastCotsAlt;
    }
    if (sradItems.length) this.srad = sradItems.at(-1)!;
    this.bump();
  }

  private openSocket() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?role=${this.role}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => { this.connected = true; this.bump(); };
    this.ws.onclose = () => { this.connected = false; this.bump(); this.scheduleReconnect(); };
    this.ws.onerror = () => { this.ws?.close(); };
    this.ws.onmessage = (ev) => this.onFrame(JSON.parse(ev.data) as Frame);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  private onFrame(f: Frame) {
    switch (f.type) {
      case "snapshot":
        this.config = f.config ?? {};
        this.link = f.link ?? null;
        this.setMission(f.mission ?? null);
        if (f.srad) this.ingestSrad(f.srad);
        if (f.cots) this.ingestCots(f.cots);
        if (f.prediction) this.landing = f.prediction;
        if (f.landing_config) this.landingConfig = f.landing_config;
        if (f.rfd_config) this.rfdConfig = f.rfd_config;
        if (f.ground) this.ingestGround(f.ground);
        break;
      case "srad": this.ingestSrad(f); break;
      case "cots": this.ingestCots(f); break;
      case "link": this.link = f; break;
      case "mission": this.setMission(f); break;
      case "prediction": this.landing = f; break;
      case "landing_config": this.landingConfig = f; break;
      case "rfd_config": this.rfdConfig = f; break;
      case "ground": this.ingestGround(f); break;
      case "config": { const { type, ...rest } = f; this.config = rest; break; }
      case "ack": this.ingestAck(f); break;
    }
    this.bump();
  }

  /** The ground station's effective position — live GNSS if fixed, else config.
   *
   * Mirrors MissionState.ground_station() on the backend. Everything that draws
   * or measures from the pad goes through here so the map marker, the downrange
   * readouts and the COTS AGL baseline can never disagree about where we are.
   * Altitude falls back independently: NMEA RMC sentences carry a position but
   * no altitude, and blanking the configured elevation would skew COTS AGL.
   */
  groundStation(): GroundStation {
    const cfg = this.config.ground_station;
    const fallback: GroundStation = {
      label: cfg?.label ?? "Ground Station",
      lat: cfg?.lat ?? null,
      lon: cfg?.lon ?? null,
      alt_m: cfg?.alt_m ?? null,
      source: "config",
    };
    const fix = this.groundFix;
    if (!fix || this.groundFixAt == null) return fallback;
    // A fix that stopped arriving eventually stops being the truth.
    const ttlMs = (this.config.ui?.ground_stale_seconds ?? 15) * 1000;
    if (Date.now() - this.groundFixAt > ttlMs) return fallback;
    if (fix.lat == null || fix.lon == null) return fallback;
    return {
      label: cfg?.label ?? "Ground Station",
      lat: fix.lat,
      lon: fix.lon,
      alt_m: fix.alt_m ?? cfg?.alt_m ?? null,
      source: "gnss",
    };
  }

  /** The landing prediction for the *current* flight, or null.
   *
   * A touchdown estimate cannot belong to a flight that hasn't launched, so
   * anything still present in STANDBY is left over from a previous run — the
   * predictor keeps republishing its last result, and the sim loops outright.
   * Treated as absent so the pad view isn't cluttered with a stale zone on the
   * map or a stale FINAL in the panel.
   */
  activeLanding(): PredictionFrame | null {
    return this.mission?.flight_state === "STANDBY" ? null : this.landing;
  }

  private setMission(m: MissionFrame | null) {
    this.mission = m;
    this.events = m?.events ?? [];
    this._recomputeAnnotations();
  }

  private _recomputeAnnotations() {
    if (this._t0ms === null) { this.annotations = []; return; }
    this.annotations = this.events.map((e) => {
      const meta = EVENT_META[e.type];
      return {
        x: (e.timestamp_ms - (this._t0ms ?? 0)) / 1000,
        type: e.type,
        label: meta.short,
        color: meta.color,
        t_plus_s: e.t_plus_s,
        altitude_agl_m: e.altitude_agl_m,
      };
    });
  }

  private ingestSrad(f: SradFrame) {
    this.srad = f;
    this.lastSradAt = Date.now();
    this._pushSradSeries(f);
  }

  private _pushSradSeries(f: SradFrame) {
    if (this._t0ms === null) this._t0ms = f.timestamp_ms;
    const x = (f.timestamp_ms - (this._t0ms ?? 0)) / 1000;
    push(this.alt.x, x, MAX_POINTS);
    push(this.alt.baroAvg, f.altitude_agl_m, MAX_POINTS);
    push(this.alt.kf, (f.kf_altitude ?? 0) - (f.ground_altitude ?? 0), MAX_POINTS);
    // Only anchor a COTS vertex on the tick a fresh APRS altitude arrived; null
    // otherwise so the chart connects real points rather than stepping.
    push(this.alt.cots, this._cotsFresh ? this._lastCotsAlt : null, MAX_POINTS);
    this._cotsFresh = false;
    if (hasGpsFix(f.gps.lon, f.gps.lat)) {
      push(this.sradTrack, [f.gps.lon, f.gps.lat] as [number, number], MAX_TRACK);
    }
  }

  private ingestCots(f: CotsFrame) {
    this.cots = f;
    const p = f.position;
    if (p && p.altitude_m !== null) {
      // COTS altitude is MSL-ish (ft->m); show AGL against ground_altitude.
      const ground = this.groundStation().alt_m ?? this.srad?.ground_altitude ?? 0;
      this._lastCotsAlt = p.altitude_m - ground;
      this._cotsFresh = true; // plot this point on the next SRAD tick
    }
    if (hasGpsFix(p?.lon, p?.lat)) {
      push(this.cotsTrack, [p!.lon!, p!.lat!] as [number, number], MAX_TRACK);
    }
  }

  // Sentence types that can carry a position — mirrors helios-ground-gps
  // decoder.nmea.POSITION_SENTENCES and src/constants.py. VTG/GSA/GSV are
  // forwarded as raw text with no fix and say nothing about where we are.
  private static POSITION_SENTENCES = new Set(["GGA", "RMC", "GLL"]);

  private ingestGround(f: GroundFrame) {
    this.ground = f;
    if (!MissionStore.POSITION_SENTENCES.has((f.sentence_type ?? "").toUpperCase())) return;
    // Only positional sentences are authoritative about fix state.
    this.groundFixQuality = f.fix_quality_name;
    if (!f.position) return;
    const merged: Partial<GroundPosition> = { ...(this.groundFix ?? {}) };
    // Merge, don't replace: an RMC must not wipe the altitude/satellites/HDOP
    // that the preceding GGA supplied.
    for (const [k, v] of Object.entries(f.position)) {
      if (v !== null && v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
    this.groundFix = merged;
    this.groundFixAt = Date.now();
  }

  private ingestAck(f: AckFrame) {
    const idx = this.acks.findIndex((a) => a.command_id === f.command_id);
    if (idx >= 0) this.acks[idx] = f;
    else this.acks = [...this.acks, f];
    if (f.command_type === "camera") this.recomputeCameraState();
  }

  // Commanded camera state = every camera command that stuck, replayed in order.
  // Derived on each ack rather than accumulated, because a status can go
  // backwards: the VTX power uplink is resent until telemetry confirms it and
  // then marked "failed", at which point the command must stop counting and the
  // button snap back to the last state that did stick. Mirrors
  // CommandManager._recompute_camera_state on the backend; keep the two in sync.
  private recomputeCameraState() {
    const rebuilt = { power: false, recording: false };
    for (const a of this.acks) {
      if (a.command_type !== "camera") continue;
      if (a.status === "failed" || a.status === "error") continue;
      for (const k of ["power", "recording"] as const) {
        if (k in a.payload) rebuilt[k] = Boolean(a.payload[k]);
      }
    }
    this.cameraState = rebuilt;
  }

  // ---- React binding ----
  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getVersion = () => this.version;
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }
}

function push<T>(arr: T[], v: T, max: number) {
  arr.push(v);
  if (arr.length > max) arr.shift();
}

// A GPS fix is only valid when both lon and lat are present and non-zero. The
// flight computer reports 0/0 as the default before it acquires a lock, so we
// must not plot those or the track snaps to null island off West Africa.
export function hasGpsFix(lon: number | null | undefined, lat: number | null | undefined): boolean {
  return lon != null && lat != null && lon !== 0 && lat !== 0;
}

const stores: Partial<Record<string, MissionStore>> = {};
export function getStore(role: "admin" | "overlay"): MissionStore {
  let s = stores[role];
  if (!s) {
    s = new MissionStore(role);
    s.connect();
    stores[role] = s;
  }
  return s;
}

// Re-render subscriber on every frame; read fields directly off the store.
export function useStore(store: MissionStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}
