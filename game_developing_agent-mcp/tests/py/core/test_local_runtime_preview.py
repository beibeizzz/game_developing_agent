# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
from __future__ import annotations

import base64
import io
import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from PIL import Image

from game_developing_agent_mcp.evidence import compute_build_digest
from game_developing_agent_mcp.local import runtime, vision
from game_developing_agent_mcp.local.preview import Preview, aggregate
from game_developing_agent_mcp.tools.development_tools import REQUIRED, development_gate


def test_routes_replace_inherited_aliases_and_remove_flash_force_for_vision():
    source = {
        "ARK_AGENT_PLAN_API_KEY": "test-only",
        "ANTHROPIC_API_KEY": "unrelated",
        "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1",
        "CLAUDE_CODE_RETRY_WATCHDOG": "1",
    }
    source.update({key: "old-model" for key in runtime.MODEL_VARIABLES})
    flash = runtime.process_environment(runtime.FLASH, source)
    seed = runtime.process_environment(runtime.VISION, source)
    assert all(flash[key] == runtime.FLASH for key in runtime.MODEL_VARIABLES)
    assert all(seed[key] == runtime.VISION for key in runtime.MODEL_VARIABLES)
    assert flash["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"] == "1"
    assert "CLAUDE_CODE_SUBAGENT_MODEL_FORCE" not in seed
    assert "ANTHROPIC_API_KEY" not in seed and "CLAUDE_CODE_RETRY_WATCHDOG" not in seed
    assert seed["CLAUDE_CODE_MAX_RETRIES"] == "0"
    assert seed["ANTHROPIC_BASE_URL"].endswith("/api/plan")


def test_wrong_endpoint_rejected_before_execution():
    with pytest.raises(ValueError, match="endpoint"):
        runtime.process_environment(
            runtime.FLASH,
            {
                "ARK_AGENT_PLAN_API_KEY": "test-only",
                "ARK_AGENT_PLAN_ANTHROPIC_BASE_URL": "https://example.com/api",
            },
        )


def test_cli_route_evidence_required_and_wrong_model_rejected():
    event = {
        "type": "result",
        "subtype": "success",
        "result": '{"status":"pass"}',
        "modelUsage": {runtime.VISION: {"inputTokens": 5}},
        "session_id": "fixture",
    }
    assert (
        runtime.parse_cli_result(json.dumps(event), runtime.VISION)["value"]["status"]
        == "pass"
    )
    with pytest.raises(ValueError, match="route"):
        runtime.parse_cli_result(json.dumps(event), runtime.FLASH)
    event["modelUsage"] = {}
    with pytest.raises(ValueError, match="route"):
        runtime.parse_cli_result(json.dumps(event), runtime.VISION)


def test_plan_alias_accepts_documented_backend_version_and_preserves_route():
    events = [
        {"type": "assistant", "message": {"model": "deepseek-v4-1-flash-261017"}},
        {"type": "result", "subtype": "success", "result": '{"status":"pass"}',
         "modelUsage": {runtime.FLASH: {"inputTokens": 5}}},
    ]
    parsed = runtime.parse_cli_result("\n".join(map(json.dumps, events)), runtime.FLASH)
    assert parsed["requested_model"] == runtime.FLASH
    assert "deepseek-v4-1-flash-261017" in parsed["observed_models"]
    with pytest.raises(ValueError, match="route"):
        runtime.parse_cli_result("\n".join(map(json.dumps, events)), runtime.VISION)


def test_unknown_request_bound_stops_before_subprocess(tmp_path, monkeypatch):
    monkeypatch.setenv("ARK_AGENT_PLAN_API_KEY", "test-only")
    monkeypatch.delenv("CLAUDECODE", raising=False)
    monkeypatch.setattr(runtime, "claude_executable", lambda: "fixture-claude")

    def unexpected(*args, **kwargs):
        pytest.fail("No Claude/network call may occur without verified bounds")

    monkeypatch.setattr(runtime.subprocess, "run", unexpected)
    with pytest.raises(ValueError, match="runtime_compatibility_unknown"):
        runtime.run_json_task(tmp_path, "test")


def test_turn_limit_keeps_real_session_and_request_for_resume(tmp_path):
    events = [
        {"type": "system", "subtype": "init", "session_id": "original-session"},
        {"type": "result", "session_id": "original-session", "is_error": True,
         "subtype": "error_max_turns", "terminal_reason": "max_turns"},
    ]
    path = tmp_path / "history" / "claude-session.json"
    runtime.save_pipeline_session(path, "\n".join(map(json.dumps, events)), "Lower normal speed")
    saved = json.loads(path.read_text())
    assert saved["session_id"] == "original-session"
    assert saved["status"] == "interrupted"
    assert saved["request"] == "Lower normal speed"


