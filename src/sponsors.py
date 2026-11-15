"""Sponsor logo discovery.

Logos live in a directory linked in by helios-launcher (``/app/sponsorships``,
declared as a folder volume in ``config.json``), organised into one subfolder per
rotation section::

    /app/sponsorships/
        section1/  iFlight.png  pcbway.png  ...
        section2/  ANSYS_logo.png  ...

The overlay shows one section at a time and cycles through them. When the linked
directory is missing or empty (STANDALONE/dev), we fall back to the sample set
bundled in ``assets/sample_sponsorships`` so the overlay is never blank.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any

log = logging.getLogger("mission-control.sponsors")

ROOT = Path(__file__).resolve().parent.parent
# Launcher-linked volume (see config.json); overridable for local testing.
LINKED_SPONSOR_DIR = Path(os.getenv("SPONSOR_DIR", "/app/sponsorships"))
# Bundled sample set, used whenever the linked directory has nothing in it.
SAMPLE_SPONSOR_DIR = ROOT / "assets" / "sample_sponsorships"

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"}


def _natural_key(name: str) -> tuple[Any, ...]:
    """Sort key so ``section2`` precedes ``section10`` (and casing is ignored)."""
    return tuple(
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", name)
    )


def _images(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    files = [
        p for p in directory.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES and not p.name.startswith(".")
    ]
    return sorted(files, key=lambda p: _natural_key(p.name))


def _has_content(directory: Path) -> bool:
    if not directory.is_dir():
        return False
    if _images(directory):
        return True
    return any(_images(sub) for sub in directory.iterdir() if sub.is_dir())


def resolve_dir() -> tuple[Path | None, str]:
    """Pick the sponsor directory to serve: linked volume, else bundled samples.

    Returns ``(path, origin)`` where origin is ``"linked"``/``"sample"``/``"none"``
    — surfaced through the API so the operator can tell which set is on screen.
    """
    if _has_content(LINKED_SPONSOR_DIR):
        return LINKED_SPONSOR_DIR, "linked"
    if _has_content(SAMPLE_SPONSOR_DIR):
        return SAMPLE_SPONSOR_DIR, "sample"
    return None, "none"


def list_sections(directory: Path | None) -> list[dict[str, Any]]:
    """Enumerate rotation sections as ``[{name, logos: [url, ...]}, ...]``.

    Each subdirectory containing images is one section, ordered naturally
    (section1, section2, ... section10). Images sitting loose at the top level
    are gathered into a single implicit section so a flat folder also works.
    """
    if directory is None:
        return []

    sections: list[dict[str, Any]] = []
    subdirs = sorted(
        (p for p in directory.iterdir() if p.is_dir() and not p.name.startswith(".")),
        key=lambda p: _natural_key(p.name),
    )
    for sub in subdirs:
        images = _images(sub)
        if images:
            sections.append({
                "name": sub.name,
                "logos": [f"/sponsors/{sub.name}/{p.name}" for p in images],
            })

    loose = _images(directory)
    if loose:
        sections.append({
            "name": directory.name,
            "logos": [f"/sponsors/{p.name}" for p in loose],
        })

    return sections
