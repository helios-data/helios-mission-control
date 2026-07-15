#!/usr/bin/env bash
set -euo pipefail

# entrypoint.sh — launched by helios-launcher inside the container.
# Env flags (sibling-repo convention):
#   VERBOSE=1     -> debug logging
#   STANDALONE=1  -> run UI with internal fake-data generator, no core connection
#   PORT          -> listen port (default 8090)

PORT="${PORT:-8090}"
LOG_LEVEL="info"
[ "${VERBOSE:-0}" = "1" ] && LOG_LEVEL="debug"

# Optional go2rtc sidecar (webrtc-url video mode). Owns the USB capture card and
# restreams it as WHEP for both OBS and the overlay. Enable with GO2RTC=1.
if [ "${GO2RTC:-0}" = "1" ] && command -v go2rtc >/dev/null 2>&1; then
    echo "[mission-control] starting go2rtc sidecar (:1984)"
    go2rtc -config go2rtc.yaml &
fi

echo "[mission-control] starting on :${PORT} (STANDALONE=${STANDALONE:-0}, VERBOSE=${VERBOSE:-0})"

exec uv run uvicorn src.main:app \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --log-level "${LOG_LEVEL}"
