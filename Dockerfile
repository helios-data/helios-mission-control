# ---- Frontend build stage ----
FROM node:24-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- Python runtime stage ----
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# uv for dependency management (matches sibling repos)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app

# Dependency layer. Dev extras bring grpcio-tools + betterproto2-compiler so the
# proto compile step below works. (STANDALONE mode needs neither protos nor SDK.)
# --no-install-project: install only deps here — the root package's build needs
# README.md + src/ which aren't copied yet, and the app runs `src.main` from /app
# (not as an installed package) so it never needs installing anyway.
COPY pyproject.toml uv.lock* ./
RUN uv sync --extra dev --no-install-project

# Submodules + proto sources (helios-launcher checks these out before building).
COPY helios-python-sdk/ ./helios-python-sdk/
COPY falcon-protos/ ./falcon-protos/
COPY protos-proposed/ ./protos-proposed/
# Install the Helios SDK (its build hook regenerates protos, incl. AprsPacket,
# from the nested helios-protos submodule) — only if the submodule is present.
RUN if [ -f helios-python-sdk/pyproject.toml ]; then uv pip install -e helios-python-sdk; fi

# Application source + compiled protos (betterproto2) + built frontend.
COPY src/ ./src/
RUN PLUGIN=$(find .venv -name 'protoc-gen-python_betterproto2*' | head -1); \
    if [ -n "$PLUGIN" ] && [ -f falcon-protos/TelemetryPacket.proto ]; then \
      mkdir -p src/generated && \
      uv run python -m grpc_tools.protoc \
        --plugin=protoc-gen-python_betterproto2=$PLUGIN \
        -I falcon-protos -I protos-proposed \
        --python_betterproto2_out=src/generated \
        $(find falcon-protos protos-proposed -name '*.proto'); \
    else echo "protos not compiled (submodule absent) — STANDALONE only"; fi

COPY --from=frontend /build/dist ./frontend/dist
COPY assets/ ./assets/
COPY mission_config.json entrypoint.sh ./
RUN mkdir -p /app/logs && chmod +x entrypoint.sh

EXPOSE 8090
ENTRYPOINT ["./entrypoint.sh"]
