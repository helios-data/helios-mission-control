"""Packet logging: CSV + JSONL capture of SRAD & COTS packets (§3.2).

One mode, exposed on the admin console as **Record**: continuous capture of every
packet for a source until stopped. (A one-shot "Log now" snapshot existed until
2026-08-02; it was removed so every logged packet goes through the same path.)

Capture is driven by MissionState sinks (state.subscribe), so it runs identically
in STANDALONE and live modes. Every row is stamped with its arrival time and the
CSV schema widens safely as frame shapes change — see `_Recorder.write`.
"""

from __future__ import annotations

import csv
import json
import logging
import time
from datetime import UTC, datetime
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


def _stamp() -> dict[str, Any]:
    """Wall-clock arrival stamp prepended to every logged packet.

    ``logged_at`` (epoch seconds) sorts and joins against other logs;
    ``logged_at_utc`` is the same instant as ISO-8601 so a CSV opened in a
    spreadsheet is readable without conversion. Used by both continuous
    recordings and one-shot snapshots so the two file sets line up.
    """
    now = time.time()
    return {
        "logged_at": now,
        "logged_at_utc": datetime.fromtimestamp(now, tz=UTC).isoformat(timespec="milliseconds"),
    }


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
        # Ordered union of every flattened field seen so far; see write().
        self._fields: list[str] = []
        self._field_set: set[str] = set()
        self._open_segment()

    def _open_segment(self) -> None:
        suffix = "" if self._segment == 0 else f"_part{self._segment:02d}"
        self.jsonl_path = self.base / f"{self.source}_{self.ts}{suffix}.jsonl"
        self.csv_path = self.base / f"{self.source}_{self.ts}{suffix}.csv"
        self._jsonl: TextIO = self.jsonl_path.open("w", encoding="utf-8", newline="")
        self._csv_file: TextIO = self.csv_path.open("w", encoding="utf-8", newline="")
        self._csv: csv.DictWriter | None = None
        self._bytes = 0
        if self._fields:
            # Carrying a schema over from the previous segment (size roll, or a
            # widening — see write()): write its header straight away.
            self._csv = csv.DictWriter(self._csv_file, fieldnames=list(self._fields))
            self._csv.writeheader()

    def _rotate(self) -> None:
        self._jsonl.close()
        self._csv_file.close()
        self._segment += 1
        self._open_segment()

    def write(self, frame: dict[str, Any]) -> None:
        # Stamp wall-clock arrival time. Packet-borne times are not a substitute:
        # SRAD's timestamp_ms is milliseconds since FC boot, APRS `timestamp` is
        # absent on most packet types, and neither tells you when *we* saw it.
        # Both forms go in — epoch for sorting/joining, ISO-8601 UTC because a
        # bare float is unreadable in a spreadsheet.
        stamped = {**_stamp(), **frame}
        flat = _flatten(stamped)

        # A CSV header is fixed once written, but these frames are not a fixed
        # shape: an APRS packet carrying `position` flattens to position.lat /
        # position.lon / ... while a non-position one flattens to a single
        # `position` (None) column. Whichever arrived first used to freeze the
        # header, and DictWriter silently drops keys that aren't in it — so a
        # recording that opened on a no-fix packet lost every coordinate that
        # followed. Keep a monotonically growing union of every field seen and
        # start a fresh segment whenever it widens, so nothing is dropped and
        # already-written rows stay valid under their own header. Rotate before
        # either write, so a packet's JSONL line and CSV row land in the same
        # segment.
        new_fields = [k for k in flat if k not in self._field_set]
        if new_fields:
            widened = bool(self._fields)
            self._fields.extend(new_fields)
            self._field_set.update(new_fields)
            if widened:
                log.info(
                    "%s log schema widened (+%s); rolling to a new segment",
                    self.source, ", ".join(new_fields),
                )
                self._rotate()
            else:
                self._csv = csv.DictWriter(self._csv_file, fieldnames=list(self._fields))
                self._csv.writeheader()

        line = json.dumps(stamped) + "\n"
        self._jsonl.write(line)
        if self._csv is not None:
            self._csv.writerow({k: flat.get(k, "") for k in self._fields})
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

    # One-shot "log now" snapshotting was removed 2026-08-02: continuous Record
    # is the only capture path, so every logged packet goes through _Recorder and
    # gets the same stamping, schema-widening and rotation handling.

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
