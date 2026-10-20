# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Development acceptance reusing GAME_DEVELOPING_AGENT state, runtime identity and browser runner."""

from __future__ import annotations

import json
import subprocess
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from jsonschema import ValidationError, validate

from .. import playtest_layout as layout
from ..adapters.iterate_vlm import call_vlm_on_images
from ..adapters.script_runner import run_node_script, runner_path
from ..errors import ToolError
from ..evidence import atomic_write_json, compute_build_digest
from ..local.scaffold import materialize_dodge_template, require_empty_code_project
from ..server import ToolCtx, ToolDef
from ..verify_epoch import (
    create_runtime_token_receipt,
    normalize_epoch_url,
    runtime_cli_args,
    validate_runtime_evidence,
    verify_dag_flock,
)
from .lifecycle import _write_pipeline_state
from .verify_tools import _require_pipeline_identity

REQUIRED = ("build", "levels", "browser_gameplay", "visual")


def _scaffold_dodge(args: dict, ctx: ToolCtx) -> dict:
    if not ctx.config.verify.development_enabled:
        raise ToolError("INVALID_CONFIG", "Development scaffolding is disabled")
    game = ctx.workspace.root
    if args.get("game_dir") and Path(args["game_dir"]).resolve() != game:
        raise ToolError("INVALID_PATH", "Scaffolding must target the bound game")
    with verify_dag_flock(game):
        require_empty_code_project(game)
        state_path = game / ".playtest/state.json"
        state = (
            json.loads(state_path.read_text(encoding="utf-8"))
            if state_path.is_file()
            else {}
        )
        if state and not state.get("pipeline_run_id"):
            raise ToolError(
                "PIPELINE_IDENTITY_MISSING",
                "Initialize authoritative pipeline state before scaffolding",
            )
        if not state:
            state = _write_pipeline_state(
                {
                    "game_dir": str(game),
                    "phase": "development_scaffold",
                    "status": "running",
                    "genre": "bullet_hell",
                    "interaction_profile": "none",
                    "quality_profile": "minimal",
                    "level_model": "authored",
                    "has_levels": False,
                    "details": {"acceptance_profile": "development"},
                    "next_action": "Complete the template build, then persist the scaffold checkpoint",
                },
                ctx,
            )
        spec = materialize_dodge_template(
            game,
            run_id=state["pipeline_run_id"],
            generation_source="ark_plan_claude_template",
        )
        logs = game / ".playtest/scaffold"
        logs.mkdir(parents=True, exist_ok=True)
        for name, command in (
            ("install", ["npm", "install", "--no-audit", "--no-fund"]),
            ("build", ["npm", "run", "build"]),
        ):
            result = subprocess.run(
                command,
                cwd=game,
                capture_output=True,
                text=True,
                timeout=300,
                check=False,
            )
            log = logs / f"{name}.log"
            log.write_text(result.stdout + result.stderr, encoding="utf-8")
            if result.returncode:
                raise ToolError(
                    "SCAFFOLD_BUILD_FAILED",
                    f"Template {name} failed; inspect {log.relative_to(game)}",
                )
            if name == "install":
                spec["engine_version"] = json.loads(
                    (game / "node_modules/phaser/package.json").read_text(
                        encoding="utf-8"
                    )
                )["version"]
                atomic_write_json(game / "game-spec.json", spec)
        return {
            "status": "scaffolded",
            "game_dir": str(game),
            "project_id": game.name,
            "pipeline_run_id": state["pipeline_run_id"],
            "generation_source": spec["generation_source"],
            "build": "pass",
            "spec_path": str(game / "game-spec.json"),
            "level_files": [
                str(path) for path in sorted((game / "levels").glob("stage_*.json"))
            ],
            "manifest_path": str(game / "assets/asset-manifest.json"),
            "next_action": "Persist the scaffold checkpoint through write_pipeline_state; route assets and independent development verification",
        }


def development_gate(report: dict, digest: str) -> dict:
    issues = []
    if report.get("acceptance_profile") != "development":
        issues.append("Report requires development profile")
    if report.get("build_digest") != digest:
        issues.append("Evidence is stale for current game inputs")
    for name in REQUIRED:
        if report.get("checks", {}).get(name, {}).get("status") != "pass":
            issues.append(f"{name} has no current pass evidence")
    return {
        "status": "blocked" if issues else "pass",
        "development_ready": not issues,
        "ready_to_ship": False,
        "issues": issues,
    }


