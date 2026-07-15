# Helios Mission Control — Build Plan for Claude Opus

**Deliverable:** A new standalone repository (`helios-mission-control`) providing a web-based mission control GUI with two endpoints — `/admin` (operator control) and `/overlay` (public-facing mission control display, usable as an OBS browser source) — for UBC Rocket's IREC 2026 CloudBurst launch, integrated into the existing Helios distributed system.

**Hard constraint:** All code lives in the new repo. **Do not modify any other repository.** Where changes to other repos are required (they are — see §8), stop and list them for the user instead of making them.

---

## 1. System Context (verified against actual source, July 2026)

### 1.1 Architecture

Helios is a Docker-orchestrated event system launched by `helios-launcher` using `src/config/rockets/IREC2026-CloudBurst.json`. Component tree per that config:

```
Helios (root)
├── HeliosCore            → helios-data/helios-core (Go, branch IREC2026)
├── FALCON
│   └── Telemetry         → UBC-Rocket/helios-cots-telemetry (branch IREC2026)
└── Services
    ├── Dashboard         → helios-data/helios-dashboard (Grafana + InfluxDB)
    ├── Livestreaming     → helios-data/helios-livestreaming
    └── TeleGPS           → helios-data/helios-telegps-telemetry
```

- **helios-core** is a Go TCP event broker listening on port **5000** at hostname/address `Helios`. All components speak the transport protocol defined in `helios-protos/transport/protocol.proto`: a length-framed `TransportMessage` envelope with `HandshakeRequest/Response`, `EventPublish`, `EventRequest`, `EventSubscribe/Unsubscribe`, `EventError`. Events are keyed by `(address, event_name)` and carry opaque `bytes data`.
- **helios-python-sdk** (`helios-data/helios-python-sdk`, branch `IREC2026`, vendored as a git submodule by every Python service) provides the async client. Canonical usage, copied from `helios-dashboard/src/main.py`:

```python
from helios import HeliosClient

client = HeliosClient(core_address="Helios", core_port=5000,
                      node_uri="Helios.Services.MissionControl")
await client.connect()

# Subscribe (async context manager + async iterator)
async with client.subscribe_event(address="Helios.FALCON.Telemetry",
                                  event_name="telemetry") as events:
    async for event in events:
        pkt = TelemetryPacket().parse(event.data)   # betterproto-style

# Publish
await client.publish_event(event_name="command", data=cmd_bytes,
                           override_address="Helios.FALCON.Telemetry")

# One-shot request of latest event at an address
event = await client.get_event(address=..., event_name=...)
```

Note: generated proto classes are **betterproto** dataclasses (`Packet().parse(bytes)`, `.to_dict()`, `bytes(pkt)` to serialize), not google-protobuf classes. Match this.

### 1.2 The two telemetry streams

| Stream | Address | Event name | Payload proto | Contents |
|---|---|---|---|---|
| **SRAD** (confirmed by user) | `Helios.FALCON.Telemetry` | `telemetry` | `TelemetryPacket` from **falcon-protos** | counter, timestamp_ms, `FlightState` enum (STANDBY/ASCENT/MACH_LOCK/DROGUE_DESCENT/MAIN_DESCENT/LANDED), accel x/y/z, gyro x/y/z, Kalman altitude/velocity + variances, dual barometer health/pressure/temp/altitude/NIS/faults, ground_altitude, GPS lat/lon/alt/speed/sats/fix |
| **COTS** (confirmed by user) | `Helios.Services.TeleGPS` | `aprs` | `AprsPacket` from **helios-protos/transport/aprs.proto** | source callsign+SSID, destination, digi path, optional timestamp, `AprsPosition` (lat/lon decimal degrees, altitude **feet**, course, speed **knots**, symbol, comment) or raw_info |

Unit conversions used elsewhere in the codebase (mirror them): APRS `altitude_ft × 0.3048 → m`, `speed_knots × 0.514444 → m/s`.

