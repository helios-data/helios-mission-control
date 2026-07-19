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

echo "[mission-control] starting on :${PORT} (STANDALONE=${STANDALONE:-0}, VERBOSE=${VERBOSE:-0})"

exec uv run uvicorn src.main:app \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --log-level "${LOG_LEVEL}"
