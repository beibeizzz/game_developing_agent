#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="${GAME_DEVELOPING_AGENT_LOCAL_TOOLS_DIR:-$ROOT/.tools}"
export PATH="$TOOLS/node/bin:$HOME/.local/bin:$PATH"
command -v node >/dev/null || { echo 'Node.js 22.12+ is required.' >&2; exit 2; }
command -v uv >/dev/null || { echo 'Install uv: https://docs.astral.sh/uv/' >&2; exit 2; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<12))process.exit(2)'
EXTRAS=()
if [ "${1:-}" = '--dev' ]; then EXTRAS=(--extra dev); shift; fi
if [ "$#" -gt 0 ]; then echo 'Usage: bash scripts/setup.sh [--dev]' >&2; exit 2; fi
mkdir -p "$TOOLS"
npm install --prefix "$TOOLS" --no-audit --no-fund @anthropic-ai/claude-code@2.1.303 playwright@1.64.1
"$TOOLS/node_modules/.bin/playwright" install chromium
export UV_PROJECT_ENVIRONMENT="${GAME_DEVELOPING_AGENT_PYTHON_ENV:-$ROOT/game_developing_agent-mcp/.venv}"
uv sync --directory "$ROOT/game_developing_agent-mcp" --locked --python 3.11 "${EXTRAS[@]}"
printf '%s\n' 'game_developing_agent installed. Run bash scripts/verify-runtime.sh for the offline runtime check.'