The FALCON stream arrives via an RFD900x ground modem → serial → COBS-framed, CRC-checked protobuf decoded by `helios-cots-telemetry`. The TeleGPS stream arrives via Direwolf/KISS APRS decode in `helios-telegps-telemetry` (callsign configured through `direwolf.conf` `MYCALL` placeholder).

Robustness patterns to copy from `helios-dashboard`/`helios-livestreaming`: skip events with `len(event.data) < 15`, catch parse errors per-packet, detect corrupted betterproto list-valued fields, keep last-good packet, count errors.

### 1.3 Existing dashboards (context, not to modify)

- `helios-dashboard`: Grafana on :3000 + InfluxDB on :8086. Its GPS map layer for FALCON telemetry is labeled **"SRAD"** — evidence for the stream mapping above.
- `helios-livestreaming`: Flask + Socket.IO on :8080, node URI `Helios.FALCON.Livestream`. Already has rudimentary `/overlay` and `/admin` templates (the admin panel just manually pushes fake numbers to the overlay via a Socket.IO `admin_update` event). The new repo **supersedes** this UI (see Open Question 2 on what happens to that service).

### 1.4 Sibling repo conventions (follow all of these)

- Python ≥3.12/3.13, **uv** for dependency management (`pyproject.toml` + `uv.lock`).
- Git **submodules**: `falcon-protos` and `helios-python-sdk` (branch IREC2026); add `helios-protos` if compiling `AprsPacket` locally (the SDK already ships generated `AprsPacket` under `helios.generated.helios.transport` — prefer importing from the SDK, as helios-dashboard does).
- `Makefile` with targets: `deps` (uv sync + submodules), `protos` (compile falcon-protos → `generated/` betterproto package), `run`, `lint` (ruff).
- `Dockerfile` + `entrypoint.sh`; env flags `VERBOSE`, `STANDALONE` (standalone = run UI with no core connection, for development).
- `config.json` at repo root consumed by the launcher, declaring `ports`, `volumes`, `devices`, `flags`, `websites`. Example for this repo:

```json
{
  "ports": [{"source": "8090", "target": "8090"}],
  "devices": [],
  "volumes": [{"type": "folder", "name": "/app/logs", "source": "<host path for packet logs>"}],
  "flags": [],
  "websites": ["http://localhost:8090/admin", "http://localhost:8090/overlay"]
}
```

Port **8090** chosen to avoid collisions (3000/8086 dashboard, 8080 livestreaming, 5000 core). Registering the component in `IREC2026-CloudBurst.json` is a change in helios-launcher — flag it, don't do it (§8).

---

## 2. New Repository

**Name:** `helios-mission-control` (org TBD — Open Question 9). Branch `IREC2026` to match siblings.

### 2.1 Tech stack

