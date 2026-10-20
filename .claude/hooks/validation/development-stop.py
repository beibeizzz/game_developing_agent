#!/usr/bin/env python3
# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Read the existing development gate and authoritative pipeline identity for Stop."""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "game_developing_agent-mcp" / "src"))


def evaluate(repo: Path, game: Path) -> dict:
    from game_developing_agent_mcp.config import Config
    from game_developing_agent_mcp.server import ServerState, ToolCtx
    from game_developing_agent_mcp.tools.development_tools import development_gate
    from game_developing_agent_mcp.tools.verify_tools import _require_pipeline_identity

    config = Config.from_env(config_path=repo / "game_developing_agent.config.yaml")
    state = json.loads((game / ".playtest/state.json").read_text(encoding="utf-8"))
    spec = json.loads((game / "game-spec.json").read_text(encoding="utf-8"))
    if (
        not config.verify.development_enabled
        or spec.get("validation_profile") != "development"
        or (state.get("details") or {}).get("acceptance_profile") != "development"
    ):
        raise ValueError(
            "Development Stop requires enabled config and matching spec/state development profiles"
        )
    # This is the same state/resume transaction, guarded-counter and current digest
    # authority used by the verification producer. Stop performs no state writes.
    identity = _require_pipeline_identity(
        game, ToolCtx(ServerState(config=config, repo_root=repo))
    )
    next_action = (
        "game_developing_agent verify --project "
        + shlex.quote(str(game))
        + " --profile development --vision"
    )
    phase = state.get("phase")
    phase_status = state.get("phase_status")
    if phase == "development_pending_external":
        if phase_status != "blocked" or not state.get("next_action"):
            raise ValueError(
                "External development handoff requires blocked state and next_action"
            )
        return {
            "status": "blocked",
            "development_ready": False,
            "ready_to_ship": False,
            "issues": (state.get("details") or {}).get("issues")
            or ["Independent outer Seed visual acceptance is pending"],
            "next_action": next_action,
        }
    if phase != "development_verify":
        raise ValueError(
            "Development Stop requires a development verification or external handoff phase"
        )
    report = json.loads(
        (game / ".playtest/verify/verify-report.json").read_text(encoding="utf-8")
    )
    run = json.loads(
        (game / ".playtest/verify/current-run.json").read_text(encoding="utf-8")
    )
    if (
        run.get("mode") != "development"
        or run.get("status") != "finalized"
        or report.get("mode") != "development"
        or not run.get("verify_run_id")
        or any(
            report.get(key) != run.get(key)
            for key in (
                "pipeline_run_id",
                "build_digest",
                "verify_run_id",
            )
        )
        or any(run.get(key) != value for key, value in identity.items())
        or any(
            run.get(key) != state.get(key)
            for key in (
                "quality_profile",
                "level_model",
            )
        )
    ):
        raise ValueError(
            "Development report/current-run identity is stale or mismatched"
        )
    gate = development_gate(report, identity["build_digest"])
    expected_phase_status = "completed" if gate["development_ready"] else "blocked"
    if phase_status != expected_phase_status or any(
        report.get(key) != gate[key]
        for key in (
            "status",
            "development_ready",
            "ready_to_ship",
        )
    ):
        raise ValueError(
            "Development report and state must preserve the current gate verdict"
        )
    return {
        **gate,
        "next_action": "Development acceptance complete"
        if gate["development_ready"]
        else next_action,
    }


def main() -> int:
    from game_developing_agent_mcp.errors import ToolError

    try:
        result = evaluate(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    except (OSError, ValueError, TypeError, KeyError, ToolError) as exc:
        print(f"Development Stop evidence invalid: {exc}", file=sys.stderr)
        return 2
    label = "PASS" if result["development_ready"] else "BLOCKED"
    message = (
        f"Development acceptance {label}; ready_to_ship=false. "
        + "; ".join(str(issue) for issue in result["issues"])
        + f" Next action: {result['next_action']}"
    )
    print(json.dumps({"systemMessage": message, **result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
