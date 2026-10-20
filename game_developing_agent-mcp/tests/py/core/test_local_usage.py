"""Generic usage persistence and concurrent task ownership."""
from concurrent.futures import ThreadPoolExecutor

import pytest

from game_developing_agent_mcp.local.usage import UsageLedger


def test_concurrent_tasks_survive_reload(tmp_path):
    ledger = UsageLedger(tmp_path)
    with ThreadPoolExecutor(max_workers=4) as workers:
        list(workers.map(lambda index: ledger.start(str(index), "agent"), range(12)))
    restored = UsageLedger(tmp_path)
    assert len(restored.status()["tasks"]) == 12
    with pytest.raises(ValueError, match="already recorded"):
        restored.start("0", "agent")


def test_unknown_task_preserves_provider_identity_and_usage(tmp_path):
    ledger = UsageLedger(tmp_path)
    ledger.start("video", "animation", model="fixture-model")
    ledger.mark_submitted("video", "accepted-id")
    ledger.note_usage("video", usage={"completion_tokens": 123}, request_id="request-id")
    ledger.mark_unknown("video")
    restored = UsageLedger(tmp_path)
    row = restored.status()["tasks"][0]
    assert row["status"] == "unknown" and row["provider_task_id"] == "accepted-id"
    assert row["usage"] == {"completion_tokens": 123}
    restored.finish("video")
    restored.mark_unknown("video")
    assert restored.status()["tasks"][0]["status"] == "completed"


def test_request_evidence_and_accepted_task_restore(tmp_path):
    ledger = UsageLedger(tmp_path)
    ledger.start("text", "agent")
    report = {"forwarded_requests": 2, "records": [{"usage": {"input_tokens": 30}}]}
    ledger.record_requests("text", report, "request-report.json")
    row = ledger.status()["tasks"][0]
    assert row["transport"] == report and row["forwarded_requests"] == 2
    ledger.restore_media_task("video", "fixture-model", "accepted", "checkpoint.json")
    ledger.restore_media_task("video", "fixture-model", "accepted", "checkpoint.json")
    assert len(ledger.status()["tasks"]) == 2
    with pytest.raises(ValueError, match="identity mismatch"):
        ledger.restore_media_task("video", "fixture-model", "other-id", "checkpoint.json")
