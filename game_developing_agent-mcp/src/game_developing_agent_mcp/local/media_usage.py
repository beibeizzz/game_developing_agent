# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Track image/video usage and preserve accepted-task output ownership."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from ..errors import ToolError
from .usage import UsageLedger

_OUTPUT_IDENTITY: ContextVar[tuple[Path, Path] | None] = ContextVar("media_output_identity", default=None)


@contextmanager
def media_output_scope(staged: Path, final: Path):
    """Bind one staged artifact to its durable output identity."""
    token = _OUTPUT_IDENTITY.set((staged.resolve(), final.resolve()))
    try:
        yield
    finally:
        _OUTPUT_IDENTITY.reset(token)


def media_context(output: Path) -> tuple[UsageLedger, str]:
    """Use the bound workspace ledger and a stable, resolved artifact identity."""
    identity = output.resolve()
    scoped = _OUTPUT_IDENTITY.get()
    if scoped and identity == scoped[0]:
        identity = scoped[1]
    project = os.environ.get("GAME_DEVELOPING_AGENT_LOCAL_PROJECT")
    owner = Path(project).resolve() if project else identity.parent
    if project and not owner.is_dir():
        raise ToolError("TASK_PENDING", "GAME_DEVELOPING_AGENT_LOCAL_PROJECT must identify an existing workspace.")
    ledger = UsageLedger(owner)
    task_id = "media-" + hashlib.sha256(str(identity).encode()).hexdigest()[:24]
    return ledger, task_id



def _attempt_records(records: list[dict], base_id: str) -> list[tuple[int, dict]]:
    attempts = []
    for record in records:
        identifier = record["task_id"]
        if identifier == base_id:
            attempts.append((1, record))
        elif identifier.startswith(base_id + "-attempt-"):
            suffix = identifier.removeprefix(base_id + "-attempt-")
            if suffix.isdigit():
                attempts.append((int(suffix), record))
    return sorted(attempts, key=lambda item: item[0])


def resume_media_context(output: Path, provider_task_id: str) -> tuple[UsageLedger, str]:
    """Match the original accepted task even after a later output generation."""
    ledger, base_id = media_context(output)
    attempts = _attempt_records(ledger.status()["tasks"], base_id)
    for _, record in attempts:
        if record.get("provider_task_id") == provider_task_id:
            return ledger, record["task_id"]
    if attempts and attempts[-1][1]["status"] != "completed" and not attempts[-1][1].get("provider_task_id"):
        return ledger, attempts[-1][1]["task_id"]
    if attempts:
        # Restoring an accepted task that is absent from this ledger records a new
        # attempt without authorizing another provider submission.
        return ledger, f"{base_id}-attempt-{attempts[-1][0] + 1}"
    return ledger, base_id


def reserve_media(
    output: Path, model: str, *, resume: bool = False
) -> tuple[UsageLedger, str]:
    key = (os.environ.get("ARK_AGENT_PLAN_API_KEY") or "").strip()
    if not key or key.startswith("<"):
        raise ToolError(
            "MISSING_CREDENTIALS", "ARK_AGENT_PLAN_API_KEY is required for Plan media."
        )
    ledger, task_id = media_context(output)
    attempts = _attempt_records(ledger.status()["tasks"], task_id)
    if resume:
        checkpoint = output.with_suffix(output.suffix + ".task.json")
        accepted_id = json.loads(checkpoint.read_text(encoding="utf-8")).get("task_id") if checkpoint.exists() else None
        if accepted_id:
            ledger, task_id = resume_media_context(output, accepted_id)
            ledger.restore_media_task(task_id, model, accepted_id, str(checkpoint))
            return ledger, task_id
        elif attempts and attempts[-1][1]["model"] == model:
            return ledger, attempts[-1][1]["task_id"]
    if any(record["status"] != "completed" for _, record in attempts):
        raise ToolError(
            "TASK_PENDING",
            "Media output has a pending task; resume its accepted task or use a new owned output path.",
        )
    if attempts:
        task_id = f"{task_id}-attempt-{attempts[-1][0] + 1}"
    ledger.start(
        task_id,
        "images" if "seedream" in model else "animation",
        provider="ark-agent-plan",
        model=model,
    )
    return ledger, task_id


def record_media(reservation: tuple[UsageLedger, str] | None, result: dict) -> None:
    if reservation is None:
        return
    ledger, task_id = reservation
    if any(
        r["task_id"] == task_id and r["status"] == "completed"
        for r in ledger.status()["tasks"]
    ):
        return
    provider_id = result.get("task_id") or result.get("request_id")
    if provider_id:
        ledger.mark_submitted(task_id, str(provider_id))
    usage = result.get("usage") or (result.get("raw_response") or {}).get("usage")
    ledger.note_usage(task_id, usage=usage, request_id=result.get("request_id"))
    ledger.finish(task_id)


def pending_media(
    reservation: tuple[UsageLedger, str] | None, *, provider_task_id: str | None = None
) -> None:
    if reservation is None:
        return
    ledger, task_id = reservation
    if any(
        r["task_id"] == task_id and r["status"] == "completed"
        for r in ledger.status()["tasks"]
    ):
        return
    if provider_task_id:
        ledger.mark_submitted(task_id, provider_task_id)
    ledger.mark_unknown(task_id)