- **Backend:** Python 3.13, **FastAPI + uvicorn** (native asyncio — the Helios SDK is async; avoids the thread-bridging hack in helios-livestreaming's Flask setup). WebSocket fan-out to browsers, REST for history/config/commands, serves the built frontend as static files.
- **Frontend:** **React + TypeScript + Vite**, built into `frontend/dist` and served by FastAPI. Libraries:
  - `three` (+ @react-three/fiber, @react-three/drei) — 3D rocket visualization
  - `uplot` — high-rate, low-overhead time-series charts (better than recharts for 10–50 Hz telemetry)
  - `maplibre-gl` or `leaflet` — GPS map (offline-capable, see Open Question 7)
  - No CDN dependencies at runtime — **vendor everything**; assume zero internet at the launch site.
- **Single Docker container**, single process.

### 2.2 Repository structure

```
helios-mission-control/
├── falcon-protos/            # git submodule
├── helios-python-sdk/        # git submodule
├── src/
│   ├── main.py               # entrypoint: SDK tasks + uvicorn
│   ├── helios_bridge.py      # subscriptions → in-memory state + history rings
│   ├── state.py               # MissionState: latest packets, ring buffers, derived stats
│   ├── commands.py            # command construction, publish, ack tracking, safety interlocks
│   ├── packet_log.py          # CSV/JSONL logging of SRAD & COTS packets
│   ├── api/
│   │   ├── ws.py              # /ws websocket: pushes typed JSON frames
│   │   └── rest.py            # /api/... REST endpoints
│   └── generated/             # compiled falcon-protos (make protos)
├── frontend/
│   ├── src/
│   │   ├── admin/             # /admin app
│   │   ├── overlay/           # /overlay app
│   │   ├── components/        # shared: AltitudeChart, GpsMap, Rocket3D, StateBadge, PacketPanel...
│   │   └── lib/               # ws client, units, flight-state colors, telemetry types
│   └── (vite config, multi-page build: admin.html + overlay.html)
├── assets/                    # UBC Rocket logo, sponsor logos, rocket 3D model, expected flight profile
├── sim/replay.py              # standalone mock publisher (see §9)
├── Makefile, Dockerfile, entrypoint.sh, config.json, pyproject.toml, README.md
```

---

## 3. Backend Design

### 3.1 Helios bridge

One `HeliosClient` (node URI `Helios.Services.MissionControl`). Tasks:

1. Subscribe `Helios.FALCON.Telemetry` / `telemetry` → parse `TelemetryPacket` → update `MissionState.srad` (latest + ring buffer of N packets, default 10,000) → broadcast WS frame `{"type":"srad", ...}`.
2. Subscribe `Helios.Services.TeleGPS` / `aprs` → parse `AprsPacket` → same for `cots`.
3. On connect, `get_event` on both addresses to seed "latest" immediately.
4. Reconnect loop with backoff; surface link status (core connected? seconds since last SRAD/COTS packet? packet rate Hz? error count?) in a `{"type":"link"}` frame — this drives the "signal" indicators on both UIs.
5. Command publisher + ack listener (§5).

Everything derived (max altitude, max velocity/Mach estimate, apogee detection, T+ clock from state transition, packet rates) is computed server-side in `MissionState` so both endpoints and OBS captures agree.

**Altitude computation rules (user-specified):** the primary altitude value is the **mean of `baro0_altitude` and `baro1_altitude`**, restricted to healthy barometers (`baroN_healthy`): both healthy → average; one healthy → that one; neither → fall back to `kf_altitude` and flag degraded. `kf_altitude` is always available as a secondary series. **AGL vs MSL:** compute AGL as `altitude − ground_altitude`; UIs display AGL as the headline number with MSL secondary (or a toggle), and `ground_altitude` itself is shown in the config/status area. All charts default to the baro-average series with `kf_altitude` as a thin secondary trace.

### 3.2 API surface

- `GET /admin`, `GET /overlay` — served SPA pages.
- `WS /ws?role=admin|overlay` — server pushes `srad`, `cots`, `link`, `config`, `ack`, `mission` (derived stats/state) frames. Overlay role receives no command/ack traffic.
- `GET /api/history/srad?since=<counter|ts>&limit=` and `/api/history/cots?...` — ring buffer dumps for late-joining clients and chart backfill.
- `GET /api/config` — current mission configuration (callsign, RFD frequency/net ID/air-speed/TX power, refresh rate, rocket name, expected apogee...). Source of truth: `mission_config.json` in the repo, editable from admin (Open Question 3 covers whether any of this should instead come from the core).
- `POST /api/log/srad` / `POST /api/log/cots` — "click to log": snapshot the current latest packet (or begin/stop continuous logging — implement both: a **Log now** button and a **Recording** toggle) to timestamped CSV + JSONL in `/app/logs`, mirroring the CSV logger style in the telemetry repos.
- `GET /api/logs` + `GET /api/logs/{file}` — list/download captured logs.
- `POST /api/command` — admin-only; body `{type: "rfd_config"|"livestream", payload: {...}}`; returns command_id; ack arrives over WS.

### 3.3 Frontend transport

Single WS connection per page; auto-reconnect; charts render from history backfill + live appends. Overlay must keep rendering last-known values (grayed/stale styling after configurable timeout) rather than blanking — it will be on a livestream.

---

## 4. `/admin` — Operator Console

Layout: dense, dark, utilitarian (think ground-station software, not the show overlay). Panels:

1. **Configuration panel** — read-only display of current config (callsign, RFD900x frequency band / net ID / air speed / TX power, UI refresh rate, rocket name/profile) + an "Edit" mode for locally-owned values. Refresh rate setting throttles WS push frequency.
2. **SRAD packet panel** — latest `TelemetryPacket` rendered as a full field table (every proto field, with units and health coloring for baro0/baro1 health, GPS fix/sats), plus a scrolling history table (virtualized) of recent packets. Buttons: **Log now**, **Record** toggle, **Export CSV**.
3. **COTS packet panel** — same treatment for `AprsPacket` (callsign, path, position, converted altitude m / speed m/s, raw_info fallback for non-position packets), own history + logging buttons.
4. **Altitude plot** — uPlot time series overlaying the SRAD **baro-average altitude** (per the rules in §3.1; `kf_altitude` and individual baro0/baro1 altitudes as thin secondary lines) with COTS APRS altitude (converted to m). AGL/MSL toggle (`ground_altitude` subtraction). Zoom/pan, auto-follow toggle.
5. **GPS map** — SRAD track and COTS track as two colored polylines + current-position markers, ground station marker, fit-to-tracks button, distance/bearing readout from ground station to latest fix.
6. **State indicator** — large `FlightState` badge with per-state colors (STANDBY gray, ASCENT green, MACH_LOCK amber, DROGUE_DESCENT blue, MAIN_DESCENT teal, LANDED white), state transition log with timestamps.
7. **Command console** —
   - **Onboard camera controls**, three independent toggles, each **uplinked to the rocket** over the RFD900x link (§5): **VTX power**, **RunCam Split power**, and **RunCam recording** start/stop. Each toggle shows commanded state vs last-known/unconfirmed state (grayed "?" until acked or confirmed — rocket-confirmed state is future work), with per-command ack status. Recording toggle disabled while RunCam power is commanded off.
   - **RFD900x configuration** form (frequency min/max, net ID, TX power, air speed, ECC, mavlink framing — the standard SiK/RFD S-registers) → publishes `RfdConfig` command event. **Scope: local ground modem only** — the ground-station RFD attached to `helios-cots-telemetry`'s serial port. Remote-modem (`RT`) commands and uplinked reconfig are explicitly out of scope; list them in the README "Future work" section.
   - Two-step **ARM → EXECUTE** interlock with confirmation modal for anything that can break the RF link mid-flight; disable RFD reconfig entirely while `FlightState ∈ {ASCENT, MACH_LOCK, DROGUE_DESCENT, MAIN_DESCENT}` unless an "override" checkbox is set.
   - Command history with per-command ack status (pending / ok / error / timeout).
8. **Link health strip** — core connection, SRAD packet rate + age, COTS packet rate + age, parse-error counters.

---

## 5. Command Path & New Protobufs (falcon-protos — NOT created yet, do not create in that repo)

There is currently **no** command/uplink message in falcon-protos (only `TelemetryPacket` + `HelloWorldPacket`) and `helios-cots-telemetry`'s serial reader is read-only. The plan therefore:

1. **Define the schema now, in this repo**, under `protos-proposed/ground_command.proto`, and generate code from it locally so mission control is complete and testable.
2. **Flag a PR to `UBC-Rocket/falcon-protos`** to upstream it (see §8). Once merged, switch the Makefile to compile it from the submodule and delete the local copy.

Proposed schema (adjust with the avionics team):

```proto
syntax = "proto3";
// Ground-segment command envelope, published by MissionControl to Helios.

message RfdConfig {                 // maps to SiK/RFD900x S-registers via AT commands
  optional uint32 min_freq_khz   = 1;   // S8
  optional uint32 max_freq_khz   = 2;   // S9
  optional uint32 net_id         = 3;   // S3
  optional uint32 tx_power_dbm   = 4;   // S4
  optional uint32 air_speed_kbps = 5;   // S2
  optional bool   ecc            = 6;   // S5
  optional bool   mavlink        = 7;   // S6
  bool write_eeprom              = 8;   // AT&W + ATZ after setting
}

message CameraControl {              // UPLINKED to the rocket over the RFD900x link
  optional bool vtx_power = 1;       // power on/off the onboard VTX (video transmitter)
  optional bool runcam_power = 2;    // power on/off the RunCam Split
  optional bool recording = 3;       // start/stop RunCam recording
}                                     // fields optional so a command can change one thing at a time

message GroundCommand {
  uint32 command_id = 1;
  uint32 issued_at_ms = 2;
  string operator = 3;            // free-text operator tag from admin UI
  oneof command {
    RfdConfig rfd_config = 4;     // ground-local: applied to the ground-station modem
    CameraControl camera = 5;     // uplink: forwarded over RF to FALCON
  }
}

message CommandAck {
  uint32 command_id = 1;
  bool success = 2;
  string message = 3;             // e.g. AT command transcript / error
}
```

Because `CameraControl` crosses the RF link and must be decoded by the FALCON flight firmware (nanopb), the uplink message needs an accompanying `.options` file with size limits, mirroring `HelloWorldPacket.options`. Keep the uplink message minimal — likely a dedicated tiny `UplinkPacket { uint32 command_id; bool camera_recording; }` rather than the full `GroundCommand`; decide with the avionics team.

**Event routing** (proposal — confirm the event-name convention with the team):

- **RFD config (ground-local only):** publish `GroundCommand` bytes with `event_name="command"`, `override_address="Helios.FALCON.Telemetry"`. The COTS telemetry service (which owns the RFD serial port) subscribes, enters AT command mode on the **local** modem (`+++`, `ATSn=x`, `AT&W`, `ATZ`), and publishes `CommandAck` with `event_name="command_ack"` on its own address. Mission control subscribes to acks.
- **Camera control (uplink):** same publish path. The COTS telemetry service serializes the small nanopb-constrained uplink packet (VTX power / RunCam power / recording bits), COBS-frames + CRCs it exactly like the downlink framing, and transmits it over the RFD900x to the rocket, where FALCON firmware actuates the devices. Ack in two stages: an immediate ground ack on successful transmit, and (future work) rocket-confirmed status — e.g. `vtx_power` / `runcam_power` / `camera_recording` bits added to `TelemetryPacket`.

Consumer-side behaviors (RFD AT handling, uplink transmit path, firmware-side decode) are **changes to other repos** — list them, don't implement (§8).

---

## 6. `/overlay` — Mission Control Display (OBS-ready)

Aesthetic direction: real control-room, not sci-fi kitsch. Dark navy/charcoal background, thin cyan/amber accent lines, monospaced numerals (Inconsolata is already the ecosystem font — reuse it, vendored), subtle grid, corner brackets on panels, UBC Rocket blue/gold accents. 1920×1080 fixed-safe layout (also test 2560×1440); everything must be legible when compressed by a stream encoder. Read `/mnt/skills/public/frontend-design/SKILL.md` before building.

Panels:

1. **Header bar** — UBC Rocket logo, mission name ("CLOUDBURST · IREC 2026"), callsign, live UTC + local clock, **T− / T+ mission clock** (armed manually from admin; auto-starts T+ on STANDBY→ASCENT transition).
2. **Livestream section** — the VTX feed is received on the ground and enters the PC as a **USB capture card (UVC device)**. Capture cards are single-consumer (one process can open the device at a time), so implement a `video_source` config switch with three modes:
   - `transparent-window` (OBS-composite): the overlay leaves a keyed/transparent rectangle; OBS owns the capture card and composites the feed behind it. GUI shows no video itself. Most robust for the public stream.
   - `local-capture`: the page grabs the UVC device directly via `getUserMedia()` (works on localhost). Near-zero latency but only on the machine hosting the card, and mutually exclusive with OBS using the device.
   - `webrtc-url` (recommended for GUI-embedded video): a bundled **go2rtc** sidecar process owns `/dev/videoX` (passed through via the launcher `config.json` `devices` field) and restreams it — WebRTC (WHEP, ~200–500 ms) consumed by a `<video>` element in the GUI on any LAN machine, and RTSP/browser-source consumed by OBS. Single device owner, multiple consumers.
   All three fall back to the §6.1 "NO SIGNAL" panel when no frames arrive. Design principle: the public livestream must never depend on the GUI being healthy — if go2rtc mode is used, OBS pulls from go2rtc, not from the overlay page.
3. **3D rocket attitude** — three.js rocket model (start with a parameterized cylinder+nosecone+fins procedural model; swap in a real glTF of CloudBurst when provided). Orientation driven by SRAD gyro data. **Important:** `TelemetryPacket` carries gyro *rates* (deg/s or rad/s — confirm units, Open Question 5), not orientation. Implement a client-side complementary filter (integrate gyro, correct tilt with accel gravity vector when |a|≈1 g) and reset-to-vertical on STANDBY. Display roll rate readout beside the model.
4. **State + speed block** — big `FlightState` badge and current velocity (`kf_velocity`), plus Mach estimate (using standard atmosphere at current altitude), max speed so far.
5. **Altitude block** — current altitude as the **baro-average AGL** per §3.1 (big number, m and ft; MSL and `kf_altitude` as secondary readouts; `ground_altitude` reference shown in small print), max altitude so far, and an **altitude-vs-time chart with the expected flight profile** drawn as a dashed reference curve underneath the live trace. Expected profile loaded from `assets/expected_profile.csv` (time_s, altitude_m) exported from OpenRocket/RASAero (Open Question). Mark predicted apogee.
6. **GPS block** — mini-map with live track + current lat/lon readout, sats/fix quality dots, distance from pad.
7. **Footer / sponsor bar** — auto-rotating sponsor logo carousel + "Powered by Project Helios" tag.
8. **Signal indicators** — small SRAD/COTS link dots (green pulsing on fresh packets, amber stale, red lost) so stream viewers see telemetry health honestly.

Overlay is strictly read-only (WS role `overlay`; no REST mutations reachable).

### 6.1 Universal fallback & empty states (hard requirement — applies to EVERY section of BOTH UIs)

Every panel must render a designed fallback rather than breaking, blanking oddly, or showing stale data as if it were live. Three data states per panel, visually distinct:

- **NO DATA (never received):** placeholder state. Numbers render as `—` dashes; charts show empty axes with a centered "AWAITING TELEMETRY" label; the map shows a neutral basemap with a crosshair and "NO GPS FIX"; the 3D rocket renders static, desaturated, upright with "NO ATTITUDE DATA"; the video region shows a dark panel with a camera-off icon and "NO SIGNAL / STREAM OFFLINE" message; packet panels show an empty-state row "No packets received".
- **STALE (received, then stopped — configurable timeout, default 5 s SRAD / 60 s COTS):** keep last values but desaturate/gray them, show "LAST PACKET 00:14 AGO" per source, and pulse the corresponding link dot amber→red. Never silently freeze live-looking numbers on a stream.
- **LIVE:** normal rendering.

Applies per-source: SRAD panels can be live while COTS panels are in fallback, and vice versa. The WS/link layer already tracks per-source packet age (§3.1) — fallback rendering is driven entirely from that, so it's testable by pausing the replay sim. The overlay's fallbacks must look intentional on stream (subtle, mission-control styled), not like an error page.

---

## 7. Build Phases for Opus

1. **Scaffold** — repo layout, submodules, Makefile (`deps/protos/run/lint`), pyproject (fastapi, uvicorn, websockets, betterproto matching SDK's generated style), Dockerfile, config.json, CI-less README.
2. **Proto + bridge** — compile falcon-protos, implement `helios_bridge` + `MissionState` + reconnect logic; verify against `sim/replay.py` (§9) before any UI work.
3. **API layer** — WS fan-out, history REST, packet logging, config endpoints.
4. **Admin UI** — panels 1–8 of §4.
5. **Overlay UI** — §6, including 3D model and profile chart; test as OBS browser source (transparent background flag `?transparent=1`).
6. **Command path** — proposed protos, publisher, ack tracking, interlocks; end-to-end test against a stub subscriber in `sim/`.
7. **Hardening** — fallback/empty/stale-state QA on every panel per §6.1 (drive it by pausing/killing the replay sim per source), error budgets, log rotation, 1080p layout QA, offline asset audit (zero external network requests), Docker image build via launcher conventions.

Each phase ends with something runnable; don't build UI against imagined data — always against the replay sim.

## 8. Required Changes in OTHER Repos — DO NOT MAKE THESE; report to user

1. **`UBC-Rocket/falcon-protos`** — add `GroundCommand` / `RfdConfig` / `CameraControl` / `CommandAck` messages (§5), plus a minimal uplink message with a nanopb `.options` size spec since camera control crosses the RF link.
2. **`UBC-Rocket/helios-cots-telemetry`** — subscribe to `command` events on its address; implement (a) RFD900x AT-command handling for the **local ground modem** and (b) an uplink transmit path (COBS+CRC framing of the uplink packet over the same serial link); publish `command_ack`.
3. **FALCON flight firmware** — decode the uplink packet and actuate VTX power, RunCam Split power, and RunCam recording; optionally report device states back in `TelemetryPacket` (new fields → falcon-protos change too).
4. **`helios-data/helios-livestreaming`** — no command integration needed anymore (camera control is an RF uplink, not a service toggle). Only decision: whether its now-redundant `/admin` + `/overlay` pages are removed once this repo ships.
5. **`helios-data/helios-launcher`** — add a `MissionControl` component under `Services` in `src/config/rockets/IREC2026-CloudBurst.json` pointing at the new repo (branch IREC2026) so it's built and spawned with the rest of the stack; port 8090 + websites entries.
6. *(Possibly)* **`helios-data/helios-core`** — none expected; the core is address-agnostic. Only if `must_be_registered` enforcement is enabled would MissionControl need registration.

## 9. Testing & Simulation

- `sim/replay.py`: standalone script using the SDK to publish a synthetic full flight (STANDBY → boost at ~8 g → MACH_LOCK → coast → apogee ~3 km → drogue → main → LANDED) at configurable Hz on `Helios.FALCON.Telemetry`, plus 0.2 Hz APRS packets on `Helios.Services.TeleGPS` with slight GPS offset from SRAD. Also a `sim/command_stub.py` that subscribes to `command` and returns acks, for testing the admin console without hardware.
- `STANDALONE=1` env: serve UI with an internal fake-data generator (no core needed) for pure frontend work.
- Unit tests: packet parsing edge cases (short data, corrupted list fields — copy the known failure modes), unit conversions, apogee/max detection, command interlock logic.

## 10. Open Questions for the User (answer before/while Opus builds)

**Resolved:** SRAD = FALCON `TelemetryPacket` via RFD900x, COTS = TeleGPS APRS. Onboard camera commands = VTX power, RunCam Split power, and recording toggles, uplinked to the rocket. RFD900x commands = local ground modem only (remote/uplink reconfig documented as README future work). Altitude = healthy-baro average, with `kf_altitude` secondary and `ground_altitude` AGL handling per §3.1. Attitude = **client-side complementary filter** (integrate gyro rates, gravity-correct with accel, reset-to-vertical on STANDBY + manual "reset attitude" button on admin). Every section on both UIs requires designed fallback states per §6.1. VTX video arrives via a **USB capture card**; the GUI supports the three `video_source` modes in §6 item 2 (OBS-composite / local getUserMedia / go2rtc WebRTC restream).

Still open:

1. **Gyro units & axes.** Confirm `gyro_x/y/z` units (deg/s vs rad/s) and body-axis conventions so the attitude filter and 3D model roll/pitch/yaw the right way.
2. **Launch-day video mode.** Pick the default `video_source`: `transparent-window` (OBS-only, simplest) or `webrtc-url` (go2rtc sidecar, video visible in the GUI on multiple stations). Build all three regardless; this only sets the shipped default and whether the go2rtc sidecar + `/dev/videoX` device entry go into `config.json` by default.
3. **Config source of truth.** Callsign / RFD frequency / refresh rate aren't currently exposed anywhere as data (callsign hides in TeleGPS's direwolf.conf, RFD settings live on the modem). Is mission control allowed to own `mission_config.json` locally, or should config be published/requested as an event on the core?
4. **Uplink packet framing.** Confirm the FALCON team's preferred uplink message shape and that the downlink COBS+CRC framing is symmetric for uplink.
5. **Expected flight profile.** Provide an OpenRocket/RASAero export (time vs altitude) for CloudBurst, plus expected apogee.
6. **Connectivity at the launch site.** Assume fully offline? If yes, pre-downloaded map tiles for the launch area (which coordinates/radius — Midland TX?) get bundled into the image.
7. **Auth on /admin.** It can send RF commands. LAN-only trust, or add a shared password/token?
8. **Repo home.** `helios-data` or `UBC-Rocket` org? Name `helios-mission-control` OK? Branch `IREC2026`?
9. **Assets.** UBC Rocket logo (SVG), sponsor logos, brand colors, and (optionally) a CloudBurst 3D model (glTF/STEP) — provide what exists; procedural placeholders otherwise.

## 11. Optional Cool Additions (pick any)

- **Auto event annotations**: detect liftoff, burnout, max-Q, apogee, drogue, main, touchdown from the data and stamp them on charts + a mission event ticker on the overlay.
- **Audio callouts**: synthesized voice ("Liftoff", "Apogee, three thousand meters", altitude callouts every 500 m) toggleable from admin — great on stream.
- **RSSI / link quality**: RFD900x can inject RSSI reports; if the avionics team exposes it, show a live link-margin gauge.
- **Recovery mode**: after LANDED, the overlay/admin flips to a recovery screen — big last-known coordinates, bearing + distance from ground station, walking directions arrow.
- **Replay mode**: load any recorded log and replay the whole mission through both UIs (also your best demo/testing tool — falls out of §9 nearly free).
- **Countdown integration**: manual T− clock with hold/resume controls from admin, auto-transitions at liftoff.
- **Mach/dynamic-pressure readouts** computed from standard atmosphere.
- **Multi-view overlay variants**: `?layout=lower-third` for a compact stream bar vs full dashboard.
- **Kiosk/spectator page** (`/spectator`): read-only full-screen view for a TV at the pad.
- **Ground weather panel**: manual-entry (or USB station) wind/temp/pressure shown pre-launch.
- **Rocket-confirmed device status**: once `vtx_power` / `runcam_power` / `camera_recording` fields land in `TelemetryPacket`, show VTX ● / REC ● indicators on both UIs instead of "commanded, unconfirmed".

## 12. README "Future work" section (user-requested)

The generated README must include a Future Work list covering at minimum: remote-modem `RT` commands and uplinked RFD900x reconfiguration; actual livestream (video downlink / OBS integration) control as opposed to onboard recording; rocket-confirmed command acks via new `TelemetryPacket` fields; orientation/quaternion telemetry for drift-free 3D attitude; and config publication as a core event instead of a local file.
