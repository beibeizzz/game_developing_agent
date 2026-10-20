# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
from __future__ import annotations

import asyncio
import json
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from game_developing_agent_mcp.config import Config
from game_developing_agent_mcp.local import cli, runtime
from game_developing_agent_mcp.server import ServerState, ToolCtx
from game_developing_agent_mcp.tools.development_tools import REQUIRED, development_gate
from game_developing_agent_mcp.tools.lifecycle import _write_pipeline_state
from game_developing_agent_mcp.workspace import open_workspace


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


@pytest.fixture
def accepted_project(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    (repo / "playground").mkdir(parents=True)
    (repo / "game_developing_agent.config.yaml").write_bytes(
        (Path(runtime.__file__).parents[4] / "game_developing_agent.config.yaml").read_bytes()
    )
    workspace = open_workspace("playground/recovery", repo_root=repo, mode="create")
    project = workspace.root
    write(project / "game-spec.json", {"validation_profile": "development"})
    ctx = ToolCtx(
        ServerState(config=Config.from_env(), repo_root=repo, workspace=workspace)
    )
    _write_pipeline_state(
        {
            "phase": "development_verify",
            "status": "completed",
            "genre": "custom",
            "interaction_profile": "none",
            "quality_profile": "minimal",
            "level_model": "none",
            "details": {"acceptance_profile": "development"},
            "next_action": "Development acceptance complete",
        },
        ctx,
    )
    state = json.loads((project / ".playtest/state.json").read_text())
    identity = {key: state[key] for key in ("pipeline_run_id", "build_digest")}
    identity["verify_run_id"] = "verify-current"
    report = {
        **identity,
        "mode": "development",
        "acceptance_profile": "development",
        "checks": {key: {"status": "pass"} for key in REQUIRED},
    }
    report.update(development_gate(report, identity["build_digest"]))
    write(project / ".playtest/verify/verify-report.json", report)
    write(
        project / ".playtest/verify/current-run.json",
        {**identity, "mode": "development", "status": "finalized"},
    )
    monkeypatch.setattr(cli, "REPO", repo)
    yield project, repo, report
    workspace.close()


@pytest.mark.parametrize(
    "previous_status", ["interrupted", "completed_external", "returned"]
)
def test_completed_resume_returns_current_acceptance_before_any_cloud_call(
    accepted_project, monkeypatch, previous_status
):
    project, _repo, report = accepted_project
    session = project / ".playtest/history/claude-session.json"
    write(
        session,
        {
            "session_id": "old-session",
            "request": "Original approved change",
            "status": previous_status,
        },
    )
    monkeypatch.setattr(
        runtime,
        "process_environment",
        lambda *_: pytest.fail("Completed resume must stay local"),
    )
    monkeypatch.setattr(
        runtime,
        "run_pipeline",
        lambda *_args, **_kwargs: pytest.fail("Completed resume must stay local"),
    )
    result = asyncio.run(
        cli.execute(
            SimpleNamespace(
                command="resume", project=str(project), inspect=False, vision=True
            )
        )
    )
    assert result["development_ready"] is True and result["ready_to_ship"] is False
    assert result["reused_verification"] is True
    saved = json.loads(session.read_text())
    assert saved["status"] == "completed_external"
    assert saved["request"] == "Original approved change"
    assert saved["completion_evidence"]["verify_run_id"] == report["verify_run_id"]


@pytest.mark.parametrize(
    "problem",
    [
        "stale_build",
        "cross_run",
        "incomplete_checks",
        "old_acceptance_for_new_request",
        "cross_verify",
        "unfinalized_run",
        "conflicting_optional_routing",
    ],
)
def test_recovery_completion_requires_current_gate_and_request(
    accepted_project, problem
):
    project, repo, _ = accepted_project
    session = project / ".playtest/history/claude-session.json"
    saved = {"status": "interrupted", "request": "New requested work"}
    if problem == "old_acceptance_for_new_request":
        saved["verification_before"] = "verify-current"
    write(session, saved)
    if problem == "stale_build":
        (project / "index.html").write_text("changed since verification")
    elif problem in {"cross_verify", "unfinalized_run", "conflicting_optional_routing"}:
        path = project / ".playtest/verify/current-run.json"
        run = json.loads(path.read_text())
        if problem == "cross_verify":
            run["verify_run_id"] = "different-verify"
        elif problem == "unfinalized_run":
            run["status"] = "active"
        else:
            run["quality_profile"] = "pixel_art"
        write(path, run)
    elif problem in {"cross_run", "incomplete_checks"}:
        path = project / ".playtest/verify/verify-report.json"
        report = json.loads(path.read_text())
        if problem == "cross_run":
            report["pipeline_run_id"] = "foreign"
        else:
            report["checks"]["visual"]["status"] = "not_run"
        write(path, report)
    assert runtime.complete_pipeline_recovery(project, repo) is None
    assert json.loads(session.read_text()) == saved


@pytest.fixture
def pipeline_execution(tmp_path, monkeypatch):
    project = tmp_path / "game"
    project.mkdir()
    ledger = SimpleNamespace(path=tmp_path / ".game_developing_agent/usage.json")
    tasks = []
    ledger.start = lambda task, *_args, **kwargs: tasks.append(
        {"task_id": task, **kwargs}
    )
    ledger.status = lambda: {"tasks": tasks}
    ledger.mark_unknown = lambda task: None
    ledger.mark_submitted = lambda *args: None
    ledger.note_usage = lambda *args, **kwargs: None
    ledger.finish = lambda *args, **kwargs: None
    monkeypatch.delenv("CLAUDECODE", raising=False)
    monkeypatch.setattr(runtime, "UsageLedger", lambda _: ledger)
    monkeypatch.setattr(
        runtime,
        "process_environment",
        lambda _: {
            "ARK_AGENT_PLAN_API_KEY": "fixture",
            "ANTHROPIC_MODEL": runtime.FLASH,
        },
    )
    monkeypatch.setattr(runtime, "claude_executable", lambda: "fixture-claude")
    monkeypatch.setattr(
        runtime,
        "runtime_bounds",
        lambda *_: {
            "maximum_requests": 2,
            "max_prompt_bytes": 10000,
            "max_turns": 10,
            "max_output_tokens": 1000,
        },
    )
    return project, ledger, tasks


def test_http_limit_records_reason_original_request_and_one_tracked_resume(
    pipeline_execution, monkeypatch
):
    project, _ledger, tasks = pipeline_execution
    calls = []

    def execute(project, ledger, task_id, bounds, args, env, **kwargs):
        calls.append(args)
        events = [
            {"type": "system", "subtype": "init", "session_id": "real-fixture-session"},
            {
                "type": "result",
                "is_error": True,
                "subtype": "error_during_execution",
                "session_id": "real-fixture-session",
            },
        ]
        stdout = "\n".join(json.dumps(row) for row in events)
        history = ledger.path.parent / "requests"
        (history / f"{task_id}-claude.jsonl").write_text(stdout)
        write(
            history / f"{task_id}-transport.json",
            {
                "maximum_requests": 2,
                "forwarded_requests": 2,
                "denied": ["Task HTTP request limit exhausted"],
            },
        )
        return SimpleNamespace(returncode=1, stdout=stdout)

    monkeypatch.setattr(runtime, "execute_counted", execute)
    for mode, request in [
        ("change", "Preserve this exact original request"),
        ("resume", "Continue"),
    ]:
        with pytest.raises(runtime.PipelineInterrupted) as interrupted:
            runtime.run_pipeline(project, request, mode=mode, repo=project.parent)
        assert interrupted.value.recovery["reason_code"] == "http_request_limit"
        assert "game_developing_agent resume --project" in interrupted.value.recovery["next_action"]
    saved = json.loads((project / ".playtest/history/claude-session.json").read_text())
    assert saved["request"] == "Preserve this exact original request"
    assert (
        saved["status"] == "interrupted"
        and saved["session_id"] == "real-fixture-session"
    )
    assert saved["forwarded_requests"] == saved["maximum_requests"] == 2
    assert len(calls) == len(tasks) == 2
    assert len({row["task_id"] for row in tasks}) == 2
    assert calls[1][-2:] == ["--resume", "real-fixture-session"]
    assert "Preserve this exact original request" in calls[1][2]


def test_success_preserves_original_request_for_later_external_verification(
    pipeline_execution, monkeypatch
):
    project, _, _ = pipeline_execution
    event = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "session_id": "success-session",
        "modelUsage": {runtime.FLASH: {}},
        "result": '{"status":"blocked","next_action":"verify --vision"}',
    }
    monkeypatch.setattr(
        runtime,
        "execute_counted",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0, stdout=json.dumps(event)
        ),
    )
    result = runtime.run_pipeline(
        project, "Original change", mode="change", repo=project.parent
    )
    saved = json.loads((project / ".playtest/history/claude-session.json").read_text())
    assert result["status"] == "blocked"
    assert saved["request"] == "Original change" and saved["status"] == "returned"
    assert saved["session_id"] == "success-session"


