# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Project-scoped Claude Code routing for Ark Agent Plan."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..evidence import atomic_write_json
from .memory import MemoryStore
from .request_tracker import TRANSPORT_VERSION, RequestTracker
from .usage import UsageLedger

PLAN_ANTHROPIC = "https://ark.cn-beijing.volces.com/api/plan"
FLASH = "deepseek-v4.1-flash"
VISION = "doubao-seed-2.1-pro"
RESPONSE_MODELS = {
    FLASH: {FLASH, "deepseek-v4-1-flash-261017", "deepseek-v4-1-flash-260910"},
    VISION: {VISION, "doubao-seed-2-1-pro-260915"},
}
MODEL_VARIABLES = (
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
)


@contextmanager
def runtime_slot(project: Path):
    """Serialize outer tasks; pipeline policy permits one joined child at a time."""
    import fcntl

    path = UsageLedger(project).path.parent / "runtime.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError(
                "Another GAME_DEVELOPING_AGENT text/pipeline task is active; resume after it finishes"
            ) from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def runtime_bounds(project: Path, executable: str, profile: str) -> dict:
    path = UsageLedger(project).path.parent / "runtime-bounds.json"
    if not path.is_file():
        raise ValueError(
            "runtime_compatibility_unknown: installed Claude Code request/context/output/child limits require compatibility evidence before cloud execution"
        )
    bounds = json.loads(path.read_text(encoding="utf-8"))
    version = subprocess.run(
        [executable, "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()
    record = bounds.get("profiles", {}).get(profile, {})
    if bounds.get("claude_version") != version or record.get("verified") is not True:
        raise ValueError(
            f"runtime_compatibility_unknown: missing version-matched {profile} runtime evidence"
        )
    evidence = record.get("evidence_path")
    if not evidence or not (path.parent / evidence).is_file():
        raise ValueError(
            "runtime_compatibility_unknown: runtime compatibility evidence file missing"
        )
    for name in (
        "max_turns",
        "max_output_tokens",
        "max_prompt_bytes",
        "max_images",
    ):
        value = record.get(name)
        if type(value) not in (int, float) or not 0 <= value <= 25000000:
            raise ValueError(f"Invalid runtime limit {name}")
    maximum = record.get("maximum_requests")
    if (
        (maximum is not None and (type(maximum) is not int or maximum < 1))
        or record.get("transport") != TRANSPORT_VERSION
        or record["max_turns"] < 1
    ):
        raise ValueError("Invalid runtime request/turn limit")
    return record


def execute_counted(project, ledger, task_id, bounds, args, env, **kwargs):
    """Track Claude requests, including children and fallbacks."""
    guard = RequestTracker(
        env["ANTHROPIC_MODEL"],
        bounds["maximum_requests"],
        env["ARK_AGENT_PLAN_API_KEY"],
    )
    history = ledger.path.parent / "requests"
    history.mkdir(parents=True, exist_ok=True)
    evidence = history / f"{task_id}-transport.json"
    try:
        with guard:
            proc = subprocess.run(
                args,
                env=guard.environment(env),
                capture_output=True,
                text=True,
                check=False,
                **kwargs,
            )
            (history / f"{task_id}-claude.jsonl").write_text(
                proc.stdout, encoding="utf-8"
            )
            return proc
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout or ""
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        (history / f"{task_id}-claude.jsonl").write_text(output, encoding="utf-8")
        raise
    finally:
        evidence.write_text(
            json.dumps(guard.report(), indent=2) + "\n", encoding="utf-8"
        )
        ledger.record_requests(task_id, guard.report(), str(evidence))


def process_environment(
    model: str, source: dict[str, str] | None = None
) -> dict[str, str]:
    if model not in {FLASH, VISION}:
        raise ValueError("Unsupported Plan text model")
    env = dict(os.environ if source is None else source)
    key = env.get("ARK_AGENT_PLAN_API_KEY", "")
    if not key or key.startswith("<"):
        raise ValueError("ARK_AGENT_PLAN_API_KEY is required")
    base = env.get("ARK_AGENT_PLAN_ANTHROPIC_BASE_URL", PLAN_ANTHROPIC)
    if base.rstrip("/") != PLAN_ANTHROPIC:
        raise ValueError(
            "Agent Plan Anthropic endpoint must match the project contract"
        )
    for name in (
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_RETRY_WATCHDOG",
    ):
        env.pop(name, None)
    env.update(
        ANTHROPIC_AUTH_TOKEN=key,
        ANTHROPIC_BASE_URL=PLAN_ANTHROPIC,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
        ENABLE_TOOL_SEARCH="false",
        CLAUDE_CODE_MAX_RETRIES="0",
        CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES="0",
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH="1" if model == FLASH else "0",
        CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS="1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS="1",
    )
    for name in MODEL_VARIABLES:
        env[name] = model
    if model == FLASH:
        env["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"] = "1"
    else:
        env.pop("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", None)
    return env


def claude_executable() -> str:
    executable = os.environ.get("GAME_DEVELOPING_AGENT_CLAUDE_EXECUTABLE") or shutil.which("claude")
    if not executable:
        raise ValueError(
            "Claude Code executable missing; configure GAME_DEVELOPING_AGENT_CLAUDE_EXECUTABLE"
        )
    result = subprocess.run(
        [executable, "--version"],
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    version = re.search(r"(\d+)\.(\d+)\.(\d+)", result.stdout)
    if not version or tuple(map(int, version.groups())) < (2, 1, 257):
        raise ValueError("Claude Code >=2.1.257 is required for scoped model routing")
    return executable


def parse_cli_result(stdout: str, expected_model: str) -> dict[str, Any]:
    events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    result = next(
        (item for item in reversed(events) if item.get("type") == "result"), None
    )
    if (
        not result
        or result.get("is_error")
        or result.get("subtype") not in {None, "success"}
    ):
        raise ValueError("Claude Code task did not return a successful result")
    models = set(result.get("modelUsage", {}))
    models.update(
        item["message"]["model"]
        for item in events
        if item.get("type") == "assistant" and item.get("message", {}).get("model")
    )
    if not models or not models.issubset(RESPONSE_MODELS[expected_model]):
        raise ValueError("Claude Code returned a model outside the task route")
    value = result.get("structured_output")
    if value is None:
        text = result.get("result", "").strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
        value = json.loads(text)
    if not isinstance(value, dict):
        raise TypeError("Claude Code task output must be one JSON object")
    return {
        "value": value,
        "usage": result.get("usage"),
        "model_usage": result.get("modelUsage"),
        "observed_models": sorted(models),
        "requested_model": expected_model,
        "session_id": result.get("session_id"),
    }


def save_pipeline_session(path: Path, stdout: str, request: str, **metadata) -> dict:
    """Preserve the real CLI session even when a bounded turn stops mid-task."""
    events = []
    for line in stdout.splitlines():
        try:
            item = json.loads(line)
        except (ValueError, TypeError):
            continue  # A timed-out stream can end inside its final JSON line.
        if isinstance(item, dict):
            events.append(item)
    result = next(
        (item for item in reversed(events) if item.get("type") == "result"), {}
    )
    session = result.get("session_id") or next(
        (item.get("session_id") for item in events if item.get("subtype") == "init"),
        None,
    )
    record = {
        "session_id": session,
        "request": request,
        "status": "interrupted" if result.get("is_error", True) else "returned",
        "terminal_reason": result.get("terminal_reason", result.get("subtype")),
        **metadata,
    }
    if session:
        record["session_id"] = session
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, record)
    return record


class PipelineInterrupted(ValueError):
    def __init__(self, recovery: dict):
        self.recovery = recovery
        super().__init__(recovery["reason"])


def complete_pipeline_recovery(project: Path, repo: Path) -> dict | None:
    """Reuse current authoritative development acceptance and finish local recovery."""
    from ..config import Config
    from ..errors import ToolError
    from ..server import ServerState, ToolCtx
    from ..tools.development_tools import development_gate
    from ..tools.verify_tools import _require_pipeline_identity

    previous = project / ".playtest/history/claude-session.json"
    try:
        state = json.loads((project / ".playtest/state.json").read_text())
        spec = json.loads((project / "game-spec.json").read_text())
        report = json.loads(
            (project / ".playtest/verify/verify-report.json").read_text()
        )
        run = json.loads((project / ".playtest/verify/current-run.json").read_text())
        saved = json.loads(previous.read_text()) if previous.is_file() else {}
        config = Config.from_env(config_path=repo / "game_developing_agent.config.yaml")
        if (
            not config.verify.development_enabled
            or spec.get("validation_profile") != "development"
            or (state.get("details") or {}).get("acceptance_profile") != "development"
            or state.get("phase") != "development_verify"
            or state.get("phase_status") != "completed"
            or run.get("mode") != "development"
            or run.get("status") != "finalized"
            or report.get("mode") != "development"
            or not run.get("verify_run_id")
        ):
            return None
        # A prior acceptance cannot complete a newly submitted, unfinished request.
        if saved.get("status") in {"running", "interrupted", "returned"} and (
            saved.get("verification_before") == run["verify_run_id"]
        ):
            return None
        identity = _require_pipeline_identity(
            project, ToolCtx(ServerState(config=config, repo_root=repo))
        )
        if (
            any(run.get(key) != value for key, value in identity.items())
            or any(
                report.get(key) != run.get(key)
                for key in ("pipeline_run_id", "build_digest", "verify_run_id")
            )
            or any(
                run.get(key) != state.get(key)
                for key in ("quality_profile", "level_model")
                if key in run
            )
        ):
            return None
        gate = development_gate(report, identity["build_digest"])
        if not gate["development_ready"] or any(
            report.get(key) != gate[key]
            for key in ("status", "development_ready", "ready_to_ship")
        ):
            return None
    except (OSError, ValueError, TypeError, KeyError, ToolError):
        return None
    if saved:
        saved.update(
            status="completed_external",
            next_action="Development acceptance complete",
            completion_evidence={
                key: run[key]
                for key in ("pipeline_run_id", "build_digest", "verify_run_id")
            },
        )
        atomic_write_json(previous, saved)
    return {
        **report,
        "reused_verification": True,
        "next_action": "Development acceptance complete",
    }


def run_json_task(
    project: Path,
    prompt: str,
    *,
    model: str = FLASH,
    images: list[dict] | None = None,
    timeout: float = 180,
    task_id: str | None = None,
    max_tokens: int = 12000,
) -> dict:
    """One isolated, tool-free AI-tool task. Usage stays pending for reconciliation."""
    if os.environ.get("CLAUDECODE"):
        raise ValueError(
            "Schedule this independent task from the outer game_developing_agent process after the active Claude task exits"
        )
    env = process_environment(model)
    executable = claude_executable()
    ledger = UsageLedger(project)
    task_id = task_id or f"claude-{uuid.uuid4().hex}"
    bounds = runtime_bounds(
        project, executable, "vision" if model == VISION else "review"
    )
    if (
        len(prompt.encode("utf-8")) > bounds["max_prompt_bytes"]
        or len(images or []) > bounds["max_images"]
        or max_tokens > bounds["max_output_tokens"]
    ):
        raise ValueError("Task exceeds verified runtime input/output envelope")
    env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(max_tokens)
    env["CLAUDE_CODE_EXTRA_BODY"] = '{"thinking":{"type":"disabled"}}'
    content = [{"type": "text", "text": prompt}, *(images or [])]
    message = {"type": "user", "message": {"role": "user", "content": content}}
    args = [
        executable,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--max-turns",
        "1",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--system-prompt",
        "Complete the supplied task using only the supplied content. Return one valid JSON object.",
    ]
    try:
        with (
            runtime_slot(project),
            tempfile.TemporaryDirectory(prefix="game_developing_agent-plan-task-") as work,
        ):
            ledger.start(
                task_id,
                "vision" if model == VISION else "agent",
                provider="ark-agent-plan",
                model=model,
            )
            try:
                proc = execute_counted(
                    project,
                    ledger,
                    task_id,
                    bounds,
                    args,
                    env,
                    input=json.dumps(message) + "\n",
                    cwd=work,
                    timeout=timeout,
                )
            except (OSError, subprocess.SubprocessError):
                ledger.mark_unknown(task_id)
                raise
        if proc.returncode:
            raise ValueError(
                f"Claude Code task exited with code {proc.returncode}; reservation retained"
            )
        parsed = parse_cli_result(proc.stdout, model)
        ledger.finish(task_id)
        ledger.mark_submitted(task_id, parsed.get("session_id") or task_id)
        ledger.note_usage(
            task_id,
            usage={
                "usage": parsed.get("usage"),
                "model_usage": parsed.get("model_usage"),
            },
        )
        parsed["task_id"] = task_id
        record_dir = project / ".playtest" / "history"
        record_dir.mkdir(parents=True, exist_ok=True)
        (record_dir / f"{task_id}.json").write_text(
            json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return parsed
    except (TypeError, ValueError, OSError, subprocess.SubprocessError):
        if any(row["task_id"] == task_id for row in ledger.status()["tasks"]):
            ledger.mark_unknown(task_id)
        raise


def run_pipeline(project: Path, request: str, *, mode: str, repo: Path) -> dict:
    """Launch the existing GAME_DEVELOPING_AGENT skill with project-scoped model/MCP configuration."""
    if mode not in {"create", "change", "resume"}:
        raise ValueError("Unsupported pipeline mode")
    if mode == "resume":
        completed = complete_pipeline_recovery(project, repo)
        if completed is not None:
            return completed
    if os.environ.get("CLAUDECODE"):
        raise ValueError(
            "Run game_developing_agent from the outer terminal to schedule independent Claude tasks"
        )
    env = process_environment(FLASH)
    executable = claude_executable()
    ledger = UsageLedger(project)
    task_id = f"pipeline-{uuid.uuid4().hex}"
    previous = project / ".playtest/history/claude-session.json"
    saved = json.loads(previous.read_text()) if previous.is_file() else {}
    original_request = (saved.get("request") if mode == "resume" else None) or request
    run_path = project / ".playtest/verify/current-run.json"
    verification_before = (
        json.loads(run_path.read_text()).get("verify_run_id")
        if run_path.is_file()
        else None
    )
    if mode == "resume" and "verification_before" in saved:
        verification_before = saved["verification_before"]
    session_metadata = {
        "task_id": task_id,
        "verification_before": verification_before,
        "next_action": f"game_developing_agent resume --project {shlex.quote(str(project))}",
    }
    if mode == "resume" and saved.get("session_id"):
        session_metadata["session_id"] = saved["session_id"]
    history = ledger.path.parent / "requests"
    history.mkdir(parents=True, exist_ok=True)
    record = {
        "task_id": task_id,
        "project": str(project),
        "mode": mode,
        "request": original_request,
        "status": "prepared",
    }
    record_path = history / f"{task_id}.json"

    def save():
        record_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    save()
    try:
        bounds = runtime_bounds(project, executable, "pipeline")
        if len(request.encode("utf-8")) > bounds["max_prompt_bytes"]:
            raise ValueError("Request exceeds verified runtime input envelope")
        spec_path = project / "game-spec.json"
        spec = json.loads(spec_path.read_text()) if spec_path.is_file() else {}
        memories = MemoryStore(project).select(
            scope="project",
            game=spec.get("project_id", project.name),
            keywords=["dodge"],
            versions=spec.get("revisions", {}),
            limit=5,
        )
        context = {
            "mode": mode,
            "project": str(project),
            "request": request,
            "active_memories": memories,
        }
        if mode == "resume" and saved.get("request"):
            context["interrupted_request"] = original_request
        routing = (
            "Continue the saved session and its already-read routing contracts; perform its interrupted owner tasks next. "
            if context.get("interrupted_request")
            else f"Read {repo}/.claude/skills/game-pipeline/SKILL.md and its iteration/resume procedures. "
        )
        prompt = (
            f"First bind this process's MCP workspace with init_workspace(path={project}, "
            f"mode={'create' if mode == 'create' else 'resume'}). "
            + routing
            + f"Apply {repo}/CLAUDE.md as the explicit development-profile contract. "
            "Use GAME_DEVELOPING_AGENT MCP and the existing professional agents. Join each child before dispatching the next; "
            "Invoke the available Task or Agent tool with subagent_type for professional delegation. "
            "After reading the routing contract and binding the workspace, dispatch the first required owner promptly. "
            "Use Read/Glob/Grep for inspection and keep implementation inspection within the owning child. "
            "children must complete their assigned work without recursively delegating. "
            "Keep a single code writer. Save actual progress using write_pipeline_state. "
            "Seed vision is scheduled by the outer game_developing_agent verify command after this process exits. "
            "For a new default dodge game, pass ACCEPTANCE_PROFILE=development and DEFAULT_SPEC_PATH="
            f"{repo}/game_developing_agent-mcp/src/game_developing_agent_mcp/local/templates/dodge/default-spec.json to design-agent, "
            "then dispatch scaffold-agent to invoke scaffold_dodge_project for the reusable local template. "
            "Record provider usage and preserve accepted media task identities. Return one JSON object with status, "
            "summary, artifacts, next_action and blocked_checks. Task:\n"
            + json.dumps(context, ensure_ascii=False)
        )
        env.update(
            GAME_DEVELOPING_AGENT_LOCAL_PROJECT=str(project),
            GAME_DEVELOPING_AGENT_PYTHON_EXECUTABLE=os.sys.executable,
            CLAUDE_CODE_MAX_OUTPUT_TOKENS=str(int(bounds["max_output_tokens"])),
        )
        mcp = {
            "mcpServers": {
                "game_developing_agent": {
                    "command": os.sys.executable,
                    "args": ["-m", "game_developing_agent_mcp.cli", "--repo-root", str(repo)],
                    "env": {
                        "HTTPS_PROXY": "",
                        "HTTP_PROXY": "",
                        "https_proxy": "",
                        "http_proxy": "",
                        "NO_PROXY": "ark.cn-beijing.volces.com,localhost,127.0.0.1",
                        "NODE_EXTRA_CA_CERTS": "",
                        "ANTHROPIC_AUTH_TOKEN": "",
                    },
                }
            }
        }
        args = [
            executable,
            "-p",
            prompt,
            "--model",
            FLASH,
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            str(int(bounds["max_turns"])),
            "--setting-sources",
            "project",
            "--strict-mcp-config",
            "--mcp-config",
            json.dumps(mcp),
            "--permission-mode",
            "dontAsk",
            "--allowedTools",
            # The loaded project hook restricts Bash to the pipeline's exact
            # preflight/audit/server/prompt operations and forbids child shells.
            "Task,Agent,Workflow,Read,Glob,Grep,Write,Edit,Skill,mcp__game_developing_agent__*,Bash",
        ]
        if mode == "resume" and previous.is_file():
            session = json.loads(previous.read_text()).get("session_id")
            if session:
                args += ["--resume", session]
        with runtime_slot(project):
            ledger.start(
                task_id, "agent", model=FLASH
            )
            record["status"] = "running"
            save()
            save_pipeline_session(
                previous, "", original_request, status="running", **session_metadata
            )
            proc = execute_counted(
                project,
                ledger,
                task_id,
                bounds,
                args,
                env,
                cwd=repo,
                timeout=1800,
            )
        save_pipeline_session(
            previous, proc.stdout, original_request, **session_metadata
        )
        transport_path = history / f"{task_id}-transport.json"
        if (
            transport_path.is_file()
            and "Task HTTP request limit exhausted"
            in json.loads(transport_path.read_text()).get("denied", [])
        ):
            raise ValueError("Local HTTP request limit reached")
        if proc.returncode:
            raise ValueError(
                f"Claude pipeline exited {proc.returncode}; existing state and reservation retained"
            )
        parsed = parse_cli_result(proc.stdout, FLASH)
        ledger.finish(task_id)
        ledger.mark_submitted(task_id, parsed.get("session_id") or task_id)
        ledger.note_usage(
            task_id,
            usage={
                "usage": parsed.get("usage"),
                "model_usage": parsed.get("model_usage"),
            },
        )
        save_pipeline_session(
            previous, proc.stdout, original_request, **session_metadata, result=parsed
        )
        record.update(status="completed", session_id=parsed.get("session_id"))
        save()
        return {"task_id": task_id, **parsed["value"]}
    except (TypeError, ValueError, OSError, subprocess.SubprocessError) as exc:
        started = record["status"] == "running"
        record.update(status="blocked", reason=str(exc))
        if started:
            transcript_path = history / f"{task_id}-claude.jsonl"
            transcript = (
                transcript_path.read_text() if transcript_path.is_file() else ""
            )
            transport_path = history / f"{task_id}-transport.json"
            transport = (
                json.loads(transport_path.read_text())
                if transport_path.is_file()
                else {}
            )
            reason_code = "pipeline_interrupted"
            if "Task HTTP request limit exhausted" in transport.get("denied", []):
                reason_code = "http_request_limit"
                record["reason"] = (
                    f"Local HTTP request limit reached ({transport.get('forwarded_requests')}"
                    f"/{transport.get('maximum_requests')}); progress and pending usage retained. "
                    "Resume once after reviewing progress; each continuation records its own request usage."
                )
            recovery = save_pipeline_session(
                previous,
                transcript,
                original_request,
                **session_metadata,
                status="interrupted",
                reason_code=reason_code,
                reason=record["reason"],
                forwarded_requests=transport.get("forwarded_requests"),
                maximum_requests=transport.get("maximum_requests"),
            )
            record.update(reason_code=reason_code, next_action=recovery["next_action"])
        save()
        if any(row["task_id"] == task_id for row in ledger.status()["tasks"]):
            ledger.mark_unknown(task_id)
        if started:
            raise PipelineInterrupted(
                {
                    "status": "blocked",
                    "task_id": task_id,
                    "reason": record["reason"],
                    "reason_code": reason_code,
                    "next_action": record["next_action"],
                    "recovery_file": str(previous),
                }
            ) from exc
        raise
