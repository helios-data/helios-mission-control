// Normalized frame types — mirror the backend schema (src/state.py, src/telemetry.py).

export type FlightState =
  | "STANDBY"
  | "ASCENT"
  | "MACH_LOCK"
  | "DROGUE_DESCENT"
  | "MAIN_DESCENT"
  | "LANDED"
  | "UNKNOWN";

export interface Baro {
  healthy: boolean;
  pressure: number | null;
  temp: number | null;
  altitude: number | null;
  nis: number | null;
  faults: number;
}

export interface SradFrame {
  type: "srad";
  counter: number;
  timestamp_ms: number;
  flight_state: FlightState;
  accel: { x: number | null; y: number | null; z: number | null };
  gyro: { x: number | null; y: number | null; z: number | null };
  kf_altitude: number | null;
  kf_velocity: number | null;
  kf_altitude_var: number | null;
  kf_velocity_var: number | null;
  baro0: Baro;
  baro1: Baro;
  ground_altitude: number;
  gps: {
    lat: number | null;
    lon: number | null;
    alt: number | null;
    speed: number | null;
    sats: number;
    fix: number;
  };
  // derived (added by MissionState.ingest_srad)
  altitude_msl_m: number;
  altitude_agl_m: number;
  altitude_degraded: boolean;
  mach: number;
  g_force: number | null; // magnitude of accel vector, in g
  t_plus_s: number | null;
}

export interface CotsPosition {
  lat: number | null;
  lon: number | null;
  altitude_ft: number | null;
  altitude_m: number | null;
  course: number | null;
  speed_knots: number | null;
  speed_ms: number | null;
  symbol: string | null;
  comment: string | null;
}

export interface CotsFrame {
  type: "cots";
  source_callsign: string | null;
  source_ssid: number;
  destination: string | null;
  path: string[];
  timestamp: number | null;
  position: CotsPosition | null;
  raw_info: string | null;
}

export type SourceStatus = "no_data" | "live" | "stale";

export interface LinkSourceSnap {
  status: SourceStatus;
  age_s: number | null;
  rate_hz: number;
  count: number;
  errors: number;
  last_epoch: number | null;
}

export interface LinkFrame {
  type: "link";
  core_connected: boolean;
  srad: LinkSourceSnap;
  cots: LinkSourceSnap;
  landing?: LinkSourceSnap; // Helios.Services.LandingPredictor freshness (optional node)
}

// Landing prediction (Helios.Services.LandingPredictor -> `landing_prediction`).
// Mirrors LandingPrediction in protos-proposed/landing_prediction.proto, normalized
// by src/telemetry.py:normalize_landing. Points are {lat,lon}; 0/0 are dropped.
export interface LandingPoint {
  lat: number;
  lon: number;
}

export interface PredictionFrame {
  type: "prediction";
  based_on_packet_counter: number;
  computed_at_ms: number;
  final: boolean;
  best_estimate: LandingPoint | null;
  dispersion_cloud: LandingPoint[];
  ellipse_50: LandingPoint[];
  ellipse_90: LandingPoint[];
  current_lat: number | null;
  current_lon: number | null;
  current_source: string | null;
  wind_source: string | null;
  descent_model: string | null;
  current_alt_agl: number | null;
  flight_state: number | null;
  status: string | null; // "not_descending" | "predicting" | "final"
}

export interface Transition {
  state: FlightState;
  at_epoch: number;
  t_plus_s: number | null;
}

// Mission events = the FALCON firmware flight-state transitions (TelemetryPacket
// FlightState enum), so plot/ticker/audio labels match the actual onboard states.
export type EventType =
  | "ASCENT" | "MACH_LOCK" | "DROGUE_DESCENT" | "MAIN_DESCENT" | "LANDED";

export interface MissionEvent {
  type: EventType;
  t_plus_s: number | null;
  altitude_agl_m: number;
  timestamp_ms: number;
  at_epoch: number;
  note: string;
}

export interface MissionFrame {
  type: "mission";
  flight_state: FlightState;
  t_plus_s: number | null;
  t_minus_s: number | null;
  max_altitude_agl_m: number;
  max_altitude_msl_m: number;
  max_velocity_ms: number;
  max_mach: number;
  max_g: number;
  apogee: { altitude_agl_m: number; at_epoch: number; t_plus_s: number | null } | null;
  events: MissionEvent[];
  transitions: Transition[];
}

export interface AckFrame {
  type: "ack";
  command_id: number;
  command_type: string;
  payload: Record<string, unknown>;
  operator: string;
  issued_at: number;
  status: "pending" | "ok" | "error" | "timeout";
  message: string;
}

export interface MissionConfig {
  mission_name?: string;
  event_name?: string;
  rocket_name?: string;
  callsign?: string;
  expected_apogee_m?: number;
  gyro_units?: "deg" | "rad"; // units of TelemetryPacket gyro_x/y/z (assumed deg/s)
  ground_station?: { label?: string; lat: number; lon: number; alt_m: number };
  rfd900x?: Record<string, number | boolean>;
  ui?: {
    refresh_hz?: number;
    srad_stale_seconds?: number;
    cots_stale_seconds?: number;
    // Set by the backend from run mode, not user-edited:
    //   webrtc-url    -> WHEP from the go2rtc Video node (production)
    //   local-capture -> browser reads the capture card directly (STANDALONE)
    video_source?: "webrtc-url" | "local-capture";
    video_url?: string; // WHEP endpoint for webrtc-url mode (go2rtc node)
  };
}

export interface SnapshotFrame {
  type: "snapshot";
  config: MissionConfig;
  link: LinkFrame;
  mission: MissionFrame;
  srad: SradFrame | null;
  cots: CotsFrame | null;
  prediction: PredictionFrame | null;
}

export type Frame =
  | SradFrame
  | CotsFrame
  | LinkFrame
  | MissionFrame
  | AckFrame
  | PredictionFrame
  | SnapshotFrame
  | ({ type: "config" } & MissionConfig);
