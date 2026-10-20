# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from game_developing_agent_mcp.config import Config
from game_developing_agent_mcp.errors import ToolError
from game_developing_agent_mcp.server import ServerState, ToolCtx
from game_developing_agent_mcp.tools import development_tools
from game_developing_agent_mcp.tools.lifecycle import _write_pipeline_state
from game_developing_agent_mcp.workspace import open_workspace


@pytest.fixture
def scaffold_context(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    (repo / "playground").mkdir(parents=True)
    workspace = open_workspace(
        "playground/cloud-created", repo_root=repo, mode="create"
    )
    ctx = ToolCtx(
        ServerState(config=Config.from_env(), repo_root=repo, workspace=workspace)
    )
    commands = []

    def npm_fixture(command, *, cwd, **kwargs):
        commands.append(command)
        if command[1] == "install":
            path = cwd / "node_modules/phaser/package.json"
            path.parent.mkdir(parents=True)
            path.write_text('{"version":"4.2.1"}')
        else:
            assert command == ["npm", "run", "build"]
            spec = json.loads((cwd / "game-spec.json").read_text())
            assert spec["engine_version"] == "4.2.1"
            assert (cwd / "src/waves.ts").is_file()
            assert (cwd / ".playtest/tests/001-core.mjs").is_file()
            (cwd / "levels").mkdir()
            for number in range(1, 10):
                (cwd / "levels" / f"stage_{number}.json").write_text("{}")
            (cwd / "dist").mkdir()
            (cwd / "dist/index.html").write_text("fixture build")
        return SimpleNamespace(returncode=0, stdout="fixture npm success", stderr="")

    monkeypatch.setattr(development_tools.subprocess, "run", npm_fixture)
    try:
        yield ctx, commands
    finally:
        workspace.close()


def test_scaffold_mcp_creates_template_with_actual_identity_and_preserves_design(
    scaffold_context,
):
    ctx, commands = scaffold_context
    game = ctx.workspace.root
    (game / "GAME_DESIGN.md").write_text("Design owner's approved dodge design.")
    (game / "PROMPT.md").write_text("User's original prompt.")
    tool = next(
        tool
        for tool in development_tools.TOOLS
        if tool.name == "scaffold_dodge_project"
    )
    assert tool.requires_workspace
    result = tool.handler({"game_dir": str(game), "profile": "development"}, ctx)
    spec = json.loads((game / "game-spec.json").read_text())
    state = json.loads((game / ".playtest/state.json").read_text())
    assert result["status"] == "scaffolded" and result["build"] == "pass"
    assert spec["project_id"] == game.name
    assert spec["run_id"] == state["pipeline_run_id"] == result["pipeline_run_id"]
    assert spec["generation_source"] == "ark_plan_claude_template"
    assert spec["validation_profile"] == "development"
    assert len(result["level_files"]) == 9
    assert (
        game / "GAME_DESIGN.md"
    ).read_text() == "Design owner's approved dodge design."
    assert (game / "PROMPT.md").read_text() == "User's original prompt."
    manifest = json.loads((game / "assets/asset-manifest.json").read_text())
    assert manifest["assets"] == [] and manifest["fileAssetsRequired"] is False
    assert commands == [
        ["npm", "install", "--no-audit", "--no-fund"],
        ["npm", "run", "build"],
    ]
    assert not (game / ".playtest/verify/verify-report.json").exists()
    assert "development_ready" not in result and "ready_to_ship" not in result


def test_scaffold_preserves_existing_pipeline_run(scaffold_context):
    ctx, _ = scaffold_context
    state = _write_pipeline_state(
        {
            "phase": "design",
            "status": "completed",
            "genre": "bullet_hell",
            "interaction_profile": "none",
            "quality_profile": "minimal",
            "level_model": "authored",
            "has_levels": False,
            "details": {"acceptance_profile": "development"},
        },
        ctx,
    )
    result = development_tools._scaffold_dodge({"profile": "development"}, ctx)
    assert result["pipeline_run_id"] == state["pipeline_run_id"]


@pytest.mark.parametrize(
    "target",
    [
        "src/scene.js",
        "src/user-custom.js",
        "game-spec.json",
        "assets/asset-manifest.json",
        ".playtest/tests/001-core.mjs",
        "vite.config.js",
        "levels/stage_1.json",
    ],
)
def test_scaffold_rejects_existing_targets_before_any_install_or_copy(
    scaffold_context, target
):
    ctx, commands = scaffold_context
    game = ctx.workspace.root
    path = game / target
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("user-owned")
    with pytest.raises(ToolError, match="empty code targets"):
        development_tools._scaffold_dodge({"profile": "development"}, ctx)
    assert path.read_text() == "user-owned"
    assert commands == []
    assert not (game / "package.json").exists()
    assert not (game / ".playtest/state.json").exists()


def test_scaffold_honors_disabled_profile_and_bound_workspace(
    scaffold_context, tmp_path
):
    ctx, commands = scaffold_context
    with pytest.raises(ToolError, match="bound game"):
        development_tools._scaffold_dodge(
            {"profile": "development", "game_dir": str(tmp_path)}, ctx
        )
    ctx.state.config = replace(
        ctx.config, verify=replace(ctx.config.verify, development_enabled=False)
    )
    with pytest.raises(ToolError, match="disabled"):
        development_tools._scaffold_dodge({"profile": "development"}, ctx)
    assert commands == []
