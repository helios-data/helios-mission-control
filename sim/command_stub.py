"""Command stub (§9): subscribes to `command` and decodes it.

Stands in for helios-cots-telemetry so the admin command console can be tested
end-to-end against a live core without the RFD900x hardware. It parses the
GroundCommand (falcon-protos) and logs it. There is no CommandAck any more —
camera state is confirmed to the operator via the TelemetryPacket
(runcam_power / runcam_recording), which sim/replay.py drives.

Requires the SDK + protos (make deps && make protos).

Usage:  uv run python sim/command_stub.py --core Helios --port 5000
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

COMMAND_ADDRESS = "Helios.FALCON.SRAD_Telemetry"


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", default="Helios")
    ap.add_argument("--port", type=int, default=5000)
    args = ap.parse_args()

    from helios import HeliosClient
    from src.generated import GroundCommand  # falcon-protos; requires `make protos`

    client = HeliosClient(core_address=args.core, core_port=args.port,
                          node_uri="Helios.Sim.CommandStub")
    await client.connect()
    print(f"command stub connected to {args.core}:{args.port}; awaiting commands")

    async with client.subscribe_event(address=COMMAND_ADDRESS, event_name="command") as events:
        async for event in events:
            try:
                cmd = GroundCommand.parse(event.data)
            except Exception as exc:  # noqa: BLE001
                print("failed to parse command:", exc)
                continue
            print(f"[stub] cmd #{cmd.command_id} operator={cmd.operator!r} {cmd.to_dict()}")


if __name__ == "__main__":
    asyncio.run(main())
