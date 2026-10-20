#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT/scripts/run.sh" python -m compileall -q src
bash "$ROOT/scripts/run.sh" pytest -q
mapfile -t TESTS < <(find "$ROOT/game_developing_agent-mcp/tests/node" -name '*.test.mjs' -type f | sort)
bash "$ROOT/scripts/run.sh" node --test "${TESTS[@]}"
