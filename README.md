# Helios Mission Control

Web-based mission control GUI for UBC Rocket's **IREC 2026 CloudBurst** launch,
integrated with the [Project Helios](https://github.com/helios-data) distributed
event system. Serves two endpoints from a single container:

- **`/admin`** — dense operator console: live SRAD & COTS packet tables, altitude
  chart, GPS tracks, flight-state + mission clock, packet logging, and the command
  console (camera RF uplink + RFD900x ground-modem config with ARM→EXECUTE
  interlocks).
- **`/overlay`** — public mission-control display, designed as an **OBS browser
  source** (`/overlay?transparent=1` for chroma-key compositing): 3D rocket
  attitude, big altitude/velocity/Mach readouts, altitude-vs-expected-profile
  chart, GPS mini-map, live video region, and honest telemetry-health indicators.

Two telemetry streams are consumed (§1.2 of the build plan):

| Stream | Address | Event | Payload |
|---|---|---|---|
| SRAD | `Helios.FALCON.srad_telemetry` | `telemetry` | `TelemetryPacket` (falcon-protos) |
| COTS | `Helios.FALCON.aprs_telemetry` | `aprs` | `AprsPacket` (helios-protos) |

## Quick start (no hardware, no submodules)

`STANDALONE=1` runs the entire stack against an internal synthetic CloudBurst
flight — the same data path the UIs are developed against.

```bash
make deps             # uv sync + npm install (skips SDK/protos if absent)
make frontend         # build frontend/dist
STANDALONE=1 make run # -> http://localhost:8090/admin  and  /overlay
```

Frontend hot-reload during development (backend in STANDALONE, Vite proxying
`/api` + `/ws`):

```bash
STANDALONE=1 make run        # terminal 1 (backend on :8090)
cd frontend && npm run dev   # terminal 2 (Vite on :5173, open /admin.html)
```

## Live mode (against a real Helios core)

Requires the two submodules and compiled protos:

```bash
make deps      # inits falcon-protos + helios-python-sdk submodules, installs SDK
make protos    # compiles falcon-protos + protos-proposed -> src/generated (betterproto)
make run       # connects to the Helios core (core_address/port from mission_config.json)
```

Exercise it without flight hardware using the simulators (§9):

```bash
uv run python sim/replay.py --hz 20    # publishes a full synthetic flight
uv run python sim/command_stub.py      # acks admin commands (stands in for helios-cots-telemetry)
```

## Architecture

```
Helios core ──subscribe──▶ helios_bridge ─┐
(or STANDALONE generator) ────────────────┤─▶ MissionState ─▶ ConnectionHub ─WS─▶ browsers
                                          │      │  (derived stats, rings, link health)
                                          │      └─▶ PacketLogger (CSV/JSONL)
admin REST ──▶ CommandManager ──publish──▶ core (GroundCommand) ──ack──▶ WS
```

- **Backend:** FastAPI + uvicorn (native asyncio). `src/state.py` is the single
  source of truth for derived numbers (altitude rules, max trackers, apogee,
  mission clock, packet rates) so `/admin`, `/overlay`, and OBS captures agree.
- **Frontend:** React + TypeScript + Vite (multi-page: `admin.html`,
  `overlay.html`), `three`/react-three-fiber (3D attitude), `uPlot` (charts),
  `maplibre-gl` (offline map). **No runtime CDN dependencies** — everything is
  vendored for a zero-internet launch site.
- WS frame schema: [`docs/telemetry-schema.md`](docs/telemetry-schema.md).

See [`MISSION_CONTROL_PLAN.md`](MISSION_CONTROL_PLAN.md) for the full design.

## Configuration

`mission_config.json` (repo root) is the **base** source of truth for callsign,
RFD900x settings, ground-station coordinates, UI refresh/stale timeouts, and the
`video_source` mode. Editable subset is exposed on the admin console; changes are
persisted and broadcast.

**Launcher override (Open Question 3).** helios-launcher can supply the
per-rocket parameters instead, by **linking a file** into the container (declared
in [`config.json`](config.json) exactly like a volume, at
`/app/config/mission_config.json`; override the path with `MISSION_CONFIG`). That
file is **deep-merged on top of** the bundled defaults, so the launcher only
carries the fields it owns (callsign, apogee, `ground_station`, `rfd900x`) while
UI-only defaults fall through. The intended layout is the rocket file with all of
`mission_config.json`'s fields at the top level **beside** a `nodes` object (the
launcher's component tree): the backend reads the top-level fields and ignores
`nodes`, and admin edits persist without touching it. A bare mission-config file
(no `nodes`) and a config nested under `nodes.<MISSION_CONFIG_NODE>.mission_config`
(read-only) are also accepted. **STANDALONE ignores the link** and runs the
bundled `mission_config.json` for testing. See
[`docs/OTHER_REPO_PRS.md`](docs/OTHER_REPO_PRS.md) (PR 4) for the launcher side.

## Video (`/overlay`)

The onboard VTX feed enters the PC as a **USB capture card (UVC device)**. Capture
cards are single-consumer, so three modes are supported via `ui.video_source`:

- `transparent-window` *(default)* — overlay leaves a chroma-keyed region; OBS
  owns the card and composites the feed behind it. Most robust for the stream.
- `local-capture` — page grabs the device via `getUserMedia()` (localhost only).
  **Not usable in OBS**: OBS's embedded browser blocks `getUserMedia`, so this
  mode fails with `NotAllowedError` as a browser source. Use `transparent-window`
  or `webrtc-url` for OBS; `local-capture` is for viewing on the host machine.
- `webrtc-url` — a **go2rtc** sidecar owns `/dev/videoX` and restreams it as
  WebRTC; the overlay plays it via a built-in **WHEP client** (`src/lib/whep.ts`)
  and OBS can pull the same stream — multiple consumers, one device owner.

All three fall back to a designed **NO SIGNAL** panel (`webrtc-url` auto-retries
every 3 s). The public livestream must never depend on the GUI being healthy.

### go2rtc sidecar (webrtc-url mode)

`go2rtc.yaml` restreams the USB capture card as WHEP on `:1984`. Enable it by
running the container with `GO2RTC=1` and a `go2rtc` binary on `PATH`, passing the
device through via `config.json` `devices` (e.g. `/dev/video0`). Point the overlay
at it with `ui.video_url` in `mission_config.json`
(e.g. `http://<host>:1984/api/whep?src=cloudburst`). LAN-only, no STUN/TURN — works
fully offline.

## Themes

Both `/admin` and `/overlay` support a **light/dark toggle** (☀/☾ in the header),
persisted to `localStorage`. Charts, the map basemap, and the UBC Rocket logo all
adapt. The overlay's `?transparent=1` OBS mode is theme-independent.

## Map tiles (offline caching proxy)

The GPS map's basemap is served by a backend caching proxy at `/api/tiles/{z}/{x}/{y}.png`.
On a cache miss it fetches the tile from the upstream server (OpenStreetMap by
default), writes it to `/app/tiles` (a launcher volume), and serves it — so any
tile viewed once is available offline for the container's lifetime. On startup a
best-effort **pre-warm** downloads tiles around the configured ground-station
coordinates (`map.prewarm` in `mission_config.json`) so the launch-site map works
with no connectivity. Missing tiles are transparent and fall through to the dark
background. Configure the upstream URL / radius / zooms under `map` in
`mission_config.json`; mount `/app/tiles` to a host path to persist the cache
across container restarts.

## Fallback states (§6.1)

Every panel on both UIs renders one of three visually distinct states, driven by
per-source packet age: **NO DATA** (dashes / "AWAITING TELEMETRY"), **STALE**
(desaturated last-known + "LAST PACKET mm:ss AGO", amber→red dot), and **LIVE**.
SRAD and COTS fall back independently. Test by pausing/killing a source in the sim.

## Proposed protobufs

The command path needs messages that do **not yet exist** in falcon-protos. They
are defined here in [`protos-proposed/ground_command.proto`](protos-proposed/ground_command.proto)
so mission control is complete and testable, and are proposed for upstreaming
(see "Required changes in other repositories" below).

## Required changes in other repositories

This repo does **not** modify any other repo. Ready-to-open PR drafts for each of
the changes below are in [`docs/OTHER_REPO_PRS.md`](docs/OTHER_REPO_PRS.md). The
changes needed elsewhere to run against real hardware (see plan §8):

1. **`UBC-Rocket/falcon-protos`** — add `GroundCommand` / `RfdConfig` /
   `CameraControl` / `CommandAck` + a minimal nanopb-constrained `UplinkPacket`
   (with `.options`) since camera control crosses the RF link.
2. **`UBC-Rocket/helios-cots-telemetry`** — subscribe to `command` events;
   implement RFD900x AT-command handling for the local ground modem **and** an
   uplink transmit path (COBS+CRC framing of the uplink packet); publish
   `command_ack`.
3. **FALCON flight firmware** — decode the uplink packet; actuate VTX power,
   RunCam Split power, RunCam recording; optionally report device state back in
   `TelemetryPacket`.
4. **`helios-data/helios-launcher`** — register a `MissionControl` component under
   `Services` in `IREC2026-CloudBurst.json` (branch IREC2026, port 8090, websites).
5. **`helios-data/helios-livestreaming`** — decide whether its now-redundant
   `/admin` + `/overlay` pages are removed once this ships.

## Future work

- **Remote-modem (`RT`) commands and uplinked RFD900x reconfiguration** — this
  release scopes RFD config to the **local ground modem** only.
- **Actual livestream/video-downlink control** (OBS integration, VTX channel
  switching) as opposed to onboard RunCam recording.
- **Rocket-confirmed command acks** — add `vtx_power` / `runcam_power` /
  `camera_recording` fields to `TelemetryPacket` and show confirmed device state
  (VTX ● / REC ●) instead of "commanded, unconfirmed".
- **Orientation/quaternion telemetry** for drift-free 3D attitude (current filter
  integrates gyro rates — assumed **deg/s** — + gravity correction client-side).
- **Config publication as a core event** instead of a local `mission_config.json`.
- **Authentication on `/admin`** — currently open (LAN trust). `/admin` can uplink
  RF commands, so a shared token/password gating `/admin` + mutating `/api` routes
  is recommended before a shared-network deployment. Deferred by request.
- Optional additions from plan §11: auto event annotations, audio callouts, RSSI
  link-margin gauge, recovery-mode screen, log replay, `/spectator` kiosk page.

## Development

```bash
make lint    # ruff (python) + tsc typecheck (frontend)
make test    # pytest (state/altitude/interlock unit tests)
```
