# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Explicitly activated Markdown knowledge with evidence and version scope."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from ._store import atomic_text, locked_record


class MemoryStore:
    def __init__(self, root: Path | str):
        self.directory = Path(root).resolve() / ".game_developing_agent/memory"
        self.index = self.directory / "index.json"

    def _path(self, memory_id: str) -> Path:
        if not memory_id.startswith("memory-") or not memory_id[7:].isalnum():
            raise ValueError("Invalid memory ID")
        return self.directory / f"{memory_id}.md"

    def _read(self, memory_id: str) -> dict:
        text = self._path(memory_id).read_text(encoding="utf-8")
        return json.loads(text.split("\n---\n", 1)[0].removeprefix("---\n"))

    def _write(self, record: dict) -> None:
        header = json.dumps(record, ensure_ascii=False, indent=2)
        text = (
            f"---\n{header}\n---\n\n# {record['memory_id']}\n\n{record['conclusion']}\n"
        )
        atomic_text(self._path(record["memory_id"]), text)

    def add(
        self,
        conclusion: str,
        *,
        scope: str,
        game: str = "",
        keywords: list[str] | None = None,
        versions: dict | None = None,
        source: str,
        evidence_level: str,
        evidence_refs: list[str] | None = None,
        applicability: str = "",
    ) -> dict:
        if not conclusion.strip() or not scope or not source or not evidence_level:
            raise ValueError(
                "Conclusion, scope, source, and evidence level are required"
            )
        if scope == "project" and not game:
            raise ValueError("Project memories require a game/project ID")
        record = {
            "memory_id": "memory-" + uuid.uuid4().hex[:12],
            "conclusion": conclusion,
            "scope": scope,
            "game": game,
            "keywords": list(keywords or []),
            "versions": dict(versions or {}),
            "source": source,
            "evidence_level": evidence_level,
            "evidence_refs": list(evidence_refs or [source]),
            "applicability": applicability,
            "status": "pending",
            "history": [],
            "created_at_utc": datetime.now(UTC).isoformat(),
        }
        with locked_record(self.index, {"ids": []}) as index:
            self._write(record)
            index["ids"].append(record["memory_id"])
        return record

    def list_all(self) -> list[dict]:
        if not self.index.exists():
            return []
        with locked_record(self.index, {"ids": []}) as index:
            return [self._read(memory_id) for memory_id in index["ids"]]

    def _transition(self, memory_id: str, status: str, reason: str = "") -> dict:
        with locked_record(self.index, {"ids": []}) as index:
            if memory_id not in index["ids"]:
                raise ValueError(f"Unknown memory ID: {memory_id}")
            record = self._read(memory_id)
            old = record["status"]
            if status == "active" and old not in {"pending", "active"}:
                raise ValueError(
                    "Stale memories require supplemental evidence; retired memories remain archived"
                )
            if old == "retired" and status != "retired":
                raise ValueError("Retired memories remain archived")
            if old != status:
                record["history"].append(
                    {
                        "from": old,
                        "to": status,
                        "reason": reason,
                        "at_utc": datetime.now(UTC).isoformat(),
                    }
                )
                record["status"] = status
                self._write(record)
            return record

    def activate(self, memory_id: str) -> dict:
        """Called only by an explicit user activation command."""
        return self._transition(memory_id, "active", "explicit activation")

    def set_status(self, memory_id: str, status: str, reason: str = "") -> dict:
        if status not in {"stale", "retired"}:
            raise ValueError(
                "Use explicit activate for pending memories; status accepts stale or retired"
            )
        return self._transition(memory_id, status, reason)

    def supplement(
        self,
        memory_id: str,
        *,
        evidence_refs: list[str],
        evidence_level: str,
        versions: dict,
    ) -> dict:
        if not evidence_refs or not evidence_level:
            raise ValueError("Supplemental evidence and evidence level are required")
        with locked_record(self.index, {"ids": []}) as index:
            if memory_id not in index["ids"]:
                raise ValueError(f"Unknown memory ID: {memory_id}")
            record = self._read(memory_id)
            if record["status"] == "retired":
                raise ValueError("Retired memories remain archived")
            record["history"].append(
                {
                    "from": record["status"],
                    "to": "pending",
                    "reason": "supplemental evidence",
                    "previous_versions": record["versions"],
                    "previous_evidence_level": record["evidence_level"],
                    "at_utc": datetime.now(UTC).isoformat(),
                }
            )
            record.update(
                status="pending", versions=dict(versions), evidence_level=evidence_level
            )
            record["evidence_refs"] = list(
                dict.fromkeys([*record["evidence_refs"], *evidence_refs])
            )
            self._write(record)
            return record

    def select(
        self,
        *,
        scope: str,
        game: str = "",
        keywords: list[str] | None = None,
        versions: dict | None = None,
        limit: int = 5,
    ) -> list[dict]:
        if limit < 0:
            raise ValueError("Memory selection limit must be nonnegative")
        selected = []
        query = {word.casefold() for word in keywords or []}
        current_versions = versions or {}
        for record in self.list_all():
            if record["status"] != "active":
                continue
            if record["scope"] not in {scope, "global", "cross-project"}:
                continue
            if record["game"] and record["game"] != game:
                continue
            if any(
                current_versions.get(key) != value
                for key, value in record["versions"].items()
            ):
                continue
            tags = {word.casefold() for word in record["keywords"]}
            if query and not query.intersection(tags):
                continue
            selected.append(record)
        return selected[:limit]
