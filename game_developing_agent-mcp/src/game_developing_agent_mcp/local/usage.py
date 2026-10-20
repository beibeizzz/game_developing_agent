"""Atomic task and provider usage records for the local workflow."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from ._store import locked_record


class UsageLedger:
    def __init__(self, root: Path | str):
        root = Path(root).resolve()
        owner = next(
            (p for p in (root, *root.parents) if (p / ".game_developing_agent").is_dir()),
            root,
        )
        self.path = owner / ".game_developing_agent/usage.json"

    @staticmethod
    def _empty():
        return {"schema_version": 1, "tasks": []}

    def status(self) -> dict:
        with locked_record(self.path, self._empty()) as data:
            return data

    def start(self, task_id: str, category: str, *, provider="", model="") -> dict:
        with locked_record(self.path, self._empty()) as data:
            if any(row["task_id"] == task_id for row in data["tasks"]):
                raise ValueError("Task already recorded")
            record = {
                "task_id": task_id,
                "category": category,
                "provider": provider,
                "model": model,
                "status": "started",
                "started_at_utc": datetime.now(UTC).isoformat(),
            }
            data["tasks"].append(record)
            return record

    def _update(self, task_id: str, **values) -> dict:
        with locked_record(self.path, self._empty()) as data:
            row = next((r for r in data["tasks"] if r["task_id"] == task_id), None)
            if row is None:
                raise ValueError("Unknown task")
            row.update(values)
            return row

    def mark_submitted(self, task_id: str, provider_task_id: str):
        return self._update(task_id, provider_task_id=provider_task_id)

    def mark_unknown(self, task_id: str):
        with locked_record(self.path, self._empty()) as data:
            row = next(r for r in data["tasks"] if r["task_id"] == task_id)
            if row["status"] != "completed":
                row["status"] = "unknown"

    def note_usage(self, task_id: str, *, usage=None, request_id=None):
        return self._update(task_id, usage=usage, request_id=request_id)

    def finish(self, task_id: str):
        return self._update(
            task_id, status="completed", finished_at_utc=datetime.now(UTC).isoformat()
        )

    def record_requests(self, task_id: str, report: dict, evidence_ref: str):
        return self._update(
            task_id,
            forwarded_requests=report["forwarded_requests"],
            transport=report,
            evidence_ref=evidence_ref,
        )

    def restore_media_task(self, task_id, model, provider_task_id, evidence_ref):
        """Restore an accepted task without authorizing a new submission."""
        with locked_record(self.path, self._empty()) as data:
            row = next((r for r in data["tasks"] if r["task_id"] == task_id), None)
            if row is None:
                row = {
                    "task_id": task_id,
                    "category": "animation",
                    "provider": "ark-agent-plan",
                    "model": model,
                    "status": "unknown",
                }
                data["tasks"].append(row)
            if row["model"] != model or row.get("provider_task_id", provider_task_id) != provider_task_id:
                raise ValueError("Accepted task identity mismatch")
            row.update(provider_task_id=provider_task_id, evidence_ref=evidence_ref)
            return row