def test_timeout_partial_json_keeps_session_and_original_request(tmp_path):
    path = tmp_path / "claude-session.json"
    runtime.save_pipeline_session(
        path,
        '{"type":"system","subtype":"init","session_id":"live-session"}\n{"type":',
        "Original task",
        status="interrupted",
    )
    saved = json.loads(path.read_text())
    assert saved["session_id"] == "live-session" and saved["request"] == "Original task"


def test_resume_verify_only_uses_external_mcp_and_finalizes_recovery(
    accepted_project, monkeypatch
):
    project, _, report = accepted_project
    session = project / ".playtest/history/claude-session.json"
    write(
        session,
        {
            "status": "interrupted",
            "request": "Original",
            "verification_before": "verify-current",
        },
    )
    calls = []

    class Preview:
        url = "http://127.0.0.1:12345"

        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def serve_forever(self):
            pass

        def shutdown(self):
            pass

    @asynccontextmanager
    async def mcp(project):
        yield object()

    async def call(session, name, args):
        calls.append((name, args))
        for relative in ["verify-report.json", "current-run.json"]:
            path = project / ".playtest/verify" / relative
            value = json.loads(path.read_text())
            value["verify_run_id"] = "verify-new"
            write(path, value)
        return {**report, "verify_run_id": "verify-new"}

    monkeypatch.setattr(cli, "Preview", Preview)
    monkeypatch.setattr(cli, "mcp_session", mcp)
    monkeypatch.setattr(cli, "call", call)
    monkeypatch.setattr(
        runtime,
        "run_pipeline",
        lambda *_args, **_kwargs: pytest.fail("verify-only must use MCP directly"),
    )
    args = cli.parser().parse_args(
        ["resume", "--project", str(project), "--verify-only", "--vision"]
    )
    result = asyncio.run(cli.execute(args))
    assert result["verification"]["development_ready"] is True
    assert calls[0][0] == "verify_development" and calls[0][1]["vision"] is True
    saved = json.loads(session.read_text())
    assert saved["status"] == "completed_external"
    assert saved["completion_evidence"]["verify_run_id"] == "verify-new"




