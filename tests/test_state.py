"""Unit tests for MissionState derived logic and the command interlocks."""

from __future__ import annotations

import pytest
from src.commands import CommandError, CommandManager
from src.hub import ConnectionHub
from src.state import MissionState, compute_primary_altitude

CONFIG = {"ui": {"srad_stale_seconds": 5, "cots_stale_seconds": 60}}


def _srad(**over):
    f = {
        "flight_state": "STANDBY",
        "kf_altitude": 100.0, "kf_velocity": 0.0,
        "baro0": {"healthy": True, "altitude": 1000.0},
        "baro1": {"healthy": True, "altitude": 1010.0},
        "ground_altitude": 1401.0,
        "gps": {"lat": 0, "lon": 0, "alt": 0, "speed": 0, "sats": 0, "fix": 0},
        "accel": {"x": 0, "y": 0, "z": 1}, "gyro": {"x": 0, "y": 0, "z": 0},
        "counter": 1, "timestamp_ms": 0,
    }
    f.update(over)
    return f


def test_altitude_both_baro_healthy_averages():
    alt, degraded = compute_primary_altitude(_srad())
    assert alt == pytest.approx(1005.0)
    assert degraded is False


def test_altitude_one_baro_faulted_uses_healthy():
    f = _srad(baro1={"healthy": False, "altitude": 9999.0})
    alt, degraded = compute_primary_altitude(f)
    assert alt == pytest.approx(1000.0)
    assert degraded is False


def test_altitude_no_healthy_baro_falls_back_to_kf_and_flags_degraded():
    f = _srad(baro0={"healthy": False, "altitude": 1.0}, baro1={"healthy": False, "altitude": 2.0})
    alt, degraded = compute_primary_altitude(f)
    assert alt == pytest.approx(100.0)  # kf_altitude
    assert degraded is True


def test_liftoff_starts_t_plus_and_records_transition():
    st = MissionState(CONFIG)
    st.ingest_srad(_srad(flight_state="STANDBY"))
    assert st.t_plus_s is None
    st.ingest_srad(_srad(flight_state="ASCENT"))
    assert st.t0_epoch is not None
    assert st.t_plus_s is not None
    assert any(t.state == "ASCENT" for t in st.transitions)


def test_max_trackers_and_apogee_detection():
    st = MissionState(CONFIG)
    st.ingest_srad(_srad(flight_state="ASCENT", baro0={"healthy": True, "altitude": 4000.0},
                         baro1={"healthy": True, "altitude": 4000.0}, kf_velocity=250.0))
    assert st.max_altitude_agl_m == pytest.approx(4000.0 - 1401.0)
    assert st.max_velocity_ms == pytest.approx(250.0)
    st.ingest_srad(_srad(flight_state="DROGUE_DESCENT",
                         baro0={"healthy": True, "altitude": 3900.0},
                         baro1={"healthy": True, "altitude": 3900.0}))
    assert st.apogee is not None
    assert st.apogee["altitude_agl_m"] == pytest.approx(4000.0 - 1401.0)


async def test_rfd_interlock_blocks_in_flight_without_override():
    st = MissionState(CONFIG)
    st.flight_state = "ASCENT"
    mgr = CommandManager(st, ConnectionHub())
    with pytest.raises(CommandError):
        await mgr.issue("rfd_config", {"net_id": 5}, "op", override=False)
    # override permits it (publisher missing -> ERROR ack, but no interlock raise)
    rec = await mgr.issue("rfd_config", {"net_id": 5}, "op", override=True)
    assert rec.status.value == "error"  # no publisher configured in this unit test


async def test_recording_requires_runcam_power():
    st = MissionState(CONFIG)
    mgr = CommandManager(st, ConnectionHub())
    with pytest.raises(CommandError):
        await mgr.issue("camera", {"recording": True}, "op")
