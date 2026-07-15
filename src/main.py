"""Application entrypoint: SDK/standalone tasks + FastAPI (WS + REST + static UI).

Run:  uv run uvicorn src.main:app --port 8090
Env:  STANDALONE=1 (internal fake data), VERBOSE=1 (debug logging).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .api import rest, ws
from .commands import CommandManager, attach_standalone_simulator
from .hub import ConnectionHub
from .packet_log import PacketLogger
from .state import MissionState
from .tiles import TileCache

ROOT = Path(__file__).resolve().parent.parent
# Base/default config, baked into the image; the only source in STANDALONE/dev.
CONFIG_PATH = ROOT / "mission_config.json"
# Optional override linked in by helios-launcher (declared as a "file" link in
# config.json, exactly like a volume). Deep-merged on top of the base so the
# launcher's per-rocket file (CloudBurst-IREC2026.json) only needs to carry the
# fields it owns; UI defaults fall through from the base. See Open Question 3.
LINKED_CONFIG_PATH = Path(os.getenv("MISSION_CONFIG", "/app/config/mission_config.json"))
# When the linked file is a launcher rocket file (component configs under
# "nodes"), pull this node's mission config out of it.
MISSION_NODE = os.getenv("MISSION_CONFIG_NODE", "MissionControl")
FRONTEND_DIST = ROOT / "frontend" / "dist"
ASSETS_DIR = ROOT / "assets"

logging.basicConfig(
    level=logging.DEBUG if os.getenv("VERBOSE") == "1" else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("mission-control")


def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge ``over`` onto ``base`` (nested dicts merged, not replaced)."""
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


# Top-level keys the launcher owns (its component tree etc.) — NOT part of our
# mission config. Kept out of our in-memory config and preserved on write-back so
# admin edits never clobber the launcher's data.
_LAUNCHER_KEYS = ("nodes",)


def _extract_override(raw: Any) -> tuple[dict[str, Any], str]:
    """Pull our mission config out of a launcher-linked file.

    Three accepted shapes, returning ``(override, writeback)``:

    - **plain** — a bare mission-config document (no launcher keys) → ``"direct"``
      (write our config straight back).
    - **sibling** *(the CloudBurst-IREC2026 layout)* — our mission-config fields
      at the top level **beside** a launcher ``nodes`` component tree → strip the
      launcher keys; ``"preserve"`` (on write, splice our fields back into the
      on-disk file so ``nodes`` survives).
    - **nested** — no top-level config, only a launcher rocket file; pull
      ``nodes.<MISSION_NODE>.mission_config`` → ``"readonly"`` (never written).
    """
    if not isinstance(raw, dict):
        return {}, "direct"
    launcher_keys_present = any(k in raw for k in _LAUNCHER_KEYS)
    config_fields = {k: v for k, v in raw.items() if k not in _LAUNCHER_KEYS}
    if config_fields:
        return config_fields, ("preserve" if launcher_keys_present else "direct")
    if launcher_keys_present:
        node = raw.get("nodes", {}).get(MISSION_NODE, {})
        if isinstance(node, dict) and isinstance(node.get("mission_config"), dict):
            return node["mission_config"], "readonly"
        if isinstance(node, dict) and node:
            return node, "readonly"
    return {}, "direct"


def resolve_config() -> tuple[dict[str, Any], Path | None, str]:
    """Load the base config and deep-merge any launcher-linked override on top.

    Returns ``(config, save_path, writeback)`` — where and how live admin edits
    are persisted (see :func:`_extract_override` for the ``writeback`` modes).
    """
    if CONFIG_PATH.exists():
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    else:
        log.warning("mission_config.json not found; using defaults")
        config = {"mission_name": "MISSION", "callsign": "N0CALL", "ui": {}}

    save_path: Path | None = CONFIG_PATH
    writeback = "direct"
    standalone = os.getenv("STANDALONE") == "1"
    if (
        not standalone
        and LINKED_CONFIG_PATH.exists()
        and LINKED_CONFIG_PATH.resolve() != CONFIG_PATH.resolve()
    ):
        try:
            raw = json.loads(LINKED_CONFIG_PATH.read_text(encoding="utf-8"))
            override, writeback = _extract_override(raw)
            if override:
                config = _deep_merge(config, override)
                save_path = LINKED_CONFIG_PATH
                log.info("merged launcher config from %s (writeback=%s)", LINKED_CONFIG_PATH, writeback)
            else:
                writeback = "direct"
        except Exception as exc:  # noqa: BLE001 - never let a bad link break boot
            log.warning("ignoring unreadable linked config %s: %s", LINKED_CONFIG_PATH, exc)

    return config, save_path, writeback