def test_resume_can_continue_after_design_before_game_spec_exists(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from game_developing_agent_mcp.local import cli

    path = tmp_path / ".playtest" / "resume.json"
    path.parent.mkdir()
    path.write_text('{"next_action":"Dispatch scaffold-agent"}')
    calls = []

    def pipeline(project, request, **kwargs):
        calls.append((project, kwargs["mode"]))
        return {"status": "continued"}

    monkeypatch.setattr(runtime, "run_pipeline", pipeline)
    result = asyncio.run(cli.execute(SimpleNamespace(
        command="resume", project=str(tmp_path), inspect=False, vision=False,
    )))
    assert result["status"] == "continued"
    assert calls == [(tmp_path, "resume")]


def test_vision_preserves_requested_report_and_adds_evidence(tmp_path, monkeypatch):
    image = io.BytesIO()
    Image.new("RGB", (16, 16), "blue").save(image, format="PNG")

    def task(project, prompt, **kwargs):
        assert project == tmp_path and kwargs["model"] == runtime.VISION
        assert kwargs["images"][0]["source"]["media_type"] == "image/png"
        return {
            "value": {
                "score": 8,
                "visible_findings": ["ship"],
                "issues": [],
                "evidence_refs": [{"image": 0, "object": "ship"}],
            },
            "task_id": "fixture",
        }

    monkeypatch.setattr(vision, "run_json_task", task)
    result = vision.vision_content(
        [
            {"type": "text", "text": "Return score"},
            {
                "type": "image_url",
                "image_url": {
                    "url": "data:image/png;base64,"
                    + base64.b64encode(image.getvalue()).decode()
                },
            },
        ],
        project=tmp_path,
        max_tokens=500,
        timeout=5,
    )
    report = json.loads(result["text"])
    assert report["score"] == 8 and report["input_mode"] == "images"
    assert report["model"] == runtime.VISION and report["coverage_limits"]


def test_development_gate_requires_visual_and_current_consumed_spec(tmp_path):
    path = tmp_path / "game-spec.json"
    path.write_text('{"hp":3}')
    digest = compute_build_digest(tmp_path)
    report = {
        "acceptance_profile": "development",
        "build_digest": digest,
        "checks": {name: {"status": "pass"} for name in REQUIRED},
    }
    assert development_gate(report, digest)["development_ready"]
    assert development_gate(report, digest)["ready_to_ship"] is False
    report["checks"]["visual"]["status"] = "not_run"
    assert not development_gate(report, digest)["development_ready"]
    report["checks"]["visual"]["status"] = "pass"
    path.write_text('{"hp":4}')
    assert not development_gate(report, compute_build_digest(tmp_path))[
        "development_ready"
    ]


def test_preview_records_valid_local_events_and_rejects_foreign_origin(tmp_path):
    (tmp_path / "dist").mkdir()
    spec = {
        "project_id": "fixture",
        "run_id": "run-1",
        "level_factory": {"seeds": [42]},
        "revisions": {"spec_rev": 1, "game_rev": 1, "asset_rev": 1, "level_rev": 1},
    }
    (tmp_path / "game-spec.json").write_text(json.dumps(spec))
    row = {
        "project_id": "fixture",
        "run_id": "run-1",
        "play_session_id": "session-1",
        **spec["revisions"],
        "event": "enter",
        "difficulty": "normal",
        "seed": 42,
        "elapsed_active_ms": 0,
        "elapsed_wall_ms": 0,
    }
    with Preview(tmp_path) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            req = Request(
                origin + "/__game_developing_agent/events",
                data=json.dumps(row).encode(),
                headers={"Origin": origin, "Content-Type": "application/json"},
            )
            with urlopen(req, timeout=3) as response:
                assert response.status == 204
            req.headers["Origin"] = "http://foreign.invalid"
            with pytest.raises(HTTPError) as denied:
                urlopen(req, timeout=3)
            assert denied.value.code == 403
        finally:
            server.shutdown()
            thread.join()
    summary = aggregate(tmp_path)
    assert summary["groups"][0]["sessions"] == 1
    assert "session-1" not in json.dumps(summary)
    assert aggregate(tmp_path, source="scripted_fixture")["groups"] == []
