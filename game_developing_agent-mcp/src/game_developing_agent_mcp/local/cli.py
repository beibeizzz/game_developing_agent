# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Local GAME_DEVELOPING_AGENT entry point. Pipeline state and verification stay behind MCP."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
import zipfile
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from ..config import Config, load_dotenv
from ..errors import ToolError
from .memory import MemoryStore
from .preview import Preview, aggregate
from .runtime import (
    FLASH,
    MODEL_VARIABLES,
    VISION,
    claude_executable,
    complete_pipeline_recovery,
    process_environment,
    run_json_task,
    runtime_bounds,
)
from .usage import UsageLedger

REPO = Path(
    os.environ.get("GAME_DEVELOPING_AGENT_REPO_ROOT") or Path(__file__).resolve().parents[4]
).resolve()
TEMPLATE = Path(__file__).parent / "templates" / "dodge"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def review_inputs(project: Path, summary: dict, source: str) -> dict:
    """Bind review hypotheses to current behavior and versioned observations."""
    events = Counter()
    outcomes = Counter()
    fields = set()
    refs = []
    for path in sorted((project / ".playtest/telemetry").glob("*/*.jsonl")):
        selected = False
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("evidence_source") != source:
                continue
            selected = True
            events[row["event"]] += 1
            fields.update(row)
            if row["event"] == "end":
                outcomes[row.get("outcome", "unknown")] += 1
        if selected:
            refs.append(str(path.relative_to(project)))
    behavior = {}
    for relative in ("src/scene.js", "src/telemetry.js", "index.html"):
        path = project / relative
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            behavior[relative] = {"text": text[:20000], "truncated": len(text) > 20000}
    return {
        "current_game_spec": read_json(project / "game-spec.json"),
        "aggregate": summary,
        "telemetry": {
            "evidence_source": source,
            "observed_fields": sorted(fields),
            "event_counts": dict(events),
            "end_outcome_counts": dict(outcomes),
            "evidence_refs": refs,
        },
        "existing_behavior_sources": behavior,
    }


def npm(project: Path, *args: str) -> None:
    subprocess.run(["npm", *args], cwd=project, check=True)


@asynccontextmanager
async def mcp_session(project: Path, *, create: bool = False):
    env = dict(os.environ)
    env["GAME_DEVELOPING_AGENT_PYTHON_EXECUTABLE"] = sys.executable
    env["GAME_DEVELOPING_AGENT_LOCAL_PROJECT"] = str(project)
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "game_developing_agent_mcp.cli", "--repo-root", str(REPO)],
        cwd=str(REPO),
        env=env,
    )
    async with (
        stdio_client(params) as (reader, writer),
        ClientSession(reader, writer) as session,
    ):
        await session.initialize()
        await call(
            session,
            "init_workspace",
            {"path": str(project), "mode": "create" if create else "resume"},
        )
        yield session


async def call(session: ClientSession, name: str, args: dict):
    result = await session.call_tool(name, args)
    payload = json.loads(
        next(item.text for item in result.content if item.type == "text")
    )
    if result.isError:
        raise ValueError(f"{name}: {payload.get('error', payload)}")
    return payload


async def checkpoint(session, project: Path, phase: str, next_action: str):
    return await call(
        session,
        "write_pipeline_state",
        {
            "game_dir": str(project),
            "phase": phase,
            "status": "completed",
            "next_action": next_action,
            "genre": "bullet_hell",
            "interaction_profile": "none",
            "quality_profile": "minimal",
            "level_model": "authored",
            "has_levels": True,
            "level_files": [
                str(p)
                for p in sorted(
                    (project / "levels").glob("stage_*.json"),
                    key=lambda p: int(p.stem.split("_")[1]),
                )
            ],
            "details": {
                "revisions": read_json(project / "game-spec.json")["revisions"],
                "acceptance_profile": "development",
            },
        },
    )


