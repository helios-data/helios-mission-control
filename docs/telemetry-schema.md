# WebSocket frame schema

The backend pushes typed JSON frames over `/ws`. Both the real SDK bridge and the
STANDALONE generator emit this exact shape, and `frontend/src/lib/telemetry.ts`
mirrors it. `role=overlay` connections receive only the read-only frame types
(`srad`, `cots`, `link`, `mission`, `config`, `snapshot`).

## `snapshot` (sent once on connect)
```jsonc
{ "type": "snapshot", "config": {…}, "link": {…}, "mission": {…},
  "srad": {…}|null, "cots": {…}|null }
```

## `srad` (per FALCON TelemetryPacket)
```jsonc
{
  "type": "srad", "counter": 1234, "timestamp_ms": 45678,
  "flight_state": "ASCENT",
  "accel": {"x":0.0,"y":0.0,"z":1.0}, "gyro": {"x":0.0,"y":0.0,"z":120.0},
  "kf_altitude": 2401.0, "kf_velocity": 180.0,
  "kf_altitude_var": 0.5, "kf_velocity_var": 0.2,
  "baro0": {"healthy":true,"pressure":null,"temp":20.0,"altitude":2400.0,"nis":0.4,"faults":0},
  "baro1": {"healthy":true,"pressure":null,"temp":20.0,"altitude":2402.0,"nis":0.5,"faults":0},
  "ground_altitude": 1401.0,
  "gps": {"lat":32.99,"lon":-106.97,"alt":2401.0,"speed":180.0,"sats":12,"fix":3},
  // derived server-side (MissionState.ingest_srad):
  "altitude_msl_m": 2401.0, "altitude_agl_m": 1000.0,
  "altitude_degraded": false, "mach": 0.54, "g_force": 1.0, "t_plus_s": 12.3
}
```
Primary altitude follows §3.1: mean of healthy baros; one healthy → that one;
neither → `kf_altitude` with `altitude_degraded: true`. AGL = MSL − `ground_altitude`.

## `cots` (per TeleGPS AprsPacket)
```jsonc
{
  "type": "cots", "source_callsign": "N0CALL", "source_ssid": 11,
  "destination": "APRS", "path": ["WIDE1-1","WIDE2-1"], "timestamp": null,
  "position": {"lat":…, "lon":…, "altitude_ft":…, "altitude_m":…,
               "course":…, "speed_knots":…, "speed_ms":…, "symbol":"/O", "comment":"…"},
  "raw_info": null
}
```
`altitude_m = altitude_ft × 0.3048`, `speed_ms = speed_knots × 0.514444` (§1.2).

## `link` (~4 Hz)
```jsonc
{ "type": "link", "core_connected": true,
  "srad": {"status":"live","age_s":0.05,"rate_hz":20.0,"count":1234,"errors":0,"last_epoch":…},
  "cots": {"status":"stale","age_s":72.0,"rate_hz":0.2,"count":8,"errors":0,"last_epoch":…} }
```
`status ∈ {no_data, live, stale}` drives the universal fallback system (§6.1).

## `mission` (~4 Hz)
```jsonc
{ "type": "mission", "flight_state":"ASCENT", "t_plus_s":12.3, "t_minus_s":null,
  "max_altitude_agl_m": 1000.0, "max_altitude_msl_m": 2401.0,
  "max_velocity_ms": 235.0, "max_mach": 0.72, "max_g": 8.4,
  "apogee": {"altitude_agl_m":…, "at_epoch":…, "t_plus_s":…}|null,
  "transitions": [{"state":"ASCENT","at_epoch":…,"t_plus_s":0.0}, …] }
```

## `ack` (admin only)
```jsonc
{ "type": "ack", "command_id": 1, "command_type": "camera",
  "payload": {"vtx_power": true}, "operator": "op", "issued_at": …,
  "status": "pending|ok|error|timeout", "message": "" }
```

## `config`
The full `mission_config.json` object with `"type": "config"` added; broadcast
when the admin edits config.
