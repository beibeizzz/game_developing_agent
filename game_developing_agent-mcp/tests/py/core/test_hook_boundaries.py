# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parents[4]
SESSION_HOOKS = REPO_ROOT / ".claude" / "hooks" / "session"


def _load_boundary_module():
    module_path = SESSION_HOOKS / "guard-agent-boundary.py"
    spec = importlib.util.spec_from_file_location("guard_agent_boundary", module_path)
    assert spec is not None and spec.loader is not None
    sys.path.insert(0, str(SESSION_HOOKS))
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SESSION_HOOKS))


BOUNDARY = _load_boundary_module()
PIPELINE_SESSION = sys.modules["pipeline_session"]


def _bound_stop_hook_project(
    tmp_path: Path,
) -> tuple[Path, Path, str]:
    project = tmp_path / "repo"
    game_dir = project / "playground" / "hook-test"
    game_dir.mkdir(parents=True)
    (game_dir / ".playtest").mkdir()
    (game_dir / ".playtest" / "state.json").write_text("{}\n", encoding="utf-8")
    (project / ".claude").mkdir()
    (project / ".claude" / "hooks").symlink_to(
        REPO_ROOT / ".claude" / "hooks",
        target_is_directory=True,
    )
    (project / "game_developing_agent.config.yaml").symlink_to(REPO_ROOT / "game_developing_agent.config.yaml")

    session_id = "stop-hook-session"
    binding_file, _marker, _closed = PIPELINE_SESSION.binding_paths(
        project,
        session_id,
    )
    binding_file.parent.mkdir(parents=True)
    binding_file.write_text(
        json.dumps(
            {
                "schema_version": PIPELINE_SESSION.SCHEMA_VERSION,
                "kind": "pipeline-session",
                "session_id": session_id,
                "workspace_mode": "resume",
                "game_dir": str(game_dir),
                "game_slug": game_dir.name,
            }
        ),
        encoding="utf-8",
    )
    return project, binding_file, session_id


def _run_stop_hook(
    project: Path,
    session_id: str,
    background_tasks: object,
) -> subprocess.CompletedProcess[str]:
    payload = {
        "session_id": session_id,
        "cwd": str(project),
        "hook_event_name": "Stop",
        "stop_hook_active": False,
        "last_assistant_message": "Waiting for background work.",
        "background_tasks": background_tasks,
        "session_crons": [],
    }
    return subprocess.run(
        ["bash", str(REPO_ROOT / ".claude" / "hooks" / "enforce-pipeline.sh")],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "CLAUDE_PROJECT_DIR": str(project)},
    )


@pytest.mark.parametrize(
    "authority",
    ["pipeline-orchestrator", *sorted(BOUNDARY.PIPELINE_AGENTS)],
)
def test_pipeline_authorities_cannot_directly_write_state_json(authority: str) -> None:
    assert not BOUNDARY.write_allowed(authority, Path(".playtest/state.json"))


def test_boundary_still_exposes_each_authority_owned_write() -> None:
    assert BOUNDARY.write_allowed("pipeline-orchestrator", Path("PROMPT.md"))
    assert BOUNDARY.write_allowed("design-agent", Path("GAME_DESIGN.md"))
    assert BOUNDARY.write_allowed("level-design-agent", Path("levels/stage_1.json"))
    assert BOUNDARY.write_allowed("implement-agent", Path("src/main.js"))
    assert BOUNDARY.write_allowed("scaffold-agent", Path("src/main.js"))
    assert BOUNDARY.write_allowed(
        "verify-agent",
        Path(".playtest/tests/smoke.test.mjs"),
    )


def test_scaffold_cannot_write_implement_owned_level_adapters() -> None:
    assert not BOUNDARY.write_allowed(
        "scaffold-agent",
        Path("src/level/LevelLoader.js"),
    )
    assert BOUNDARY.write_allowed(
        "implement-agent",
        Path("src/level/LevelLoader.js"),
    )


