"""Keep the exact locally sampled images sent to the independent vision task."""
import base64
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from game_developing_agent_mcp.local import vision


def test_sampled_video_persists_exact_task_inputs_after_temp_cleanup(tmp_path, monkeypatch):
    sent = []

    def process(command, **kwargs):
        if command[0] == "ffprobe":
            return SimpleNamespace(stdout=json.dumps({"format": {"duration": "4"}}))
        Image.new("RGB", (8, 8), (int(float(command[4]) * 30), 0, 0)).save(command[-1])
        return SimpleNamespace(stdout="")

    def task(project, prompt, **kwargs):
        sent.extend(base64.b64decode(image["source"]["data"]) for image in kwargs["images"])
        return {"value": {"visible_findings": [], "issues": [], "evidence_refs": []},
                "task_id": "claude-fixture"}

    monkeypatch.setattr(vision.subprocess, "run", process)
    monkeypatch.setattr(vision, "run_json_task", task)
    response = vision.vision_content([
        {"type": "text", "text": "Observe sampled frames"},
        {"type": "video_url", "video_url": {"url": "data:video/mp4;base64," + base64.b64encode(b"fixture").decode()}},
    ], project=tmp_path, max_tokens=100, timeout=10)
    result = json.loads(response["text"])
    assert result["input_mode"] == "sampled_frames"
    assert result["frame_timestamps_ms"] == [0, 667, 1333, 2000, 2667, 3333]
    assert len(result["frame_evidence"]) == len(sent) == 6
    for item, body in zip(result["frame_evidence"], sent, strict=True):
        assert (tmp_path / item["path"]).read_bytes() == body
        assert item["sha256"] == hashlib.sha256(body).hexdigest()
    saved = tmp_path / Path(result["frame_evidence"][0]["path"]).parent / "observation.json"
    assert json.loads(saved.read_text()) == result