def package(project: Path) -> dict:
    destination = project / "delivery"
    destination.mkdir(exist_ok=True)
    readme = "Run with: python -m http.server 8080 --bind 127.0.0.1\nOpen http://localhost:8080\nWASD/arrows move; Enter starts; P pauses; R restarts.\n"
    (project / "dist" / "START.txt").write_text(readme)
    for name, base, excluded in [
        ("game-build.zip", project / "dist", set()),
        (
            "game-source.zip",
            project,
            {
                "node_modules",
                "dist",
                "delivery",
                ".git",
                ".env",
                ".game_developing_agent",
                ".playtest",
                "__pycache__",
                "thruster-matted",
            },
        ),
    ]:
        with zipfile.ZipFile(destination / name, "w", zipfile.ZIP_DEFLATED) as archive:
            for folder, dirs, files in os.walk(base):
                dirs[:] = [entry for entry in dirs if entry not in excluded]
                for filename in files:
                    if (
                        filename in excluded
                        or filename.startswith(".env")
                        or filename.endswith(".task.json")
                        or filename
                        in {"media-generation-report.json", "mcp-media-schemas.json"}
                    ):
                        continue
                    path = Path(folder) / filename
                    if not path.is_symlink():
                        archive.write(path, path.relative_to(base))
            if name == "game-source.zip":
                for path in (project / ".playtest" / "tests").glob("*.mjs"):
                    if path.is_file() and not path.is_symlink():
                        archive.write(path, path.relative_to(project))
    return {
        "source": str(project),
        "build": str(project / "dist"),
        "archives": str(destination),
    }


def fixture_create(project: Path, request: str):
    """Materialize the declared example for local development without a cloud claim."""
    from .scaffold import materialize_dodge_template

    spec = materialize_dodge_template(
        project,
        run_id="local-" + uuid.uuid4().hex[:12],
        generation_source="local_fixture",
    )
    (project / "PROMPT.md").write_text(request + "\n", encoding="utf-8")
    (project / "GAME_DESIGN.md").write_text(
        "# 陨石躲避\n\nquality_profile: minimal\nlevel_model: authored\ngenre: bullet_hell\nphysics: none\n\n"
        "800×600；60 秒主动游戏时间；3 HP；WASD/方向键；800ms 无敌；P 暂停；R 重开。\n"
        "三难度和 seed 17、42、2026 可任意选择。关卡由 src/waves.ts 导出到 levels/stage_N.json。\n"
        "关卡字段 content.kind=dodge_waves_v1，由 MeteorScene 消费 content.data.spawns。\n"
        "本地 fixture 使用声明的程序飞船、陨石和星空；引擎程序火焰为动画。云素材验收单列。\n"
        "界面：左上生命、右上倒计时、中间结束/暂停面板。\n",
        encoding="utf-8",
    )
    npm(project, "install", "--no-audit", "--no-fund")
    spec["engine_version"] = read_json(
        project / "node_modules" / "phaser" / "package.json"
    )["version"]
    spec["level_factory"]["rngVersion"] = "mulberry32-v1"
    spec.pop("spec_rev", None)
    write_json(project / "game-spec.json", spec)
    npm(project, "run", "build")


def fixture_change(project: Path, request: str):
    if not (
        "普通" in request
        and "速度" in request
        and ("降低" in request or "减少" in request)
    ):
        raise ValueError(
            "Local fixture supports only the documented normal-speed reduction example; use cloud change for other requests"
        )
    spec = read_json(project / "game-spec.json")
    spec["level_factory"]["difficulty_params"]["normal"]["speed_px_s_range"] = [
        150,
        200,
    ]
    if "生命" in request:
        spec.setdefault("ui", {})["hp_font_size"] = 28
    for key in ["spec_rev", "game_rev", "level_rev"]:
        spec["revisions"][key] += 1
    write_json(project / "game-spec.json", spec)
    with (project / "GAME_DESIGN.md").open("a", encoding="utf-8") as out:
        out.write("\n局部修改：普通速度150–200px/s，生命字号28px。\n")
    write_json(
        project / ".playtest" / "history" / "local-change.json",
        {"source": "local_fixture", "request": request, "revisions": spec["revisions"]},
    )
    npm(project, "run", "build")


