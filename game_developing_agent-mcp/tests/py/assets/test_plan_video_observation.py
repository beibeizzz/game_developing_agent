"""Exercise Plan's JSON observation through the public asset-video validator."""
import json

import pytest

from game_developing_agent_mcp.adapters import asset_video_validator as validator
from game_developing_agent_mcp.config import Config

REPORT = "RUBRIC R1: PASS\nRUBRIC R2: PASS\nOVERALL VERDICT: PASS\nFAILED RUBRICS: none"


def run_validation(tmp_path, monkeypatch, raw):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fixture: provider transport is mocked")

    def observe(**kwargs):
        assert kwargs["video_path"] == video
        assert "rubric_report" in kwargs["prompt"]
        assert "supplied timestamps" in kwargs["prompt"]
        return raw

    monkeypatch.setattr(validator, "call_vlm_on_video", observe)
    return validator.validate_asset_video(
        Config.from_env(), video_path=video, action_description="Visible exhaust in sampled frames"
    )


def test_plan_json_observation_retains_timestamped_evidence(tmp_path, monkeypatch):
    observation = {
        "rubric_report": REPORT,
        "input_mode": "sampled_frames", "frame_timestamps_ms": [0, 667, 1333],
        "visible_findings": ["exhaust inside frame"], "issues": [],
        "evidence_refs": [{"image": 0, "timestamp_ms": 0}],
        "coverage_limits": ["Only supplied samples observed."], "task_id": "fixture",
    }
    result = run_validation(tmp_path, monkeypatch, json.dumps(observation))
    assert result["passed"] is True
    assert result["n_passed"] == 2
    assert result["observation"] == observation


@pytest.mark.parametrize("report", [
    REPORT + "\nRUBRIC R1: FAIL",
    "RUBRIC R1: PASS\nOVERALL VERDICT: PASS\nFAILED RUBRICS: none",
    None,
])
def test_plan_envelope_preserves_strict_rubric_rejection(tmp_path, monkeypatch, report):
    raw = json.dumps({"rubric_report": report, "status": "pass"})
    assert run_validation(tmp_path, monkeypatch, raw)["passed"] is False


def test_legacy_plain_report_remains_supported(tmp_path, monkeypatch):
    assert run_validation(tmp_path, monkeypatch, REPORT)["passed"] is True
