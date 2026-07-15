"""On-the-fly map tile caching proxy.

Serves slippy-map raster tiles from a local on-disk cache. On a cache miss it
fetches the tile from an upstream tile server (when the container has internet),
saves it, and serves it — so tiles viewed once are available offline for the
container's lifetime. A best-effort startup pre-warm downloads tiles around the
configured coordinates so the launch-site map works with no connectivity.

Config (mission_config.json -> "map"):
  {
    "tile_url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "prewarm": {"enabled": true, "radius_km": 12, "min_zoom": 9, "max_zoom": 14},
    "user_agent": "helios-mission-control/0.1 (UBC Rocket)"
  }
Upstream is only contacted for tiles not already cached. Respect the upstream
tile server's usage policy (OSM: set a real User-Agent, keep prewarm modest).
"""

from __future__ import annotations

import asyncio
import logging
import math
import urllib.request
from pathlib import Path

log = logging.getLogger("mission-control.tiles")

DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
DEFAULT_UA = "helios-mission-control/0.1 (UBC Rocket; +https://ubcrocket.com)"
# 1x1 transparent PNG returned when a tile is neither cached nor fetchable.
_BLANK_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000d49444154789c6360000002000100"
    "05fe02fea7d3b6b40000000049454e44ae426082"
)


def deg2num(lat: float, lon: float, z: int) -> tuple[int, int]:
    lat_r = math.radians(lat)
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


class TileCache:
    def __init__(self, cache_dir: str, config: dict | None = None) -> None:
        cfg = config or {}
        self.dir = Path(cache_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.tile_url = cfg.get("tile_url", DEFAULT_TILE_URL)
        self.user_agent = cfg.get("user_agent", DEFAULT_UA)
        self.prewarm_cfg = cfg.get("prewarm", {})
        self.online = True  # flips false after a failed fetch, avoids hammering

    def _path(self, z: int, x: int, y: int) -> Path:
        return self.dir / str(z) / str(x) / f"{y}.png"

    async def get(self, z: int, x: int, y: int) -> tuple[bytes, bool]:
        """Return (png_bytes, is_real). is_real=False -> blank placeholder tile."""
        p = self._path(z, x, y)
        if p.exists():
            return p.read_bytes(), True
        if not self.online:
            return _BLANK_PNG, False
        data = await asyncio.to_thread(self._fetch, z, x, y)
        if data is None:
            return _BLANK_PNG, False
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return data, True

    def _fetch(self, z: int, x: int, y: int) -> bytes | None:
        url = self.tile_url.format(z=z, x=x, y=y)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
            with urllib.request.urlopen(req, timeout=6) as resp:  # noqa: S310 - fixed template
                if resp.status == 200:
                    return resp.read()
        except Exception as exc:  # noqa: BLE001
            log.debug("tile fetch failed (%s); assuming offline", exc)
            self.online = False
        return None

    async def prewarm(self, lat: float, lon: float) -> None:
        cfg = self.prewarm_cfg
        if not cfg.get("enabled", True):
            return
        radius_km = float(cfg.get("radius_km", 12))
        z0, z1 = int(cfg.get("min_zoom", 9)), int(cfg.get("max_zoom", 14))
        dlat = radius_km / 111.0
        dlon = radius_km / (111.0 * max(0.1, math.cos(math.radians(lat))))
        fetched = 0
        sem = asyncio.Semaphore(4)

        async def one(z: int, x: int, y: int) -> None:
            nonlocal fetched
            if self._path(z, x, y).exists() or not self.online:
                return
            async with sem:
                _, real = await self.get(z, x, y)
                if real:
                    fetched += 1

        tasks = []
        for z in range(z0, z1 + 1):
            x_min, y_max = deg2num(lat - dlat, lon - dlon, z)
            x_max, y_min = deg2num(lat + dlat, lon + dlon, z)
            for x in range(min(x_min, x_max), max(x_min, x_max) + 1):
                for y in range(min(y_min, y_max), max(y_min, y_max) + 1):
                    tasks.append(one(z, x, y))
        log.info("tile prewarm: %d tiles around (%.4f, %.4f) r=%.0fkm z%d-%d",
                 len(tasks), lat, lon, radius_km, z0, z1)
        await asyncio.gather(*tasks, return_exceptions=True)
        if fetched:
            log.info("tile prewarm cached %d new tiles", fetched)
        elif not self.online:
            log.info("tile prewarm skipped (offline); serving whatever is already cached")
