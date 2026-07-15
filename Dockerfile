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
# `uv run` auto-syncs the project before running, which would try to build+install
# the root package (needs README.md, not shipped in the image) and fail. The venv is
# fully prepared by the explicit `uv sync` below, so skip that implicit sync entirely.
# Applies to both the proto compile step and the entrypoint's `uv run uvicorn`.
ENV UV_NO_SYNC=1
# build-essential + protobuf-compiler/libprotobuf-dev provide the system `protoc`
# used to compile the betterproto2 protos below; git is needed for submodule/SDK installs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    protobuf-compiler \
    libprotobuf-dev \
    && rm -rf /var/lib/apt/lists/*

# uv for dependency management (matches sibling repos)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app

# Dependency layer. The dev extra brings betterproto2-compiler (the protoc plugin)
# so the proto compile step below works. (STANDALONE mode needs neither protos nor SDK.)
# --no-install-project: install only deps here — the root package's build needs
# README.md + src/ which aren't copied yet, and the app runs `src.main` from /app
# (not as an installed package) so it never needs installing anyway.
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --extra dev --no-install-project

# Submodules + proto sources (helios-launcher checks these out before building).
COPY helios-python-sdk/ ./helios-python-sdk/
COPY falcon-protos/ ./falcon-protos/
COPY protos-proposed/ ./protos-proposed/
# Install the Helios SDK (its build hook regenerates protos, incl. AprsPacket,
# from the nested helios-protos submodule) — only if the submodule is present.
RUN if [ -f helios-python-sdk/pyproject.toml ]; then uv pip install -e helios-python-sdk; fi

# Application source + compiled protos (betterproto2) + built frontend.
COPY src/ ./src/
# Compile falcon-protos + protos-proposed with the system protoc. The betterproto2
# plugin (protoc-gen-python_betterproto2, installed by betterproto2-compiler into
# .venv/bin) is auto-discovered from PATH under `uv run`. Skipped in STANDALONE
# builds where the proto submodules are absent.
RUN if [ -f falcon-protos/TelemetryPacket.proto ]; then \
      mkdir -p src/generated && \
      uv run protoc \
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
