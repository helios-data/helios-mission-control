"""REST API: history backfill, config, packet logging, commands, mission clock."""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from ..commands import CommandError

log = logging.getLogger("mission-control.rest")
router = APIRouter(prefix="/api")


def _mission(req: Request):
    return req.app.state.mission


# ---- history -------------------------------------------------------------
@router.get("/history/srad")
async def history_srad(req: Request, since: int | None = None, limit: int = 2000) -> dict[str, Any]:
    return _history(list(_mission(req).srad_history), since, limit)


@router.get("/history/cots")
async def history_cots(req: Request, since: int | None = None, limit: int = 2000) -> dict[str, Any]:
    return _history(list(_mission(req).cots_history), since, limit, key="counter")


def _history(items: list[dict], since: int | None, limit: int, key: str = "counter") -> dict[str, Any]:
    if since is not None:
        items = [it for it in items if (it.get(key) or 0) > since]
    items = items[-max(1, min(limit, 20000)):]
    return {"count": len(items), "items": items}


# ---- config --------------------------------------------------------------
@router.get("/config")
async def get_config(req: Request) -> dict[str, Any]:
    return _mission(req).config


class ConfigPatch(BaseModel):
    # Locally-owned, editable subset (§3.2, Open Question 3).
    callsign: str | None = None
    rocket_name: str | None = None
    expected_apogee_m: float | None = None
    ui: dict[str, Any] | None = None
    rfd900x: dict[str, Any] | None = None
    ground_station: dict[str, Any] | None = None


@router.patch("/config")
async def patch_config(req: Request, patch: ConfigPatch) -> dict[str, Any]:
    state = _mission(req)
    data = patch.model_dump(exclude_none=True)
    for k, v in data.items():
        if isinstance(v, dict) and isinstance(state.config.get(k), dict):
            state.config[k].update(v)
        else:
            state.config[k] = v
    req.app.state.save_config(state.config)
    await req.app.state.hub.broadcast({"type": "config", **state.config})
    return state.config


# ---- packet logging ------------------------------------------------------
@router.post("/log/{source}")
async def log_now(req: Request, source: Literal["srad", "cots"]) -> dict[str, Any]:
    state = _mission(req)
    latest = state.srad_latest if source == "srad" else state.cots_latest
    return req.app.state.logger.log_now(source, latest)


class RecordBody(BaseModel):
    action: Literal["start", "stop"]


@router.post("/record/{source}")
async def record(req: Request, source: Literal["srad", "cots"], body: RecordBody) -> dict[str, Any]:
    logger = req.app.state.logger
    if body.action == "start":
        return logger.start_recording(source)
    return logger.stop_recording(source)


@router.get("/record")
async def record_status(req: Request) -> dict[str, Any]:
    logger = req.app.state.logger
    return {s: logger.recording_status(s) for s in ("srad", "cots")}


@router.get("/logs")
async def list_logs(req: Request) -> dict[str, Any]:
    return {"files": req.app.state.logger.list_logs()}


@router.get("/logs/{name}")
async def download_log(req: Request, name: str) -> FileResponse:
    path = req.app.state.logger.resolve(name)
    if path is None:
        raise HTTPException(404, "log not found")
    return FileResponse(path, filename=name)


# ---- commands ------------------------------------------------------------
class CommandBody(BaseModel):
    type: Literal["rfd_config", "camera"]
    payload: dict[str, Any]
    operator: str = "operator"
    override: bool = False


@router.post("/command")
async def post_command(req: Request, body: CommandBody) -> dict[str, Any]:
    mgr = req.app.state.commands
    try:
        rec = await mgr.issue(body.type, body.payload, body.operator, body.override)
    except CommandError as exc:
        raise HTTPException(409, str(exc)) from exc
    return rec.frame()


@router.get("/commands")
async def command_history(req: Request) -> dict[str, Any]:
    return {"commands": req.app.state.commands.history(),
            "camera_state": req.app.state.commands.camera_state}


# ---- map tiles (offline-caching proxy) -----------------------------------
@router.get("/tiles/{z}/{x}/{y}.png")
async def tile(req: Request, z: int, x: int, y: int) -> Response:
    if not (0 <= z <= 22 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise HTTPException(404, "tile out of range")
    data, real = await req.app.state.tiles.get(z, x, y)
    # Cache real tiles hard (immutable for the container's life); don't cache blanks.
    headers = {"Cache-Control": "public, max-age=31536000, immutable"} if real else {"Cache-Control": "no-store"}
    return Response(content=data, media_type="image/png", headers=headers)


# ---- mission clock -------------------------------------------------------
class ClockBody(BaseModel):
    action: Literal["arm", "reset", "liftoff"]
    seconds: float = 0.0


@router.post("/clock")
async def clock(req: Request, body: ClockBody) -> dict[str, Any]:
    state = _mission(req)
    if body.action == "arm":
        state.arm_countdown(body.seconds)
    elif body.action == "reset":
        state.reset_clock()
    elif body.action == "liftoff":
        state.force_liftoff()
    snap = state.mission_snapshot()
    await req.app.state.hub.broadcast(snap)
    return snap