def test_execute_counted_timeout_saves_partial_session_and_finalizes_request_evidence(
    tmp_path, monkeypatch
):
    partial = (
        b'{"type":"system","subtype":"init","session_id":"timeout-session"}\n{"type":'
    )
    calls = []

    class Guard:
        def __init__(self, *args):
            self.records = []

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def environment(self, env):
            return env

        def report(self):
            return {"forwarded_requests": 0, "records": []}

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("fixture-claude", 1, output=partial)

    ledger = SimpleNamespace(
        path=tmp_path / "usage.json",
        record_requests=lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    monkeypatch.setattr(runtime, "RequestTracker", Guard)
    monkeypatch.setattr(runtime.subprocess, "run", timeout)
    with pytest.raises(subprocess.TimeoutExpired):
        runtime.execute_counted(
            tmp_path,
            ledger,
            "timeout-task",
            {"maximum_requests": 2},
            ["fixture-claude"],
            {"ANTHROPIC_MODEL": runtime.FLASH, "ARK_AGENT_PLAN_API_KEY": "fake"},
        )
    assert (tmp_path / "requests/timeout-task-claude.jsonl").read_bytes() == partial
    assert (tmp_path / "requests/timeout-task-transport.json").is_file()
    assert calls[0][0][1]["forwarded_requests"] == 0


def test_resume_before_first_checkpoint_uses_saved_original_request(
    tmp_path, monkeypatch
):
    write(
        tmp_path / ".playtest/history/claude-session.json",
        {"status": "interrupted", "request": "Approved request"},
    )
    calls = []

    def pipeline(project, request, **kwargs):
        calls.append((request, kwargs["mode"]))
        return {"status": "continued"}

    monkeypatch.setattr(runtime, "run_pipeline", pipeline)
    args = cli.parser().parse_args(["resume", "--project", str(tmp_path)])
    assert asyncio.run(cli.execute(args))["status"] == "continued"
    assert calls == [("Approved request", "resume")]
