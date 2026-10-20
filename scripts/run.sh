#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="${GAME_DEVELOPING_AGENT_LOCAL_TOOLS_DIR:-$ROOT/.tools}"
export UV_PROJECT_ENVIRONMENT="${GAME_DEVELOPING_AGENT_PYTHON_ENV:-$ROOT/game_developing_agent-mcp/.venv}"
export PATH="$UV_PROJECT_ENVIRONMENT/bin:$TOOLS/node/bin:$TOOLS/node_modules/.bin:$HOME/.local/bin:$PATH"
export GAME_DEVELOPING_AGENT_REPO_ROOT="$ROOT"
export GAME_DEVELOPING_AGENT_PYTHON_EXECUTABLE="$UV_PROJECT_ENVIRONMENT/bin/python"
export GAME_DEVELOPING_AGENT_CLAUDE_EXECUTABLE="$TOOLS/node_modules/.bin/claude"
export NODE_PATH="$TOOLS/node_modules"
if [ ! -x "$GAME_DEVELOPING_AGENT_PYTHON_EXECUTABLE" ]; then
  printf '%s\n' 'Run bash scripts/setup.sh from this checkout first.' >&2
  exit 2
fi
cd "$ROOT/game_developing_agent-mcp"
exec "$@"