def test_prompt_archive_allows_one_literal_copy_into_active_game(
    tmp_path: Path,
) -> None:
    source = tmp_path / "game_prompts" / "Prompt.md"
    source.parent.mkdir()
    source.write_text("Build a game.\n", encoding="utf-8")
    active = tmp_path / "repo" / "playground" / "game"
    active.mkdir(parents=True)
    destination = active / "PROMPT.md"
    payload = {"cwd": str(tmp_path)}
    tokens = BOUNDARY.shell_tokens(f'cp "{source}" "{destination}"')

    assert tokens is not None
    assert BOUNDARY.prompt_archive_command_allowed(
        tokens,
        payload,
        active,
    )
    BOUNDARY.enforce_shell(
        {
            **payload,
            "tool_input": {"command": f'cp "{source}" "{destination}"'},
            "agent_type": None,
            "agent_id": None,
        },
        "valid",
        {"game_dir": str(active)},
        b"binding",
    )


def test_prompt_archive_rejects_compound_overwrite_and_non_prompt_sources(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Prompt.md"
    source.write_text("Build a game.\n", encoding="utf-8")
    secret = tmp_path / ".env"
    secret.write_text("SECRET=value\n", encoding="utf-8")
    active = tmp_path / "repo" / "playground" / "game"
    active.mkdir(parents=True)
    destination = active / "PROMPT.md"
    payload = {"cwd": str(tmp_path)}

    assert (
        BOUNDARY.shell_tokens(f'cp "{source}" "{destination}" && echo archived') is None
    )
    assert not BOUNDARY.prompt_archive_command_allowed(
        ["cp", str(secret), str(destination)],
        payload,
        active,
    )
    assert not BOUNDARY.prompt_archive_command_allowed(
        ["cp", str(source), str(active / "OTHER.md")],
        payload,
        active,
    )

    destination.write_text("canonical\n", encoding="utf-8")
    assert not BOUNDARY.prompt_archive_command_allowed(
        ["cp", str(source), str(destination)],
        payload,
        active,
    )


def test_pipeline_background_tasks_include_only_owned_workers() -> None:
    tasks = PIPELINE_SESSION.pipeline_background_tasks(
        {
            "background_tasks": [
                {
                    "id": "asset-worker",
                    "type": "subagent",
                    "status": "running",
                    "agent_type": "assets-agent",
                },
                {
                    "id": "implementation",
                    "type": "workflow",
                    "status": "running",
                    "name": "Implement scenes",
                },
                {
                    "id": "server",
                    "type": "shell",
                    "status": "running",
                },
                {
                    "id": "explorer",
                    "type": "subagent",
                    "status": "running",
                    "agent_type": "Explore",
                },
                {
                    "id": "finished-asset-worker",
                    "type": "subagent",
                    "status": "completed",
                    "agent_type": "assets-agent",
                },
                {
                    "id": "asset-worker",
                    "type": "subagent",
                    "status": "running",
                    "agent_type": "assets-agent",
                },
            ]
        }
    )

    assert tasks == [
        {
            "id": "asset-worker",
            "type": "subagent",
            "status": "running",
            "agent_type": "assets-agent",
        },
        {
            "id": "implementation",
            "type": "workflow",
            "status": "running",
            "name": "Implement scenes",
        },
    ]


@pytest.mark.parametrize("background_tasks", [None, {}, "running"])
def test_pipeline_background_tasks_fail_closed_on_invalid_registry(
    background_tasks: object,
) -> None:
    assert (
        PIPELINE_SESSION.pipeline_background_tasks(
            {"background_tasks": background_tasks}
        )
        == []
    )


def test_stop_hook_allows_pipeline_background_pause_and_resets_counter(
    tmp_path: Path,
) -> None:
    project, binding_file, session_id = _bound_stop_hook_project(tmp_path)
    counter = Path(f"{binding_file}.block_count")
    counter.write_text("4\n", encoding="utf-8")

    result = _run_stop_hook(
        project,
        session_id,
        [
            {
                "id": "asset-worker",
                "type": "subagent",
                "status": "running",
                "agent_type": "assets-agent",
            }
        ],
    )

    assert result.returncode == 0, result.stderr
    assert not counter.exists()
    assert "CANNOT STOP" not in result.stderr


def test_stop_hook_does_not_treat_background_shell_as_pipeline_worker(
    tmp_path: Path,
) -> None:
    project, binding_file, session_id = _bound_stop_hook_project(tmp_path)

    result = _run_stop_hook(
        project,
        session_id,
        [
            {
                "id": "game-server",
                "type": "shell",
                "status": "running",
                "command": "serve_game.py",
            }
        ],
    )

    assert result.returncode == 2
    assert "CANNOT STOP (1/5)" in result.stderr
    assert (
        Path(f"{binding_file}.block_count").read_text(encoding="utf-8").strip() == "1"
    )


def test_stop_hook_routes_startup_without_running_release_checklist(
    tmp_path: Path,
) -> None:
    project, _binding_file, session_id = _bound_stop_hook_project(tmp_path)
    game_dir = project / "playground" / "hook-test"
    (game_dir / ".playtest" / "state.json").write_text(
        json.dumps(
            {
                "phase": "startup",
                "currentStep": "design",
                "phase_status": "completed",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (game_dir / ".playtest" / "resume.json").write_text(
        json.dumps({"next_action": "Dispatch design-agent"}) + "\n",
        encoding="utf-8",
    )

    result = _run_stop_hook(project, session_id, [])

    assert result.returncode == 2
    assert "phase=startup, step=design, status=completed" in result.stderr
    assert "ACTION REQUIRED: Dispatch design-agent" in result.stderr
    assert "index.html missing phaser@4" not in result.stderr
    assert "ready_to_ship" not in result.stderr


def test_stop_hook_blocks_bound_workspace_before_bootstrap_state(
    tmp_path: Path,
) -> None:
    project, _binding_file, session_id = _bound_stop_hook_project(tmp_path)
    game_dir = project / "playground" / "hook-test"
    (game_dir / ".playtest" / "state.json").unlink()

    result = _run_stop_hook(project, session_id, [])

    assert result.returncode == 2
    assert ".playtest/state.json has not been created" in result.stderr
    assert "mcp__game_developing_agent__write_pipeline_state" in result.stderr


def _run_close_workspace_guard(
    project: Path,
    session_id: str,
    *,
    agent_id: str | None = None,
) -> subprocess.CompletedProcess[str]:
    payload: dict[str, object] = {
        "session_id": session_id,
        "cwd": str(project),
        "hook_event_name": "PreToolUse",
        "tool_name": "mcp__game_developing_agent__close_workspace",
        "tool_input": {},
    }
    if agent_id is not None:
        payload["agent_id"] = agent_id
    env = {**os.environ, "CLAUDE_PROJECT_DIR": str(project)}
    env.pop("GAME_DEVELOPING_AGENT_ALLOW_MCP_RESTART", None)
    return subprocess.run(
        ["bash", str(SESSION_HOOKS / "guard-mcp-restart.sh")],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def test_close_workspace_guard_blocks_while_a_pipeline_holds_state(
    tmp_path: Path,
) -> None:
    project, _binding_file, session_id = _bound_stop_hook_project(tmp_path)

    result = _run_close_workspace_guard(project, session_id)

    assert result.returncode == 2
    assert "do not close/restart the game_developing_agent MCP workspace mid-pipeline" in result.stderr


def test_close_workspace_guard_allows_recovery_from_a_stray_binding(
    tmp_path: Path,
) -> None:
    # A workspace bound without persisted Startup state has no pipeline to
    # strand. Blocking here strands the session instead: the MCP server leases
    # one workspace per process, so the real game directory stays unreachable
    # behind WORKSPACE_ALREADY_OPEN and only an external restart clears it.
    project, _binding_file, session_id = _bound_stop_hook_project(tmp_path)
    (project / "playground" / "hook-test" / ".playtest" / "state.json").unlink()

    result = _run_close_workspace_guard(project, session_id)

    assert result.returncode == 0
    assert result.stderr == ""


def test_close_workspace_guard_still_blocks_subagents(tmp_path: Path) -> None:
    project, _binding_file, session_id = _bound_stop_hook_project(tmp_path)
    (project / "playground" / "hook-test" / ".playtest" / "state.json").unlink()

    result = _run_close_workspace_guard(project, session_id, agent_id="explore-1")

    assert result.returncode == 2


def test_stop_hook_excludes_preflight_smoke_from_gameplay_screenshots(
    tmp_path: Path,
) -> None:
    project, _binding_file, session_id = _bound_stop_hook_project(tmp_path)
    game_dir = project / "playground" / "hook-test"
    (game_dir / ".playtest" / "state.json").write_text(
        json.dumps(
            {
                "phase": "verify",
                "currentStep": "verify_iterate_1",
                "phase_status": "in_progress",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    preflight = game_dir / ".playtest" / "preflight"
    preflight.mkdir()
    (preflight / "rmbg-smoke.png").write_bytes(b"not gameplay evidence")

    result = _run_stop_hook(project, session_id, [])

    assert result.returncode == 2
    assert "Only 0 screenshots" in result.stderr
    assert "Only 1 screenshots" not in result.stderr
    assert "run_verify_dag" in result.stderr
    assert "mcp__game_developing_agent__run_tests" not in result.stderr
    assert "mcp__game_developing_agent__write_verify_report" not in result.stderr


def test_stop_hook_seals_unresolved_exit_at_iteration_budget(
    tmp_path: Path,
) -> None:
    project, binding_file, session_id = _bound_stop_hook_project(tmp_path)
    game_dir = project / "playground" / "hook-test"
    (game_dir / ".playtest" / "state.json").write_text(
        json.dumps(
            {
                "phase": "verify",
                "currentStep": "iteration",
                "phase_status": "in_progress",
                "iteration_count": 2,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    result = _run_stop_hook(project, session_id, [])

    assert result.returncode == 0, result.stderr
    assert "exhausted its automatic iteration budget (2/2)" in result.stdout
    unresolved = json.loads(
        (game_dir / ".playtest" / "stop-hook-unresolved.json").read_text()
    )
    assert unresolved["status"] == "unresolved"
    assert unresolved["reason"] == "iteration_budget_exhausted"
    assert unresolved["iteration_count"] == unresolved["max_iterations"] == 2
    assert not Path(f"{binding_file}.block_count").exists()


def test_audit_log_rejects_iteration_after_budget_exhaustion(
    tmp_path: Path,
) -> None:
    project, _binding_file, _session_id = _bound_stop_hook_project(tmp_path)
    game_dir = project / "playground" / "hook-test"
    (game_dir / ".playtest" / "state.json").write_text(
        json.dumps({"iteration_count": 2}) + "\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            "bash",
            str(project / ".claude" / "hooks" / "audit-log.sh"),
            str(game_dir),
            "iteration_complete",
            "third cycle",
        ],
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "CLAUDE_PROJECT_DIR": str(project)},
    )

    assert result.returncode == 2
    assert "ITERATION_BUDGET_EXHAUSTED" in result.stderr
    audit_file = game_dir / ".playtest" / "audit.jsonl"
    assert not audit_file.exists() or not audit_file.read_text().strip()


@pytest.fixture
def development_stop_project(tmp_path, monkeypatch):
    from game_developing_agent_mcp.config import Config
    from game_developing_agent_mcp.server import ServerState, ToolCtx
    from game_developing_agent_mcp.tools.lifecycle import _write_pipeline_state
    from game_developing_agent_mcp.workspace import open_workspace

    project, binding_file, session_id = _bound_stop_hook_project(tmp_path)
    game = project / "playground/hook-test"
    (game / "game-spec.json").write_text(
        json.dumps({"validation_profile": "development"})
    )
    config = Config.from_env(config_path=project / "game_developing_agent.config.yaml")
    monkeypatch.setenv("GAME_DEVELOPING_AGENT_PYTHON_EXECUTABLE", sys.executable)

    def checkpoint(phase="development_verify", status="blocked", **extra):
        with_workspace = open_workspace(game, repo_root=project, mode="resume")
        try:
            return _write_pipeline_state(
                {
                    "phase": phase,
                    "status": status,
                    "genre": "custom",
                    "interaction_profile": "none",
                    "quality_profile": "minimal",
                    "level_model": "none",
                    "next_action": "Outer verify --profile development --vision",
                    "details": {"acceptance_profile": "development"},
                    **extra,
                },
                ToolCtx(
                    ServerState(
                        config=config, repo_root=project, workspace=with_workspace
                    )
                ),
            )
        finally:
            with_workspace.close()

    checkpoint()
    return project, game, binding_file, session_id, checkpoint


def development_report(game, *, passed=False):
    from game_developing_agent_mcp.tools.development_tools import (
        REQUIRED,
        development_gate,
    )

    state = json.loads((game / ".playtest/state.json").read_text())
    identity = {
        key: state[key]
        for key in (
            "pipeline_run_id",
            "build_digest",
            "quality_profile",
            "level_model",
        )
    }
    identity["verify_run_id"] = "verify-fixture"
    directory = game / ".playtest/verify"
    directory.mkdir(exist_ok=True)
    report = {
        **identity,
        "mode": "development",
        "acceptance_profile": "development",
        "checks": {name: {"status": "pass"} for name in REQUIRED},
    }
    if not passed:
        report["checks"]["visual"] = {
            "status": "not_run",
            "reason": "Outer Seed pending",
        }
    report.update(development_gate(report, identity["build_digest"]))
    (directory / "verify-report.json").write_text(json.dumps(report))
    (directory / "current-run.json").write_text(
        json.dumps(
            {
                **identity,
                "mode": "development",
                "status": "finalized",
            }
        )
    )
    return report


@pytest.mark.parametrize("passed", [True, False])
def test_stop_hook_accepts_current_development_gate_without_ship_claim(
    development_stop_project, passed
):
    project, game, binding, session, checkpoint = development_stop_project
    checkpoint(status="completed" if passed else "blocked")
    development_report(game, passed=passed)
    counter = Path(f"{binding}.block_count")
    counter.write_text("2")
    result = _run_stop_hook(project, session, [])
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["development_ready"] is passed
    assert payload["ready_to_ship"] is False
    assert payload["status"] == ("pass" if passed else "blocked")
    if not passed:
        assert (
            "--vision" in payload["next_action"]
            and "BLOCKED" in payload["systemMessage"]
        )
    assert not counter.exists()
    assert not (game / ".playtest/verify/gate-results/ready_to_ship.json").exists()


def test_stop_hook_accepts_explicit_external_development_handoff(
    development_stop_project,
):
    project, game, _, session, checkpoint = development_stop_project
    checkpoint(phase="development_pending_external", status="blocked")
    result = _run_stop_hook(project, session, [])
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["status"] == "blocked"
    assert "--vision" in json.loads(result.stdout)["next_action"]
    assert not (game / ".playtest/verify/verify-report.json").exists()


@pytest.mark.parametrize(
    "problem",
    [
        "disabled",
        "spec_profile",
        "state_profile",
        "stale_build",
        "cross_run",
        "cross_verify",
        "unfinished_run",
        "forged_ready",
        "transaction",
        "running",
    ],
)
def test_stop_hook_rejects_unproven_development_completion(
    development_stop_project, problem
):
    project, game, _, session, checkpoint = development_stop_project
    checkpoint(status="completed")
    development_report(game, passed=True)
    if problem == "disabled":
        config = project / "game_developing_agent.config.yaml"
        text = config.read_text().replace(
            "development_enabled: true", "development_enabled: false"
        )
        config.unlink()
        config.write_text(text)
    elif problem == "spec_profile":
        (game / "game-spec.json").write_text('{"validation_profile":"release"}')
    elif problem == "stale_build":
        (game / "index.html").write_text("changed")
    else:
        relative = {
            "state_profile": "state.json",
            "transaction": "resume.json",
            "running": "state.json",
            "cross_run": "verify/verify-report.json",
            "cross_verify": "verify/verify-report.json",
            "unfinished_run": "verify/current-run.json",
            "forged_ready": "verify/verify-report.json",
        }[problem]
        path = game / ".playtest" / relative
        data = json.loads(path.read_text())
        if problem == "state_profile":
            data["details"]["acceptance_profile"] = "release"
        elif problem == "transaction":
            data["state_transaction_id"] = "foreign"
        elif problem == "running":
            data["phase_status"] = "running"
        elif problem == "cross_run":
            data["pipeline_run_id"] = "foreign"
        elif problem == "cross_verify":
            data["verify_run_id"] = "foreign"
        elif problem == "unfinished_run":
            data["status"] = "active"
        else:
            data["ready_to_ship"] = True
        path.write_text(json.dumps(data))
    result = _run_stop_hook(project, session, [])
    assert result.returncode == 2
    assert "Development Stop" in result.stderr
    assert "ACTION REQUIRED" in result.stderr


def test_stop_hook_production_release_retains_original_ship_checks(
    development_stop_project,
):
    project, game, _, session, checkpoint = development_stop_project
    checkpoint(phase="release", status="completed")
    development_report(game, passed=True)
    result = _run_stop_hook(project, session, [])
    assert result.returncode == 2
    assert "No current ready_to_ship gate result" in result.stderr
    assert "index.html missing phaser@4" in result.stderr


def test_production_writer_merges_development_details_and_preserves_next_action(
    development_stop_project,
):
    _project, game, _, _, checkpoint = development_stop_project
    checkpoint(details={"user_note": "retain this"})
    checkpoint(details={"issues": ["outer vision"]})
    state = json.loads((game / ".playtest/state.json").read_text())
    resume = json.loads((game / ".playtest/resume.json").read_text())
    assert (
        state["details"]
        == resume["details"]
        == {
            "acceptance_profile": "development",
            "user_note": "retain this",
            "issues": ["outer vision"],
        }
    )
    assert state["next_action"] == resume["next_action"]
    assert state["state_transaction_id"] == resume["state_transaction_id"]


@pytest.mark.parametrize(
    "authority,relative",
    [
        ("implement-agent", "game-spec.json"),
        ("scaffold-agent", "game-spec.json"),
        ("scaffold-agent", "tsconfig.json"),
        ("scaffold-agent", "vite.config.js"),
        ("scaffold-agent", "scripts/build.mjs"),
        ("scaffold-agent", "scripts/levels/generate.mjs"),
    ],
)
def test_development_owner_can_write_required_contract_and_template_files(
    authority, relative
):
    assert BOUNDARY.write_allowed(authority, Path(relative))


@pytest.mark.parametrize(
    "authority,relative",
    [
        ("implement-agent", "GAME_DESIGN.md"),
        ("implement-agent", "assets/asset-manifest.json"),
        ("implement-agent", "vite.config.js"),
        ("implement-agent", "scripts/build.mjs"),
        ("scaffold-agent", "GAME_DESIGN.md"),
        ("scaffold-agent", "levels/stage_1.json"),
        ("assets-agent", "game-spec.json"),
        ("asset-integration-agent", "game-spec.json"),
        ("design-agent", "game-spec.json"),
        ("verify-agent", "game-spec.json"),
        ("pipeline-orchestrator", "game-spec.json"),
    ],
)
def test_development_paths_preserve_other_owner_boundaries(authority, relative):
    assert not BOUNDARY.write_allowed(authority, Path(relative))


@pytest.mark.parametrize(
    "relative",
    [
        "game-spec.json",
        "package.json",
        "package-lock.json",
        "jsconfig.json",
        "tsconfig.json",
        "vite.config.js",
        "scripts/generate-levels.mjs",
    ],
)
def test_development_contract_and_lockfile_are_guarded_build_inputs(relative, tmp_path):
    from game_developing_agent_mcp.evidence import compute_build_digest

    assert BOUNDARY.build_input_path(Path(relative))
    before = compute_build_digest(tmp_path)
    path = tmp_path / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("original")
    created = compute_build_digest(tmp_path)
    assert created != before
    path.write_text("changed")
    assert compute_build_digest(tmp_path) != created
