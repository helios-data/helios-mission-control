# Cross-repo changes for Helios Mission Control

Mission Control (`helios-mission-control`) is self-contained, but to run against
real hardware and be spawned by the launcher, five **other** repositories need
changes. Per the project constraint, this repo does **not** modify them — this
document drafts each change as a ready-to-open PR for the owning team.

Order of dependency:

1. **falcon-protos** — define the command/uplink messages (nothing else compiles without these).
2. **helios-cots-telemetry** — consume commands: RFD AT config + RF uplink transmit + acks.
3. **FALCON flight firmware** — decode the uplink packet and actuate the cameras.
4. **helios-launcher** — register the MissionControl component so it's built/spawned.
5. **helios-livestreaming** — retire its now-redundant `/admin` + `/overlay`.

The canonical schema + event routing live in this repo at
[`protos-proposed/ground_command.proto`](../protos-proposed/ground_command.proto)
and `MISSION_CONTROL_PLAN.md` §5.

---

## PR 1 — `UBC-Rocket/falcon-protos`: add ground-command + uplink messages

**Title:** Add GroundCommand / RfdConfig / CameraControl / CommandAck + UplinkPacket

**Why:** falcon-protos currently defines only `TelemetryPacket` and
`HelloWorldPacket`. Mission Control needs a command envelope (ground-station RFD
config + onboard camera control) and an ack message. Because camera control is
**uplinked over the RF link** and decoded by nanopb firmware, it needs a minimal,
size-bounded `UplinkPacket` with an `.options` file.

**Files**

- `GroundCommand.proto` (new)
- `UplinkPacket.options` (new)
- `README.md` (document the new messages)

**`GroundCommand.proto`** (copied from this repo's `protos-proposed/`; drop the
`helios.ground` package or keep it — match the falcon-protos convention, which is
currently *no package*):

```proto
syntax = "proto3";

message RfdConfig {                 // SiK/RFD900x S-registers via AT commands
  optional uint32 min_freq_khz   = 1;   // S8
  optional uint32 max_freq_khz   = 2;   // S9
  optional uint32 net_id         = 3;   // S3
  optional uint32 tx_power_dbm   = 4;   // S4
  optional uint32 air_speed_kbps = 5;   // S2
  optional bool   ecc            = 6;   // S5
  optional bool   mavlink        = 7;   // S6
  bool write_eeprom              = 8;   // AT&W + ATZ after setting
}

message CameraControl {             // UPLINKED to the rocket over RFD900x
  optional bool vtx_power    = 1;
  optional bool runcam_power = 2;
  optional bool recording    = 3;
}

message GroundCommand {
  uint32 command_id   = 1;
  uint32 issued_at_ms = 2;
  string operator     = 3;
  oneof command {
    RfdConfig rfd_config = 4;        // ground-local: applied to the ground modem
    CameraControl camera = 5;        // uplink: forwarded over RF to FALCON
  }
}

message CommandAck {
  uint32 command_id = 1;
  bool   success    = 2;
  string message    = 3;
}

// Minimal packet actually transmitted over RF and decoded by FALCON (nanopb).
message UplinkPacket {
  uint32 command_id       = 1;
  bool   vtx_power        = 2;
  bool   runcam_power     = 3;
  bool   camera_recording = 4;
}
```

**`UplinkPacket.options`** (mirror `HelloWorldPacket.options`): `UplinkPacket`
has only scalar fields, so it is already fixed-size; add the file for parity and
to pin the max encoded size the firmware buffer must accommodate.

**After merge (in this repo):** point `make protos` at the submodule copy and
delete `protos-proposed/`.

**Testing:** `protoc` compiles for both betterproto2 (SDK/ground) and nanopb
(firmware); round-trip encode/decode a `GroundCommand` with each `oneof` arm and
an `UplinkPacket`.

---

## PR 2 — `UBC-Rocket/helios-cots-telemetry`: consume commands (RFD config + RF uplink + acks)

**Title:** Subscribe to ground commands: RFD900x AT config, camera RF uplink, and acks

**Why:** This service owns the ground-station RFD900x serial port and is
read-only today. Mission Control publishes `GroundCommand` bytes with
`event_name="command"` on `Helios.FALCON.Telemetry`; this service must consume
them, act, and reply with `command_ack`.

**Event routing (must match Mission Control):**

| Command | Publish (from MC) | This service does | Reply |
|---|---|---|---|
| `rfd_config` | `command` on `Helios.FALCON.Telemetry` | AT-command the **local** modem | `command_ack` |
| `camera` | `command` on `Helios.FALCON.Telemetry` | serialize `UplinkPacket`, COBS+CRC, TX over RF | `command_ack` (ground TX ok) |