def _verify(args: dict, ctx: ToolCtx) -> dict:
    if not ctx.config.verify.development_enabled:
        raise ToolError("INVALID_CONFIG", "Development verification is disabled")
    game = ctx.workspace.root
    if args.get("game_dir") and Path(args["game_dir"]).resolve() != game:
        raise ToolError("INVALID_PATH", "Verification must target the bound game")
    with verify_dag_flock(game):
        return _verify_locked(args, ctx, game)


def _verify_locked(args: dict, ctx: ToolCtx, game: Path) -> dict:
    checks = {name: {"status": "not_run"} for name in REQUIRED}
    output = game / ".playtest" / "verify"
    output.mkdir(parents=True, exist_ok=True)
    build = subprocess.run(
        ["npm", "run", "build"],
        cwd=game,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    (output / "development-build.log").write_text(
        build.stdout + build.stderr, encoding="utf-8"
    )
    checks["build"] = {
        "status": "pass" if build.returncode == 0 else "fail",
        "evidence": "development-build.log",
    }
    _write_pipeline_state(
        {
            "game_dir": str(game),
            "phase": "development_verify",
            "status": "running",
            "next_action": "Complete development checks",
        },
        ctx,
    )
    identity = _require_pipeline_identity(game, ctx)
    identity["verify_run_id"] = "verify-" + uuid.uuid4().hex
    spec = json.loads((game / "game-spec.json").read_text())
    now = datetime.now(UTC).isoformat()
    url = normalize_epoch_url(args["url"])
    receipt, path, receipt_sha = create_runtime_token_receipt(
        game, identity=identity, url=url, generated_at=now
    )
    run = {
        **identity,
        "schema_version": 2,
        "mode": "development",
        "url": url,
        "status": "active",
        "started_at": now,
        "started_at_ns": time.time_ns(),
        "runtime_token_receipt": str(path.relative_to(game)),
        "runtime_token_url": receipt["runtime_token_url"],
        "runtime_token_sha256": receipt["runtime_token_sha256"],
        "runtime_receipt_sha256": receipt_sha,
    }
    atomic_write_json(game / ".playtest" / layout.VERIFY_RUN, run)
    report = {
        **identity,
        "schema_version": 1,
        "acceptance_profile": "development",
        "mode": "development",
        "generated_at": now,
        "revisions": spec["revisions"],
        "checks": checks,
        "evidence_source": "scripted_fixture",
        "waivers": [
            {
                "check": "full_video_review",
                "status": "waived",
                "reason": "Design v1.1 development profile; sampled frames do not certify continuous video.",
            }
        ],
    }
    try:
        schema = json.loads(
            (
                ctx.repo_root
                / ".claude/skills/game-pipeline/references/level-design/level_schema.json"
            ).read_text()
        )
        for level in (game / "levels").glob("stage_*.json"):
            validate(json.loads(level.read_text()), schema)
        levels = subprocess.run(
            ["npm", "run", "test:levels"],
            cwd=game,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        (output / "development-levels.log").write_text(levels.stdout + levels.stderr)
        checks["levels"] = {
            "status": "pass" if levels.returncode == 0 else "fail",
            "evidence": "development-levels.log",
            "scope": "nine seeded plans, schema, regeneration, active count and local geometry",
        }
        if build.returncode == 0:
            shots = game / ".playtest" / layout.TEST_SCREENSHOTS_DIR
            shots.mkdir(parents=True, exist_ok=True)
            result = run_node_script(
                runner_path("verify", "test-runner.mjs"),
                [
                    "--url",
                    url,
                    "--tests",
                    str(game / ".playtest" / "tests"),
                    "--screenshots",
                    str(shots),
                    "--screenshot-each",
                    "--json",
                    "--timeout",
                    "15000",
                    *runtime_cli_args(game, run),
                ],
                cwd=game,
                timeout=120,
            )
            (output / "development-browser.log").write_text(result["stderr"])
            browser = json.loads(result["stdout"])
            validate_runtime_evidence(browser.get("runtime_identity"), run)
            atomic_write_json(game / ".playtest" / layout.TEST_RESULTS, browser)
            summary = browser.get("summary", {})
            passed = (
                result["returncode"] == 0
                and summary.get("total", 0) > 0
                and summary.get("fail", 1) == 0
                and summary.get("skip", 0) == 0
            )
            checks["browser_gameplay"] = {
                "status": "pass" if passed else "fail",
                "evidence": layout.TEST_RESULTS,
                "summary": summary,
                "scope": "real keyboard input; obstacle spawn; fixture collision/invulnerability; pause; win/loss/restart; telemetry",
            }
            if args.get("vision"):
                images = [
                    shots / name for name in ["playing.png", "loss.png", "win.png"]
                ]
                if not all(image.is_file() for image in images):
                    raise ValueError("Game-only screenshot group missing")
                raw = call_vlm_on_images(
                    config=ctx.config,
                    image_paths=images,
                    max_tokens=1600,
                    prompt="检查三张陨石躲避截图，依次为游戏中、失败、胜利：飞船与障碍可辨识，生命/计时及结束信息可读，主体在画布内。返回 JSON，status=pass/fail，visible_findings、issues、evidence_refs 为数组，定位截图编号、对象和坐标。",
                )
                vision = json.loads(raw)
                if vision.get("status") not in {"pass", "fail"}:
                    raise ValueError("Visual task did not provide a verdict")
                atomic_write_json(output / "development-vision.json", vision)
                checks["visual"] = {
                    "status": vision["status"],
                    "evidence": "development-vision.json",
                    "model": ctx.config.doubao.model,
                }
            else:
                checks["visual"] = {
                    "status": "not_run",
                    "reason": "Invoke verify --vision after verified account quota and runtime bounds are available",
                }
    except (
        TypeError,
        ValueError,
        OSError,
        subprocess.SubprocessError,
        ToolError,
        ValidationError,
    ) as exc:
        report["error"] = str(exc)
        unfinished = next(
            (name for name in REQUIRED if checks[name]["status"] == "not_run"), None
        )
        if unfinished:
            checks[unfinished] = {"status": "blocked", "reason": str(exc)}
    finally:
        report.update(
            development_gate(
                report, compute_build_digest(game, ctx.repo_root / "game_developing_agent.config.yaml")
            )
        )
        atomic_write_json(output / "verify-report.json", report)
        run.update(status="finalized", finalized_at=datetime.now(UTC).isoformat())
        atomic_write_json(game / ".playtest" / layout.VERIFY_RUN, run)
        _write_pipeline_state(
            {
                "game_dir": str(game),
                "phase": "development_verify",
                "status": "completed" if report["development_ready"] else "blocked",
                "next_action": "Development acceptance complete"
                if report["development_ready"]
                else "verify --profile development --vision",
                "details": {
                    "acceptance_profile": "development",
                    "report": str(output / "verify-report.json"),
                    "issues": report["issues"],
                },
            },
            ctx,
        )
    return report


TOOLS = [
    ToolDef(
        name="scaffold_dodge_project",
        description="Scaffold the reusable development dodge template into an empty bound code project, preserving authored GAME_DESIGN.md and PROMPT.md. Installs dependencies and builds locally; returns no verification verdict or paid media.",
        input_schema={
            "type": "object",
            "properties": {
                "game_dir": {"type": "string"},
                "profile": {"type": "string", "enum": ["development"]},
            },
            "required": ["profile"],
            "additionalProperties": False,
        },
        handler=_scaffold_dodge,
        requires_workspace=True,
    ),
    ToolDef(
        name="verify_development",
        description="Build and verify a local dodge game under the development profile using canonical GAME_DEVELOPING_AGENT identity and browser evidence. Required vision remains not_run unless explicitly requested; returns development_ready separately from ready_to_ship.",
        input_schema={
            "type": "object",
            "properties": {
                "game_dir": {"type": "string"},
                "url": {"type": "string"},
                "profile": {"type": "string", "enum": ["development"]},
                "vision": {"type": "boolean"},
            },
            "required": ["url", "profile"],
            "additionalProperties": False,
        },
        handler=_verify,
        requires_workspace=True,
    ),
]
