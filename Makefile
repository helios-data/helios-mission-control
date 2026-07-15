# Helios Mission Control — Makefile
# Mirrors sibling-repo conventions: deps / protos / run / lint targets.

.DEFAULT_GOAL := help
UV ?= uv
NPM ?= npm
PORT ?= 8090

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: deps
deps: ## Sync submodules + Python deps + frontend deps
	git submodule update --init --recursive
	$(UV) sync --extra dev
	@if [ -f helios-python-sdk/pyproject.toml ]; then \
		echo "installing helios-python-sdk (editable)"; \
		$(UV) pip install -e helios-python-sdk; \
	fi
	cd frontend && $(NPM) install

.PHONY: protos
protos: ## Compile falcon-protos + protos-proposed -> src/generated (betterproto2)
	@if [ ! -d falcon-protos ]; then \
		echo "falcon-protos submodule missing; run 'make deps' first"; exit 1; fi
	rm -rf src/generated && mkdir -p src/generated
	PLUGIN=$$(find .venv -name 'protoc-gen-python_betterproto2*' | head -1); \
	$(UV) run python -m grpc_tools.protoc \
		--plugin=protoc-gen-python_betterproto2=$$PLUGIN \
		-I falcon-protos -I protos-proposed \
		--python_betterproto2_out=src/generated \
		$$(find falcon-protos protos-proposed -name '*.proto')
	@echo "note: AprsPacket is imported from the SDK (helios.generated.helios.transport)"

.PHONY: frontend
frontend: ## Build the frontend into frontend/dist
	cd frontend && $(NPM) run build

.PHONY: run
run: ## Run mission control (set STANDALONE=1 to skip core connection)
	$(UV) run uvicorn src.main:app --host 0.0.0.0 --port $(PORT)

.PHONY: dev
dev: ## Run backend (STANDALONE) + vite dev server for frontend work
	STANDALONE=1 $(UV) run uvicorn src.main:app --host 0.0.0.0 --port $(PORT) --reload

.PHONY: sim
sim: ## Run the replay simulator against a live core
	$(UV) run python sim/replay.py

.PHONY: lint
lint: ## Lint python (ruff) + typecheck frontend
	$(UV) run ruff check src sim
	cd frontend && $(NPM) run typecheck

.PHONY: test
test: ## Run python unit tests
	$(UV) run pytest -q
