// MissionStore: single WebSocket connection + accumulated live state.
//
// Number panels subscribe via useStore() and re-render on each frame (cheap).
// Heavy views (chart, map, 3D) read the ring buffers imperatively so they don't
// re-render React on every packet.

import { useSyncExternalStore } from "react";
import type {
  AckFrame, CotsFrame, EventType, Frame, LinkFrame, MissionConfig, MissionEvent,
  MissionFrame, SradFrame,
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
  config: MissionConfig = {};
  acks: AckFrame[] = [];
  events: MissionEvent[] = [];
  annotations: Annotation[] = [];
  cameraState = { vtx_power: false, runcam_power: false, recording: false };
  connected = false;

  // ring buffers for heavy views
  alt: AltSeries = { x: [], baroAvg: [], kf: [], cots: [] };
  sradTrack: [number, number][] = []; // [lon, lat]
  cotsTrack: [number, number][] = [];
  private _t0ms: number | null = null;
  private _lastCotsAlt: number | null = null;

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
        break;
      case "srad": this.ingestSrad(f); break;
      case "cots": this.ingestCots(f); break;
      case "link": this.link = f; break;
      case "mission": this.setMission(f); break;
      case "config": { const { type, ...rest } = f; this.config = rest; break; }
      case "ack": this.ingestAck(f); break;
    }
    this.bump();
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
    this._pushSradSeries(f);
  }

  private _pushSradSeries(f: SradFrame) {
    if (this._t0ms === null) this._t0ms = f.timestamp_ms;
    const x = (f.timestamp_ms - (this._t0ms ?? 0)) / 1000;
    push(this.alt.x, x, MAX_POINTS);
    push(this.alt.baroAvg, f.altitude_agl_m, MAX_POINTS);
    push(this.alt.kf, (f.kf_altitude ?? 0) - (f.ground_altitude ?? 0), MAX_POINTS);
    push(this.alt.cots, this._lastCotsAlt, MAX_POINTS);
    if (hasGpsFix(f.gps.lon, f.gps.lat)) {
      push(this.sradTrack, [f.gps.lon, f.gps.lat] as [number, number], MAX_TRACK);
    }
  }

  private ingestCots(f: CotsFrame) {
    this.cots = f;
    const p = f.position;
    if (p && p.altitude_m !== null) {
      // COTS altitude is MSL-ish (ft->m); show AGL against ground_altitude.
      const ground = this.config.ground_station?.alt_m ?? this.srad?.ground_altitude ?? 0;
      this._lastCotsAlt = p.altitude_m - ground;
    }
    if (hasGpsFix(p?.lon, p?.lat)) {
      push(this.cotsTrack, [p!.lon!, p!.lat!] as [number, number], MAX_TRACK);
    }
  }

  private ingestAck(f: AckFrame) {
    const idx = this.acks.findIndex((a) => a.command_id === f.command_id);
    if (idx >= 0) this.acks[idx] = f;
    else this.acks = [...this.acks, f];
    if (f.command_type === "camera") {
      for (const k of ["vtx_power", "runcam_power", "recording"] as const) {
        if (k in f.payload) this.cameraState[k] = Boolean(f.payload[k]);
      }
    }
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
