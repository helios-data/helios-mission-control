"""Standalone replay simulator (§9).

Publishes a synthetic full CloudBurst flight to a live Helios core so the whole
mission-control stack can be exercised without hardware:
  - SRAD  TelemetryPacket on Helios.FALCON.srad_telemetry / "telemetry" at N Hz
  - COTS  AprsPacket       on Helios.FALCON.aprs_telemetry / "aprs" at ~0.2 Hz

Requires the SDK + protos (make deps && make protos). It reuses the same
kinematic model as STANDALONE mode (src.flight_model) so the two agree.

Usage:  uv run python sim/replay.py --hz 20 --core Helios --port 5000
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.constants import FLIGHT_STATES  # noqa: E402
from src.flight_model import SyntheticFlight  # noqa: E402


def _build_telemetry(cls, frame: dict):
    """Map a normalized SRAD frame onto a betterproto TelemetryPacket.

    Field names follow the §1.2 description; reconcile with the real .proto if a
    setattr is silently ignored (betterproto tolerates unknown attributes poorly,
    so mismatches will surface as AttributeError here — a good early signal).
    """
    pkt = cls()
    pkt.counter = frame["counter"]
    pkt.timestamp_ms = frame["timestamp_ms"]
    pkt.state = FLIGHT_STATES.index(frame["flight_state"])  # proto field is `state`
    for axis in ("x", "y", "z"):
        setattr(pkt, f"accel_{axis}", frame["accel"][axis] or 0.0)
        setattr(pkt, f"gyro_{axis}", frame["gyro"][axis] or 0.0)
    pkt.kf_altitude = frame["kf_altitude"] or 0.0
    pkt.kf_velocity = frame["kf_velocity"] or 0.0
    for i in (0, 1):
        b = frame[f"baro{i}"]
        setattr(pkt, f"baro{i}_healthy", b["healthy"])
        setattr(pkt, f"baro{i}_altitude", b["altitude"] or 0.0)
    pkt.ground_altitude = frame["ground_altitude"]
    g = frame["gps"]
    pkt.gps_latitude = g["lat"] or 0.0
    pkt.gps_longitude = g["lon"] or 0.0
    pkt.gps_altitude = g["alt"] or 0.0
    pkt.gps_speed, pkt.gps_sats, pkt.gps_fix = g["speed"] or 0.0, g["sats"], g["fix"]
    return pkt


def _build_aprs(aprs_cls, pos_cls, frame: dict):
    pkt = aprs_cls()
    pkt.source = frame["source_callsign"] or "N0CALL"  # combined callsign+SSID
    pkt.destination = frame["destination"] or "APRS"
    pkt.path = list(frame["path"])
    p = frame["position"]
    if p is not None:
        pos = pos_cls()
        pos.latitude = p["lat"] or 0.0
        pos.longitude = p["lon"] or 0.0
        pos.altitude_ft = p["altitude_ft"] or 0.0
        pos.speed_knots = p["speed_knots"] or 0.0
        pos.course_deg = p["course"] or 0.0
        pos.symbol = p["symbol"] or "/O"
        pos.comment = p["comment"] or ""
        pkt.position = pos
    return pkt


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hz", type=float, default=20.0)
    ap.add_argument("--core", default="Helios")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--callsign", default="N0CALL")
    args = ap.parse_args()

    from helios import HeliosClient  # requires SDK
    from src.generated import TelemetryPacket  # requires `make protos`

    try:
        from src.generated import AprsPacket, AprsPosition
    except ImportError:
        from helios.generated.helios.transport import AprsPacket, AprsPosition

    client = HeliosClient(core_address=args.core, core_port=args.port,
                          node_uri="Helios.Sim.Replay")
    await client.connect()
    print(f"replay connected to {args.core}:{args.port} @ {args.hz} Hz")

    flight = SyntheticFlight(ground_alt_m=1401.0)
    dt = 1.0 / args.hz
    aprs_every = max(1, int(args.hz / 0.2))
    tick = 0
    while True:
        frame = flight.step(dt)
        await client.publish_event(
            event_name="telemetry",
            data=bytes(_build_telemetry(TelemetryPacket, frame)),
            override_address="Helios.FALCON.srad_telemetry",
        )
        if tick % aprs_every == 0:
            aprs = flight.aprs_frame(args.callsign)
            await client.publish_event(
                event_name="aprs",
                data=bytes(_build_aprs(AprsPacket, AprsPosition, aprs)),
                override_address="Helios.FALCON.aprs_telemetry",
            )
        tick += 1
        await asyncio.sleep(dt)


if __name__ == "__main__":
    asyncio.run(main())
