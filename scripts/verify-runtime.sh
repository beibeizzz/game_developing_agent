#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE="$ROOT/.game_developing_agent/counted-runtime-probe.json"
OUTPUT="$ROOT/.game_developing_agent/runtime-bounds.json"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --evidence) EVIDENCE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo 'Usage: bash scripts/verify-runtime.sh [--evidence FILE] [--output FILE]' >&2; exit 2 ;;
  esac
done
bash "$ROOT/scripts/run.sh" python "$ROOT/scripts/probe-counted-runtime.py" --output "$EVIDENCE"
bash "$ROOT/scripts/run.sh" python "$ROOT/scripts/configure-counted-runtime.py" --evidence "$EVIDENCE" --output "$OUTPUT"