def make_saver(save_path: Path | None, writeback: str):
    def save_config(cfg: dict[str, Any]) -> None:
        if writeback == "readonly" or save_path is None:
            log.info("config is launcher-provided (read-only); edit not persisted to disk")
            return
        save_path.parent.mkdir(parents=True, exist_ok=True)
        if writeback == "preserve" and save_path.exists():
            # Overlay our config onto the on-disk file so launcher keys (`nodes`,
            # …) and any other fields we don't own are kept intact.
            try:
                disk = json.loads(save_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                disk = {}
            if isinstance(disk, dict):
                cfg = _deep_merge(disk, cfg)
        save_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    return save_config


@asynccontextmanager
async def lifespan(app: FastAPI):
    config, config_save_path, config_writeback = resolve_config()
    log_dir = os.getenv("LOG_DIR", str(ROOT / "logs"))

    state = MissionState(config)
    hub = ConnectionHub()
    logger = PacketLogger(log_dir)
    commands = CommandManager(state, hub)
    state.subscribe(logger.sink)

    tile_dir = os.getenv("TILE_DIR", str(ROOT / "tiles"))
    tiles = TileCache(tile_dir, config.get("map"))

    app.state.mission = state
    app.state.hub = hub
    app.state.logger = logger
    app.state.commands = commands
    app.state.tiles = tiles
    app.state.save_config = make_saver(config_save_path, config_writeback)

    # Best-effort map-tile prewarm around the ground station (offline after this).
    gs = config.get("ground_station")
    prewarm_task = None
    if gs and gs.get("lat") is not None and gs.get("lon") is not None:
        prewarm_task = asyncio.create_task(tiles.prewarm(gs["lat"], gs["lon"]), name="tile-prewarm")

    standalone = os.getenv("STANDALONE") == "1"
    if standalone:
        from .standalone import run_standalone

        attach_standalone_simulator(commands)
        task = asyncio.create_task(run_standalone(state, hub), name="standalone")
        log.info("running in STANDALONE mode")
    else:
        from .helios_bridge import HeliosBridge

        bridge = HeliosBridge(state, hub)
        bridge.commands = commands
        _attach_bridge_publisher(bridge, commands)
        task = asyncio.create_task(bridge.run(), name="bridge")
        log.info("running in LIVE mode (connecting to Helios core)")

    try:
        yield
    finally:
        task.cancel()
        if prewarm_task is not None:
            prewarm_task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def _attach_bridge_publisher(bridge, commands: CommandManager) -> None:
    """Wire command publishing/ack to the live bridge once it's connected.

    The actual GroundCommand serialization + command_ack subscription is
    implemented against the proposed protos (protos-proposed/) and only runs
    when `make protos` has generated them. Until then this raises a clear error
    rather than silently dropping commands.
    """

    async def _publish(command_id: int, cmd_type: str, payload: dict[str, Any]) -> None:
        await bridge.publish_command(command_id, cmd_type, payload, commands)

    commands.publish_fn = _publish


def create_app() -> FastAPI:
    app = FastAPI(title="Helios Mission Control", lifespan=lifespan)
    app.include_router(ws.router)
    app.include_router(rest.router)

    # Repo assets (logos, expected_profile.csv) available to the frontend at runtime.
    if ASSETS_DIR.exists():
        app.mount("/brand", StaticFiles(directory=str(ASSETS_DIR)), name="brand")

    # Built frontend bundles (Vite base='/static/').
    if (FRONTEND_DIST / "static").exists():
        app.mount("/static", StaticFiles(directory=str(FRONTEND_DIST / "static")), name="static")
    elif FRONTEND_DIST.exists():
        app.mount("/static", StaticFiles(directory=str(FRONTEND_DIST)), name="static")

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse("/admin")

    @app.get("/admin", include_in_schema=False)
    async def admin_page() -> HTMLResponse:
        return _serve_page("admin.html")

    @app.get("/overlay", include_in_schema=False)
    async def overlay_page() -> HTMLResponse:
        return _serve_page("overlay.html")

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, Any]:
        return {"ok": True, "clients": app.state.hub.count,
                "core_connected": app.state.mission.core_connected}

    return app


def _serve_page(name: str) -> HTMLResponse:
    path = FRONTEND_DIST / name
    if not path.exists():
        return HTMLResponse(
            "<h1>Frontend not built</h1><p>Run <code>make frontend</code> "
            "(or <code>cd frontend &amp;&amp; npm run dev</code> for hot reload).</p>",
            status_code=503,
        )
    return HTMLResponse(path.read_text(encoding="utf-8"))


app = create_app()
