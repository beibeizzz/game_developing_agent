# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Read-only Plan vision through Claude Code, including explicitly sampled video."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

from .runtime import VISION, run_json_task


def _decode_data_url(url: str) -> tuple[str, bytes]:
    if not url.startswith("data:") or ";base64," not in url:
        raise ValueError(
            "Vision inputs must be local images supplied as base64 data URLs"
        )
    header, data = url.split(",", 1)
    return header[5:].split(";", 1)[0], base64.b64decode(data, validate=True)


def vision_content(
    content: list[dict], *, project: Path, max_tokens: int, timeout: float
) -> dict:
    prompts = [part["text"] for part in content if part.get("type") == "text"]
    images: list[dict] = []
    timestamps: list[int] = []
    source_duration_ms = None
    input_mode = "images"
    with tempfile.TemporaryDirectory(prefix="game_developing_agent-vision-") as work:
        directory = Path(work)
        for part in content:
            if part.get("type") == "image_url":
                mime, body = _decode_data_url(part["image_url"]["url"])
                if mime not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                    raise ValueError("Unsupported image media type")
                path = directory / f"image-{len(images)}"
                path.write_bytes(body)
                with Image.open(path) as image:
                    image.verify()
                images.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime,
                            "data": base64.b64encode(body).decode(),
                        },
                    }
                )
            elif part.get("type") == "video_url":
                if input_mode == "sampled_frames" or images:
                    raise ValueError(
                        "Provide one video or a batch of images per vision task"
                    )
                input_mode = "sampled_frames"
                _, body = _decode_data_url(part["video_url"]["url"])
                video = directory / "source-video.mp4"
                video.write_bytes(body)
                probe = subprocess.run(
                    [
                        "ffprobe",
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "json",
                        str(video),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=True,
                )
                duration = float(json.loads(probe.stdout)["format"]["duration"])
                if not 0 < duration <= 60:
                    raise ValueError(
                        "Sampled-frame vision accepts videos up to 60 seconds"
                    )
                source_duration_ms = round(duration * 1000)
                for index in range(6):
                    second = duration * index / 6
                    frame = directory / f"frame-{index}.png"
                    subprocess.run(
                        [
                            "ffmpeg",
                            "-v",
                            "error",
                            "-ss",
                            str(second),
                            "-i",
                            str(video),
                            "-frames:v",
                            "1",
                            "-y",
                            str(frame),
                        ],
                        capture_output=True,
                        timeout=30,
                        check=True,
                    )
                    timestamps.append(round(second * 1000))
                    images.append(
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": base64.b64encode(frame.read_bytes()).decode(),
                            },
                        }
                    )
        if not 1 <= len(images) <= 6:
            raise ValueError("Vision task requires one to six game images")
        limits = ["Observations cover only the supplied images."]
        if input_mode == "sampled_frames":
            limits.append(
                "Sampled frames provide visible-scene evidence; continuous motion and frame-between events require local gameplay checks."
            )
        prompt = (
            "\n".join(prompts)
            + "\nReturn the JSON contract requested above. Include visible_findings, issues and evidence_refs locating image index and object/region. "
        )
        prompt += json.dumps(
            {
                "input_mode": input_mode,
                "frame_timestamps_ms": timestamps,
                "coverage_limits": limits,
            }
        )
        result = run_json_task(
            project,
            prompt,
            model=VISION,
            images=images,
            max_tokens=max_tokens,
            timeout=timeout,
        )
    value = result["value"]
    for name in ("visible_findings", "issues", "evidence_refs"):
        if not isinstance(value.get(name), list):
            raise TypeError(f"Vision result requires array {name}")
    value.update(
        model=VISION,
        provider="claude_code_vision_task",
        input_mode=input_mode,
        frame_timestamps_ms=timestamps,
        source_duration_ms=source_duration_ms,
        coverage_limits=limits,
        task_id=result["task_id"],
    )
    if input_mode == "sampled_frames":
        evidence_dir = project / ".playtest/history/vision" / result["task_id"]
        evidence_dir.mkdir(parents=True, exist_ok=True)
        frame_evidence = []
        for index, (item, timestamp) in enumerate(zip(images, timestamps, strict=True)):
            body = base64.b64decode(item["source"]["data"], validate=True)
            path = evidence_dir / f"frame-{index}.png"
            path.write_bytes(body)
            frame_evidence.append({
                "path": path.relative_to(project).as_posix(),
                "timestamp_ms": timestamp,
                "sha256": hashlib.sha256(body).hexdigest(),
            })
        value["frame_evidence"] = frame_evidence
        (evidence_dir / "observation.json").write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return {
        "text": json.dumps(value, ensure_ascii=False),
        "usage": result.get("usage"),
        "model": VISION,
        "input_mode": input_mode,
        "coverage_limits": limits,
    }


def main() -> int:
    import sys

    try:
        payload = json.load(sys.stdin)
        result = vision_content(
            payload["content"],
            project=Path(payload.get("project") or os.getcwd()),
            max_tokens=int(payload.get("max_tokens", 2500)),
            timeout=float(payload.get("timeout", 180)),
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (TypeError, ValueError, OSError, subprocess.SubprocessError) as exc:
        print(
            json.dumps(
                {"error": str(exc), "errorKind": "vision_task", "retryable": False}
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
