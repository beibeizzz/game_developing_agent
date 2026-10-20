# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Bundled runner scripts shipped with game_developing_agent-mcp.

Layout:
  assets/  — Pillow-based asset post-processing (Python).
  verify/  — Playwright / Doubao video analysis (Node.js .mjs).

Subprocess invocations go through :mod:`game_developing_agent_mcp.adapters.script_runner`,
which exposes a ``runner_path(group, name)`` helper.
"""
