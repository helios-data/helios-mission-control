"""Tests for the tile-caching proxy (offline behavior + tile math)."""

from __future__ import annotations

from src.tiles import _BLANK_PNG, TileCache, deg2num


def test_deg2num_known_value():
    # Spaceport America (~32.99, -106.97) at zoom 12.
    x, y = deg2num(32.99, -106.97, 12)
    assert (x, y) == (830, 1650)


def test_deg2num_clamps_in_range():
    for z in range(0, 6):
        x, y = deg2num(85.0, 179.0, z)
        assert 0 <= x < 2 ** z and 0 <= y < 2 ** z


async def test_offline_miss_returns_blank(tmp_path):
    cache = TileCache(str(tmp_path))
    cache.online = False  # simulate no connectivity
    data, real = await cache.get(12, 831, 1652)
    assert real is False
    assert data == _BLANK_PNG
    # Nothing should have been written for a blank tile.
    assert not (tmp_path / "12").exists()


async def test_cache_hit_reads_from_disk(tmp_path):
    cache = TileCache(str(tmp_path))
    p = cache._path(10, 1, 2)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x89PNG-cached")
    cache.online = False  # ensure no network path is taken
    data, real = await cache.get(10, 1, 2)
    assert real is True
    assert data == b"\x89PNG-cached"
