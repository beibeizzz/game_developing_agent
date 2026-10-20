# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Resume accepted Seedance tasks from their output-side checkpoint."""

from __future__ import annotations

import json
from pathlib import Path

from ..adapters import seedance
from ..config import SEEDANCE_FAST_MODEL, Config
from ..errors import ToolError
from ..providers import get_provider
from ._store import atomic_text
from .media_usage import (
    pending_media,
    record_media,
    resume_media_context,
)


def resume_video_task(
    config: Config,
    checkpoint_path: Path | str,
    *,
    download: bool = True,
    server_timeout: int = 600,
    download_timeout: int = 120,
) -> dict:
    """Query/download the original task; this function never submits a generation."""
    checkpoint = Path(checkpoint_path).resolve()
    if not checkpoint.name.endswith(".task.json"):
        raise ToolError(
            "INVALID_PATH", "Seedance recovery requires an output.task.json checkpoint."
        )
    saved = json.loads(checkpoint.read_text(encoding="utf-8"))
    task_id = saved.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ToolError(
            "SUBMISSION_UNKNOWN",
            "Submission has no accepted task ID; reconcile its outcome before generation.",
        )
    model = saved.get("model", SEEDANCE_FAST_MODEL)
    if model != SEEDANCE_FAST_MODEL:
        raise ToolError(
            "INVALID_CONFIG", "Media recovery requires the approved Plan Fast model."
        )
    output_name = checkpoint.name.removesuffix(".task.json")
    if saved.get("output_name", output_name) != output_name:
        raise ToolError(
            "INVALID_PATH", "Checkpoint output must match its neighboring media file."
        )
    output = checkpoint.with_name(output_name)
    ledger, local_task_id = resume_media_context(output, task_id)
    ledger.restore_media_task(
        local_task_id, model, task_id, str(checkpoint)
    )
    reservation = ledger, local_task_id
    provider = get_provider(config)
    try:
        final = saved.get("final") or seedance._poll_task(
            config,
            provider=provider,
            endpoint=provider.video_endpoint(config),
            verify_ssl=provider.video_verify_ssl(config),
            task_id=task_id,
            native_model=model,
            server_timeout=server_timeout,
            task_checkpoint=checkpoint,
        )
        saved.update(
            status=final.get("status"),
            final=final,
            model=model,
            output_name=output_name,
        )
        atomic_text(checkpoint, json.dumps(saved))
        if final.get("status") != "succeeded":
            raise ToolError(
                "SEEDANCE_FAILED", f"Seedance task {task_id}: {final.get('status')}."
            )
        video_url = (final.get("content") or {}).get("video_url")
        if not video_url:
            raise ToolError(
                "SEEDANCE_NO_OUTPUT", f"Seedance task {task_id} has no video URL."
            )
        result = {
            "task_id": task_id,
            "request_id": saved.get("request_id"),
            "model": model,
            "model_id": model,
            "video_url": video_url,
            "protocol": "ark_native_task",
            "resumed": True,
            "checkpoint": str(checkpoint),
            "raw_response": final,
            "params": saved.get(
                "params", {"duration": 4, "resolution": "480p", "ratio": "1:1"}
            ),
        }
        record_media(reservation, result)
        if download:
            seedance._download_video_result(
                config, provider, result, output, download_timeout=download_timeout
            )
        result.pop("raw_response")
        return result
    except ToolError:
        pending_media(reservation, provider_task_id=task_id)
        raise
