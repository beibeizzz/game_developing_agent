# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
from __future__ import annotations

import pytest

from game_developing_agent_mcp.errors import ToolError
from game_developing_agent_mcp.local.memory import MemoryStore
from game_developing_agent_mcp.local.usage import UsageLedger

FLASH = "deepseek-v4.1-flash"
IMAGE = "doubao-seedream-5.0-pro"


def test_empty_memory_lookup_preserves_clean_create_workspace(tmp_path):
    project = tmp_path / "new-game"
    store = MemoryStore(project)
    assert store.select(scope="project", game="new-game", keywords=["dodge"]) == []
    assert not project.exists()


def test_memory_requires_activation_and_current_scope(tmp_path):
    store = MemoryStore(tmp_path)
    item = store.add("Slower waves --- improve the first encounter", scope="project", game="dodge",
                     keywords=["waves"], versions={"level": 2}, source="run-fixture", evidence_level="local_fixture")
    query = {"scope": "project", "game": "dodge", "keywords": ["waves"], "versions": {"level": 2}}
    assert store.select(**query) == []
    store.activate(item["memory_id"])
    assert store.select(**query)[0]["source"] == "run-fixture"
    assert store.select(**{**query, "game": "another"}) == []
    assert store.select(**{**query, "versions": {"level": 3}}) == []
    store.set_status(item["memory_id"], "stale", "level changed")
    with pytest.raises(ValueError, match="supplemental evidence"):
        store.activate(item["memory_id"])
    store.supplement(item["memory_id"], evidence_refs=["run-new"], evidence_level="observed", versions={"level": 3})
    store.activate(item["memory_id"])
    store.set_status(item["memory_id"], "retired", "replaced")
    final = store.list_all()[0]
    assert final["evidence_refs"] == ["run-fixture", "run-new"]
    assert final["status"] == "retired"
    assert (store.directory / (item["memory_id"] + ".md")).is_file()


def test_media_bound_project_owns_temporary_staging_and_fd_output(ledger, tmp_path, monkeypatch):
    import os
    import tempfile
    from pathlib import Path

    from game_developing_agent_mcp.local.media_usage import (
        media_context,
        media_output_scope,
        reserve_media,
    )

    project = tmp_path / "playground" / "dodge-001"
    assets = project / "assets"
    assets.mkdir(parents=True)
    monkeypatch.setenv("GAME_DEVELOPING_AGENT_LOCAL_PROJECT", str(project))
    monkeypatch.setenv("ARK_AGENT_PLAN_API_KEY", "fixture-key")
    final = assets / "ship.png"
    with tempfile.TemporaryDirectory(prefix="game_developing_agent-static-produce-") as staging:
        staged = Path(staging) / "ship.png"
        with media_output_scope(staged, final):
            owner, task_id = reserve_media(staged, IMAGE)
        assert owner.path == ledger.path
        assert not (Path(staging) / ".game_developing_agent").exists()
    with tempfile.TemporaryDirectory(prefix="game_developing_agent-static-produce-") as staging:
        staged = Path(staging) / "ship.png"
        with media_output_scope(staged, final):
            assert media_context(staged)[1] == task_id
            with pytest.raises(ToolError, match="pending task"):
                reserve_media(staged, IMAGE)
    descriptor = os.open(assets, os.O_RDONLY | os.O_DIRECTORY)
    try:
        pinned = Path(f"/proc/self/fd/{descriptor}") / "ship.png"
        assert media_context(pinned)[1] == task_id
        assert media_context(pinned)[0].path == ledger.path
    finally:
        os.close(descriptor)
    state = ledger.status()
    assert len(state["tasks"]) == 1
    assert not (project / ".game_developing_agent").exists()


def test_media_without_project_binding_retains_original_resolved_identity(ledger, tmp_path, monkeypatch):
    import hashlib

    from game_developing_agent_mcp.local.media_usage import media_context

    monkeypatch.delenv("GAME_DEVELOPING_AGENT_LOCAL_PROJECT", raising=False)
    output = tmp_path / "ship.png"
    owner, task_id = media_context(output)
    assert owner.path == ledger.path
    assert task_id == "media-" + hashlib.sha256(str(output.resolve()).encode()).hexdigest()[:24]


def test_completed_media_can_regenerate_and_resume_original_attempt(ledger, tmp_path, monkeypatch):
    import json

    from game_developing_agent_mcp.local.media_usage import (
        reserve_media,
        resume_media_context,
    )

    monkeypatch.setenv("ARK_AGENT_PLAN_API_KEY", "fixture")
    monkeypatch.delenv("GAME_DEVELOPING_AGENT_LOCAL_PROJECT", raising=False)
    model = IMAGE
    output = tmp_path / "clip.mp4"
    _, original = reserve_media(output, model)
    ledger.mark_submitted(original, "original-task")
    ledger.finish(original)
    _, second = reserve_media(output, model)
    assert second == original + "-attempt-2"
    ledger.mark_submitted(second, "second-task")
    ledger.mark_unknown(second)
    with pytest.raises(ToolError, match="pending task"):
        reserve_media(output, model)
    checkpoint = output.with_suffix(".mp4.task.json")
    checkpoint.write_text(json.dumps({"task_id": "original-task"}))
    assert reserve_media(output, model, resume=True)[1] == original
    assert resume_media_context(output, "second-task")[1] == second
    assert len(ledger.status()["tasks"]) == 2
    ledger.finish(second)
    assert reserve_media(output, model)[1] == original + "-attempt-3"


@pytest.fixture
def ledger(tmp_path):
    result = UsageLedger(tmp_path)
    result.status()
    return result