**Sketch** (async SDK; adapt to the service's existing structure):

```python
from helios import HeliosClient
from src.generated import GroundCommand, CommandAck, UplinkPacket  # after PR 1 + make protos

ADDRESS = "Helios.FALCON.Telemetry"

async def command_loop(client, serial_port):
    async with client.subscribe_event(address=ADDRESS, event_name="command") as events:
        async for ev in events:
            cmd = GroundCommand.parse(ev.data)
            ok, msg = False, ""
            try:
                which = cmd.to_dict()
                if "rfdConfig" in which:
                    ok, msg = apply_rfd_config(serial_port, cmd.rfd_config)   # local modem
                elif "camera" in which:
                    ok, msg = uplink_camera(serial_port, cmd.command_id, cmd.camera)
            except Exception as exc:
                ok, msg = False, str(exc)
            ack = CommandAck(command_id=cmd.command_id, success=ok, message=msg)
            await client.publish_event(event_name="command_ack", data=bytes(ack),
                                       override_address=ADDRESS)
```

**(a) RFD900x AT-command handling (local ground modem)** — enter command mode,
set S-registers, save:

```python
def apply_rfd_config(port, rfd) -> tuple[bool, str]:
    # NOTE: pauses the RF link; the read loop must be paused/resumed around this.
    transcript = []
    port.write(b"+++"); wait(1.1); expect(port, "OK", transcript)          # command mode
    regs = {"S8": rfd.min_freq_khz, "S9": rfd.max_freq_khz, "S3": rfd.net_id,
            "S4": rfd.tx_power_dbm, "S2": rfd.air_speed_kbps,
            "S5": int(rfd.ecc), "S6": int(rfd.mavlink)}
    for reg, val in regs.items():
        if val is not None:
            port.write(f"AT{reg}={val}\r\n".encode()); expect(port, "OK", transcript)
    if rfd.write_eeprom:
        port.write(b"AT&W\r\n"); expect(port, "OK", transcript)
        port.write(b"ATZ\r\n")   # reboot modem
    return True, " | ".join(transcript)
```

Scope: **local ground modem only.** Remote-modem (`RT…`) commands and uplinked
RFD reconfiguration are explicitly out of scope (README "Future work").

**(b) Camera RF uplink** — serialize the small nanopb-constrained packet, frame
it exactly like the downlink (COBS + CRC), and write it to the same serial link:

```python
def uplink_camera(port, command_id, cam) -> tuple[bool, str]:
    pkt = UplinkPacket(command_id=command_id,
                       vtx_power=bool(cam.vtx_power),
                       runcam_power=bool(cam.runcam_power),
                       camera_recording=bool(cam.recording))
    frame = cobs_encode(with_crc(bytes(pkt)))   # reuse the existing downlink framing, symmetric
    port.write(frame)
    return True, "uplink transmitted"           # ground-side TX ack only (see below)
```

**Ack semantics:** the `command_ack` here is a **ground ack** (config applied /
uplink transmitted). Rocket-confirmed camera state is future work (PR 3 optional
part) via new `TelemetryPacket` fields.

**Testing:** exercise end-to-end against `sim/command_stub.py` in this repo (it
already subscribes to `command` and returns `command_ack`); on hardware, verify
AT transcript and that an `UplinkPacket` is received/decoded by the flight
computer bench setup.

---

## PR 3 — FALCON flight firmware: decode uplink + actuate cameras

**Title:** Decode UplinkPacket over RF and actuate VTX / RunCam power + recording

**Why:** The uplinked `UplinkPacket` must be received on the flight RFD900x,
de-framed (COBS + CRC), nanopb-decoded, and mapped to GPIO/UART actions.

**Changes**

- Add `UplinkPacket` (PR 1) to the firmware's nanopb generation.
- In the RF receive path, detect uplink frames (distinct from any downlink echo),
  CRC-check, `pb_decode` into `UplinkPacket`.
- Actuate:
  - `vtx_power` → VTX power MOSFET/enable line.
  - `runcam_power` → RunCam Split power line.
  - `camera_recording` → RunCam control (UART "RunCam Device Protocol" or the
    2-wire start/stop) — gated on RunCam power being on.
- **Optional (recommended):** add `bool vtx_power`, `bool runcam_power`,
  `bool camera_recording` to `TelemetryPacket` so the ground can show
  rocket-confirmed device state instead of "commanded, unconfirmed". This is a
  second, small falcon-protos change.

**Safety:** ignore malformed/CRC-failed frames; debounce repeated command_ids
(idempotent by `command_id`); define power-on defaults (cameras off at boot).

**Testing:** bench test with the ground stack transmitting each camera command;
scope the actuation lines; confirm recording only starts with power on.

---

## PR 4 — `helios-data/helios-launcher`: register the MissionControl component

**Title:** Add MissionControl service to IREC2026-CloudBurst rocket config

**Why:** So the launcher builds and spawns Mission Control with the rest of the
stack.

**File:** `src/config/rockets/IREC2026-CloudBurst.json` (a.k.a.
`CloudBurst-IREC2026.json` — **confirm the exact filename with the launcher
team**) — add under `Services`:

```jsonc
{
  "name": "MissionControl",
  "repo": "helios-data/helios-mission-control",   // or UBC-Rocket/… — final org TBD
  "branch": "IREC2026",
  "config": "config.json"                          // this repo ships it at root
}
```

The repo's [`config.json`](../config.json) already declares the launcher
interface: port **8090**, a `/app/logs` volume, a `/app/tiles` volume (map-tile
cache), and the two `websites` (`/admin`, `/overlay`). If the go2rtc video
sidecar is used, also pass the capture device through `devices` (e.g.
`/dev/video0`) and expose port `1984`.

**Testing:** `helios-launcher` builds the image and the component appears in the
component tree; `/admin` + `/overlay` are reachable on 8090.

### Optional: make the launcher the source of truth for mission config (Open Question 3)

Mission Control can take its per-rocket parameters from the launcher instead of
its bundled `mission_config.json`. This repo's side is **already implemented**:
`config.json` declares a **linked file** (same mechanism as a volume) and the
backend deep-merges it over the bundled defaults (STANDALONE ignores it and uses
the bundled file for testing):

```jsonc
// config.json (already in this repo)
"volumes": [
  { "type": "file", "name": "/app/config/mission_config.json",
    "source": "<launcher: mission config override>" }
]
```

The launcher just needs to **link a file** into that container path. Three
shapes are accepted, so pick whichever fits the launcher's config model:

1. **Rocket file with a `nodes` sibling** *(the intended CloudBurst-IREC2026
   layout)*: the rocket file **is** the mission config — all of
   `mission_config.json`'s fields live at the top level, **beside** a `nodes`
   object holding the launcher's existing component tree. It looks exactly like
   today's `mission_config.json` with a `nodes` key added:

   ```jsonc
   {
     "mission_name": "CLOUDBURST",
     "callsign": "VA7UBC",
     "expected_apogee_m": 3048,
     "ground_station": { "lat": 32.99, "lon": -106.97, "alt_m": 1401 },
     "rfd900x": { "net_id": 25, "tx_power_dbm": 30 },
     "ui": { "...": "..." },
     "nodes": { "FALCON": { "...": "..." }, "TeleGPS": { "...": "..." } }
   }
   ```

   The backend reads the top-level fields as the mission config and **ignores
   `nodes`** (it's the launcher's). Admin edits **persist**: on save it splices
   the changed fields back into the file and leaves `nodes` (and any other
   launcher keys) untouched.

2. **Plain override file**: a bare mission-config document with no `nodes` — any
   subset is fine; only fields that differ from the bundled defaults are needed.
   Also writable.

3. **Config nested under a node**: no top-level config, only
   `nodes.MissionControl.mission_config` (node key overridable via the
   `MISSION_CONFIG_NODE` env var). Treated **read-only** (edits stay in-memory).

In all shapes the launcher file is **deep-merged over the bundled defaults**, so
it only needs to carry the fields it wants to override. Default container path is
`/app/config/mission_config.json`; override with the `MISSION_CONFIG` env var if
a different mount point is preferred.

---

## PR 5 — `helios-data/helios-livestreaming`: retire redundant `/admin` + `/overlay`

**Title:** Remove now-superseded `/admin` + `/overlay` pages (replaced by MissionControl)

**Why:** `helios-livestreaming`'s rudimentary `/admin` (manual fake-number push)
and `/overlay` are superseded by `helios-mission-control`. Camera control is now
an **RF uplink** (PR 2/3), not a Socket.IO toggle, so no command integration is
needed here.

**Decision for the owning team:** either

- **Remove** the `/admin` + `/overlay` routes/templates and the `admin_update`
  Socket.IO handler, keeping only whatever streaming role remains; or
- **Keep** them temporarily behind a flag during transition.

No functional dependency remains between the two services. Coordinate the cutover
so only one overlay is composited into OBS at launch.

---

## Summary checklist

- [ ] **falcon-protos**: GroundCommand/RfdConfig/CameraControl/CommandAck + UplinkPacket(+`.options`)
- [ ] **helios-cots-telemetry**: subscribe `command`; local RFD AT config; camera RF uplink; publish `command_ack`
- [ ] **FALCON firmware**: decode UplinkPacket, actuate VTX/RunCam; (optional) confirmed state in TelemetryPacket
- [ ] **helios-launcher**: register MissionControl in IREC2026-CloudBurst.json (port 8090, volumes, websites)
- [ ] **helios-livestreaming**: remove/retire redundant `/admin` + `/overlay`

Once PR 1 merges, switch this repo's `make protos` to compile from the
falcon-protos submodule and delete `protos-proposed/`.