def doctor(project: Path) -> dict:
    routes = {}
    for kind, model in [("agent", FLASH), ("vision", VISION)]:
        try:
            env = process_environment(model)
            routes[kind] = {name: env[name] for name in MODEL_VARIABLES}
        except ValueError as exc:
            routes[kind] = {"blocked": str(exc)}
    compatibility = {}
    for profile in ["pipeline", "review", "vision"]:
        try:
            compatibility[profile] = {
                "status": "pass",
                "limits": runtime_bounds(project, claude_executable(), profile),
            }
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            compatibility[profile] = {"status": "blocked", "reason": str(exc)}
    return {
        "project": str(project),
        "repo": str(REPO),
        "python": sys.version.split()[0],
        "tools": {
            name: shutil.which(name)
            for name in ["node", "npm", "claude", "ffmpeg", "ffprobe"]
        },
        "credentials": {
            "ARK_AGENT_PLAN_API_KEY": bool(os.environ.get("ARK_AGENT_PLAN_API_KEY"))
        },
        "routes": routes,
        "runtime_compatibility": compatibility,
        "usage": UsageLedger(project).status(),
    }


async def execute(args):
    project = Path(args.project).expanduser()
    if not project.is_absolute():
        raise ValueError("--project must be an absolute path")
    project = project.resolve()
    if args.command == "doctor":
        return doctor(project)
    if args.command == "usage":
        return UsageLedger(project).status()
    if args.command == "memory":
        store = MemoryStore(project)
        if args.action == "list":
            return store.list_all()
        return (
            store.activate(args.memory_id)
            if args.action == "activate"
            else store.set_status(args.memory_id, "retired")
        )
    if args.command == "create":
        request = (
            Path(args.request_file).read_text(encoding="utf-8")
            if args.request_file
            else args.request
        )
        if not args.local_fixture:
            from .runtime import run_pipeline

            return run_pipeline(project, request, mode="create", repo=REPO)
        async with mcp_session(project, create=True) as session:
            fixture_create(project, request)
            state = await checkpoint(
                session, project, "local_scaffold", "verify --profile development"
            )
            spec = read_json(project / "game-spec.json")
            spec["run_id"] = state.get("pipeline_run_id", spec["run_id"])
            write_json(project / "game-spec.json", spec)
            npm(project, "run", "build")
            await checkpoint(
                session, project, "local_scaffold", "verify --profile development"
            )
        return {"source": "local_fixture", **package(project)}
    if not (project / "game-spec.json").is_file() and args.command != "resume":
        raise ValueError(
            "Project has no game-spec.json; create or bind an existing dodge project first"
        )
    if args.command == "preview":
        with Preview(project, args.port) as server:
            print(json.dumps({"url": server.url, "source": "human"}), flush=True)
            server.serve_forever()
    elif args.command == "status":
        return {
            "state": read_json(project / ".playtest" / "state.json"),
            "usage": UsageLedger(project).status(),
        }
    elif args.command == "build":
        npm(project, "run", "build")
        async with mcp_session(project) as session:
            await checkpoint(session, project, "build", "verify --profile development")
        return package(project)
    elif args.command == "levels":
        selection = []
        if args.difficulty:
            selection += ["--difficulty", args.difficulty]
        if args.seed is not None:
            selection += ["--seed", str(args.seed)]
        npm(project, "run", "levels", "--", *selection)
        return {"levels": [str(p) for p in (project / "levels").glob("*.json")]}
    elif args.command == "change":
        request = (
            Path(args.request_file).read_text(encoding="utf-8")
            if args.request_file
            else args.request
        )
        if not args.local_fixture:
            from .runtime import run_pipeline

            return run_pipeline(project, request, mode="change", repo=REPO)
        fixture_change(project, request)
        async with mcp_session(project) as session:
            await checkpoint(
                session, project, "local_change", "verify --profile development"
            )
        return {"source": "local_fixture", **package(project)}
    elif args.command == "resume":
        resume_path = project / ".playtest/resume.json"
        recovery_path = project / ".playtest/history/claude-session.json"
        resume = read_json(resume_path) if resume_path.is_file() else {}
        recovery = read_json(recovery_path) if recovery_path.is_file() else {}
        if not resume and not recovery:
            raise ValueError("No saved pipeline checkpoint or request to resume")
        if not args.inspect:
            completed = complete_pipeline_recovery(project, REPO)
            if completed is not None:
                return completed
            if getattr(args, "verify_only", False):
                args.command = "verify"
                return {"verification": await execute(args)}
        tasks = []
        for path in project.rglob("*.task.json"):
            if "node_modules" not in path.parts:
                tasks.append({"path": str(path), "task": read_json(path)})
        if args.inspect:
            return {"resume": resume, "recovery": recovery, "external_tasks": tasks}
        from .media_resume import resume_video_task

        recovered = [
            resume_video_task(Config.from_env(), task["path"]) for task in tasks
        ]
        recovered = [
            {key: value for key, value in result.items() if key != "video_url"}
            for result in recovered
        ]
        if str(resume.get("next_action", "")).startswith("verify") or (
            resume.get("phase") == "development_pending_external"
        ):
            args.command = "verify"
            args.vision = args.vision or "--vision" in resume.get("next_action", "")
            return {"resumed_media": recovered, "verification": await execute(args)}
        from .runtime import run_pipeline

        return run_pipeline(
            project,
            recovery.get("request")
            or "Resume the authoritative .playtest/resume.json next_action; query saved task IDs before generation.",
            mode="resume",
            repo=REPO,
        )
    elif args.command == "verify":
        with Preview(project, source="scripted_fixture") as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                async with mcp_session(project) as session:
                    result = await call(
                        session,
                        "verify_development",
                        {
                            "game_dir": str(project),
                            "url": server.url,
                            "profile": "development",
                            "vision": args.vision,
                        },
                    )
            finally:
                server.shutdown()
                thread.join()
        if result.get("development_ready") is True:
            complete_pipeline_recovery(project, REPO)
        return result
    elif args.command == "review":
        summary = aggregate(project, source=args.source)
        if not summary["groups"]:
            raise ValueError("No gameplay events for requested evidence source")
        path = project / ".playtest" / "reviews" / "aggregate.json"
        write_json(path, summary)
        inputs = review_inputs(project, summary, args.source)
        inputs_path = project / ".playtest/reviews/review-inputs.json"
        write_json(inputs_path, inputs)
        result = run_json_task(
            project,
            "请用中文根据当前 game-spec、现有行为源码和分版本遥测提出一项待执行游戏迭代。"
            "先核对已有 end 事件及 outcome=quit/restart/win/loss；对已有功能仅提出有证据的明确差异。"
            "区分事实与假设；旧版本试玩仅支持对应版本结论，样本不足时写明证据边界。"
            "返回JSON：summary, facts（每项含claim和evidence_refs）, hypotheses, changes, "
            "expected_effect（observation_window与falsification）, acceptance。"
            + json.dumps(inputs, ensure_ascii=False),
        )
        spec = inputs["current_game_spec"]
        proposal = {
            **result["value"],
            "proposal_id": "proposal-" + uuid.uuid4().hex[:10],
            "project_id": spec["project_id"],
            "base_revisions": spec["revisions"],
            "evidence_refs": [
                str(path.relative_to(project)),
                str(inputs_path.relative_to(project)),
            ],
            "memory_refs": [],
            "status": "pending",
            "generation_source": "ark_plan_claude",
            "runtime_task_id": result["task_id"],
        }
        proposal_path = (
            project / ".playtest" / "proposals" / f"{proposal['proposal_id']}.json"
        )
        write_json(
            proposal_path,
            proposal,
        )
        memory = MemoryStore(project).add(
            str(proposal["summary"]),
            scope="project",
            game=spec["project_id"],
            keywords=["dodge"],
            versions=spec["revisions"],
            source=str(proposal_path.relative_to(project)),
            evidence_level=args.source,
            evidence_refs=[
                str(proposal_path.relative_to(project)),
                *proposal["evidence_refs"],
            ],
            applicability="待执行迭代假设；依据 proposal 中的事实、版本范围与证伪条件审查后显式激活。",
        )
        proposal["memory_refs"] = [f".game_developing_agent/memory/{memory['memory_id']}.md"]
        write_json(proposal_path, proposal)
        return proposal
    elif args.command == "apply-proposal":
        if (
            not args.proposal_id.startswith("proposal-")
            or not args.proposal_id[9:].isalnum()
        ):
            raise ValueError("Invalid proposal ID")
        proposal = read_json(
            project / ".playtest" / "proposals" / f"{args.proposal_id}.json"
        )
        if (
            proposal["base_revisions"]
            != read_json(project / "game-spec.json")["revisions"]
        ):
            raise ValueError("Stale proposal; review current version first")
        from .runtime import run_pipeline

        return run_pipeline(
            project,
            json.dumps(proposal["changes"], ensure_ascii=False),
            mode="change",
            repo=REPO,
        )


