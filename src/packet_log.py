"""Packet logging: CSV + JSONL capture of SRAD & COTS packets (§3.2).

Two modes, both exposed on the admin console:
  - "Log now": snapshot the current latest packet to an append-only file.
  - "Record":  continuous capture of every packet for a source until stopped.

Continuous capture is driven by MissionState sinks (state.subscribe), so it runs
identically in STANDALONE and live modes.
"""

from __future__ import annotations

import csv
import json
import logging
import time
from pathlib import Path
from typing import Any, TextIO

log = logging.getLogger("mission-control.packetlog")


def _flatten(d: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(_flatten(v, f"{key}."))
        elif isinstance(v, list):
            out[key] = json.dumps(v)
        else:
            out[key] = v
    return out


MAX_SEGMENT_BYTES = 64 * 1024 * 1024  # roll to a new file segment past 64 MB


class _Recorder:
    def __init__(self, path_base: Path, source: str, max_bytes: int = MAX_SEGMENT_BYTES) -> None:
        self.base = path_base
        self.source = source
        self.max_bytes = max_bytes
        self.ts = time.strftime("%Y%m%d_%H%M%S")
        self.started = time.time()
        self.count = 0
        self._segment = 0
        self._bytes = 0
        self._open_segment()

    def _open_segment(self) -> None:
        suffix = "" if self._segment == 0 else f"_part{self._segment:02d}"
        self.jsonl_path = self.base / f"{self.source}_{self.ts}{suffix}.jsonl"
        self.csv_path = self.base / f"{self.source}_{self.ts}{suffix}.csv"
        self._jsonl: TextIO = self.jsonl_path.open("w", encoding="utf-8", newline="")
        self._csv_file: TextIO = self.csv_path.open("w", encoding="utf-8", newline="")
        self._csv: csv.DictWriter | None = None
        self._bytes = 0

    def _rotate(self) -> None:
        self._jsonl.close()
        self._csv_file.close()
        self._segment += 1
        self._open_segment()

    def write(self, frame: dict[str, Any]) -> None:
        flat = _flatten(frame)
        line = json.dumps(frame) + "\n"
        self._jsonl.write(line)
        if self._csv is None:
            self._csv = csv.DictWriter(self._csv_file, fieldnames=list(flat.keys()))
            self._csv.writeheader()
        self._csv.writerow({k: flat.get(k, "") for k in self._csv.fieldnames})
        self.count += 1
        self._bytes += len(line.encode("utf-8"))
        if self._bytes >= self.max_bytes:
            self._rotate()

    def close(self) -> None:
        self._jsonl.close()
        self._csv_file.close()


class PacketLogger:
    def __init__(self, log_dir: str = "logs") -> None:
        self.dir = Path(log_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._recorders: dict[str, _Recorder] = {}

    def sink(self, source: str, frame: dict[str, Any]) -> None:
        """MissionState sink: append to an active recorder if one is running."""
        rec = self._recorders.get(source)
        if rec is not None:
            try:
                rec.write(frame)
            except Exception:  # noqa: BLE001 - never let logging kill ingest
                log.exception("failed writing %s packet to log", source)

    # ---- recording -------------------------------------------------------
    def is_recording(self, source: str) -> bool:
        return source in self._recorders

    def start_recording(self, source: str) -> dict[str, Any]:
        if source in self._recorders:
            return self.recording_status(source)
        self._recorders[source] = _Recorder(self.dir, source)
        log.info("started recording %s -> %s", source, self._recorders[source].csv_path.name)
        return self.recording_status(source)

    def stop_recording(self, source: str) -> dict[str, Any]:
        rec = self._recorders.pop(source, None)
        if rec is None:
            return {"source": source, "recording": False}
        rec.close()
        return {
            "source": source, "recording": False, "count": rec.count,
            "csv": rec.csv_path.name, "jsonl": rec.jsonl_path.name,
        }

    def recording_status(self, source: str) -> dict[str, Any]:
        rec = self._recorders.get(source)
        if rec is None:
            return {"source": source, "recording": False}
        return {
            "source": source, "recording": True, "count": rec.count,
            "since": rec.started, "csv": rec.csv_path.name,
        }

    # ---- one-shot snapshot ----------------------------------------------
    def log_now(self, source: str, frame: dict[str, Any] | None) -> dict[str, Any]:
        if frame is None:
            return {"ok": False, "error": "no packet available yet"}
        flat = _flatten(frame)
        jsonl_path = self.dir / f"{source}_snapshots.jsonl"
        csv_path = self.dir / f"{source}_snapshots.csv"
        with jsonl_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"logged_at": time.time(), **frame}) + "\n")
        write_header = not csv_path.exists()
        with csv_path.open("a", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["logged_at", *flat.keys()])
            if write_header:
                w.writeheader()
            w.writerow({"logged_at": time.time(), **flat})
        return {"ok": True, "file": csv_path.name}

    # ---- listing / download ---------------------------------------------
    def list_logs(self) -> list[dict[str, Any]]:
        files = []
        for p in sorted(self.dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
            if p.is_file():
                st = p.stat()
                files.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
        return files

    def resolve(self, name: str) -> Path | None:
        # Prevent path traversal: only plain filenames inside the log dir.
        candidate = (self.dir / name).resolve()
        if candidate.parent != self.dir.resolve() or not candidate.is_file():
            return None
        return candidate
