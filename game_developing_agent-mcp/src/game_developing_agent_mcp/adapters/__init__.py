# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Adapters wrap external APIs / SDKs behind a uniform interface.

Each adapter:
- Pulls credentials/endpoints from :mod:`game_developing_agent_mcp.config`.
- Translates HTTP / SDK errors into :class:`game_developing_agent_mcp.errors.ToolError`
  with a stable code so the MCP layer can render a consistent payload.
- Has zero coupling to the MCP server module — testable in isolation.
"""
