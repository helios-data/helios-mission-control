"""Find this node's own coordinates over the internet; config coords are the fallback.

`ground_station` lat/lon in `mission_config.json` is a **fallback**. It ships with
Spaceport America placeholders and goes stale the moment the box is set up
anywhere else, yet it drives the GPS map's pad marker, the downrange/bearing
readouts, the COTS AGL baseline, and the offline tile pre-warm. So at boot, if
this node has internet, we ask a public IP-geolocation service where it actually
is (and a keyless elevation service how high that is) and override the configured
values **in memory**. With no internet nothing happens and the file's coordinates
stand, which is the normal state at a launch site once the link drops.

Accuracy caveat, worth knowing before trusting it: IP geolocation is city-level
at best, and on satellite or cellular links it can report the carrier's egress
POP hundreds of km away. So a fix is never silent — `ground_station.source`
becomes `"auto"` alongside the provider and place it came from, which the admin
Configuration panel displays. An operator edit through `PATCH /api/config` sets
`source: "manual"` and outranks this permanently, and is the only version written
back to disk (see `main._persistable`). Set `ground_station.auto_locate: false`
to disable the lookup entirely.

Uses `urllib` on a worker thread, like `tiles.py` — no new dependency, and these
are the only two hosts the backend contacts on its own.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

log = logging.getLogger("mission-control.geolocate")

# Per-request budget, plus a ceiling on the whole lookup so a black-holed network
# (captive portal that accepts the connection and never answers) can't stall the
# things waiting on us — the tile pre-warm and the STANDALONE flight — for longer
# than this.
HTTP_TIMEOUT_S = 4.0
OVERALL_TIMEOUT_S = 9.0

USER_AGENT = "helios-mission-control/0.1 (UBC Rocket; +https://ubcrocket.com)"

# Keyless HTTPS IP-geolocation, tried in order; the first plausible fix wins.
IP_PROVIDERS = ("https://ipapi.co/json/", "https://ipinfo.io/json")
# IP geolocation carries no altitude, so ground elevation comes from open-meteo
# (keyless, no rate limit worth worrying about at one call per boot).
ELEVATION_URL = "https://api.open-meteo.com/v1/elevation?latitude={lat:.6f}&longitude={lon:.6f}"

# Fields `apply_fix` stamps onto the ground_station block. Runtime provenance,
# not configuration — stripped before the config is persisted.
RUNTIME_KEYS = ("source", "located_via", "located_place", "located_at")


@dataclass
class Fix:
    lat: float
    lon: float
    provider: str            # host that supplied lat/lon
    place: str | None        # "Vancouver, British Columbia, CA", when reported
    alt_m: float | None = None
    alt_provider: str | None = None


def _get_json(url: str) -> Any | None:
    """Fetch and parse JSON, or None for any failure (which just means "offline")."""
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:  # noqa: S310 - fixed https URLs
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001 - offline is the expected case, not an error
        log.debug("geolocate: %s failed (%s)", url, exc)
        return None


def _plausible(lat: float, lon: float) -> bool:
    """Range-check, and reject the 0,0 sentinel these APIs return for "unknown"."""
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return False
    return abs(lat) > 1e-6 or abs(lon) > 1e-6


def _parse_fix(url: str, data: Any) -> Fix | None:
    """Read a fix out of either provider's payload shape."""
    if not isinstance(data, dict) or data.get("error"):
        return None
    lat, lon = data.get("latitude"), data.get("longitude")
    if lat is None and isinstance(data.get("loc"), str) and "," in data["loc"]:
        lat, lon = data["loc"].split(",", 1)  # ipinfo.io packs both into "loc"
    try:
        lat, lon = float(lat), float(lon)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not _plausible(lat, lon):
        return None
    parts = [data.get("city"), data.get("region"), data.get("country_code") or data.get("country")]
    return Fix(
        lat=lat,
        lon=lon,
        provider=urlsplit(url).netloc,
        place=", ".join(str(p) for p in parts if p) or None,
    )


async def _elevation(lat: float, lon: float) -> tuple[float | None, str | None]:
    """Ground elevation at the fix, or (None, None).

    Not optional polish: COTS altitudes are shown AGL against
    `ground_station.alt_m`, so a real lat/lon left paired with the fallback's
    altitude would bias every APRS altitude readout by the difference.
    """
    url = ELEVATION_URL.format(lat=lat, lon=lon)
    data = await asyncio.to_thread(_get_json, url)
    if isinstance(data, dict):
        vals = data.get("elevation")
        if isinstance(vals, list) and vals and isinstance(vals[0], int | float):
            return round(float(vals[0]), 1), urlsplit(url).netloc
    return None, None


async def _locate() -> Fix | None:
    for url in IP_PROVIDERS:
        fix = _parse_fix(url, await asyncio.to_thread(_get_json, url))
        if fix is not None:
            fix.alt_m, fix.alt_provider = await _elevation(fix.lat, fix.lon)
            return fix
    return None


async def locate() -> Fix | None:
    """Where is this node? None when offline or when nothing plausible came back."""
    try:
        return await asyncio.wait_for(_locate(), timeout=OVERALL_TIMEOUT_S)
    except TimeoutError:
        log.info("geolocation timed out after %.0fs; keeping configured coordinates",
                 OVERALL_TIMEOUT_S)
        return None


def apply_fix(gs: dict[str, Any], fix: Fix) -> None:
    """Overlay a fix onto a `ground_station` block, in place.

    `label` is left alone (it names the marker, not the place), and so is a
    fallback `alt_m` we couldn't improve on — a stale altitude still beats none.
    """
    gs["lat"] = round(fix.lat, 6)
    gs["lon"] = round(fix.lon, 6)
    if fix.alt_m is not None:
        gs["alt_m"] = fix.alt_m
    gs["source"] = "auto"
    gs["located_via"] = fix.provider
    gs["located_place"] = fix.place
    gs["located_at"] = time.time()