def parser():
    p = argparse.ArgumentParser(prog="game_developing_agent")
    subs = p.add_subparsers(dest="command", required=True)
    for command in [
        "doctor",
        "create",
        "change",
        "preview",
        "build",
        "verify",
        "review",
        "apply-proposal",
        "status",
        "resume",
        "levels",
        "memory",
        "usage",
    ]:
        sub = subs.add_parser(command)
        sub.add_argument("--project", required=True)
        if command in {"create", "change"}:
            group = sub.add_mutually_exclusive_group(required=True)
            group.add_argument("request", nargs="?")
            group.add_argument("--request-file")
            sub.add_argument("--local-fixture", action="store_true")
        if command == "preview":
            sub.add_argument("--port", type=int, default=8080)
        if command == "resume":
            sub.add_argument("--inspect", action="store_true")
            sub.add_argument("--vision", action="store_true")
            sub.add_argument(
                "--verify-only",
                action="store_true",
                help="Run external development verification instead of continuing the saved pipeline action",
            )
        if command == "verify":
            sub.add_argument(
                "--profile", choices=["development"], default="development"
            )
            sub.add_argument("--vision", action="store_true")
        if command == "review":
            sub.add_argument(
                "--source", choices=["human", "scripted_fixture"], default="human"
            )
        if command == "apply-proposal":
            sub.add_argument("proposal_id")
        if command == "levels":
            sub.add_argument("action", choices=["generate"])
            sub.add_argument("--difficulty", choices=["easy", "normal", "hard"])
            sub.add_argument("--seed", type=int)
        if command == "memory":
            sub.add_argument("action", choices=["list", "activate", "retire"])
            sub.add_argument("memory_id", nargs="?")
    return p


def main(argv=None):
    load_dotenv([REPO / ".env"])
    try:
        result = asyncio.run(execute(parser().parse_args(argv)))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        outcome = result.get("verification", result) if isinstance(result, dict) else {}
        return 1 if outcome.get("status") in {"blocked", "fail"} else 0
    except (
        TypeError,
        ValueError,
        OSError,
        subprocess.SubprocessError,
        ToolError,
        ExceptionGroup,
    ) as exc:
        while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
            exc = exc.exceptions[0]
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "reason": str(exc),
                    **getattr(exc, "recovery", {}),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
