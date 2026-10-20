# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Local wire fixtures: every external HTTP call is intercepted."""
from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image


def image_bytes():
    stream = BytesIO()
    Image.new("RGB", (960, 960), "magenta").save(stream, format="PNG")
    return stream.getvalue()

from game_developing_agent_mcp import cli, providers, server
from game_developing_agent_mcp.adapters import image_gen
from game_developing_agent_mcp.config import Config, ImageGenConfig
from game_developing_agent_mcp.errors import ToolError
from game_developing_agent_mcp.tools import lifecycle


@pytest.fixture
def config(monkeypatch):
    from game_developing_agent_mcp.adapters import seedance
    # These tests isolate wire behavior; usage recording has separate integration fixtures.
    monkeypatch.setattr(image_gen, "_reserve_plan_media", lambda *a, **k: None)
    monkeypatch.setattr(seedance, "_reserve_plan_media", lambda *a, **k: None)
    for name in ("OPENAI_API_KEY", "GAME_ASSET_BASE_URL", "GAME_ASSET_MODEL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GAME_ASSET_PROVIDER", "ark_plan_seedream")
    monkeypatch.setenv("ARK_AGENT_PLAN_API_KEY", "fixture-key")
    return Config.from_env()


def response(status=200, data=None):
    return SimpleNamespace(
        status_code=status,
        headers={"x-request-id": "fixture-request"},
        json=lambda: data if data is not None else {"data": [{"url": "https://result.invalid/image.png"}]},
    )




@pytest.fixture
def wire(monkeypatch):
    calls = []
    monkeypatch.setattr(providers.requests, "post", lambda url, **kw: calls.append((url, kw)) or response())
    monkeypatch.setattr(providers.requests, "get", lambda url, **kw: SimpleNamespace(
        content=image_bytes(), raise_for_status=lambda: None,
    ))
    return calls


def test_generate_downloads_into_existing_result_contract(config, wire, tmp_path):
    output = tmp_path / "asset.png"
    result = image_gen.generate_image(config, prompt="meteor", output=output, quality="high")
    assert result["size"] == "1024x1024"
    assert result["request_id"] == "fixture-request"
    assert result["provider_metadata"]["image_info"]["width"] == 960
    assert output.read_bytes() == image_bytes()
    url, kwargs = wire[0]
    assert url == "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations"
    assert kwargs["headers"]["Authorization"] == "Bearer fixture-key"
    assert kwargs["json"].keys() == {"model", "prompt", "size", "output_format", "response_format", "watermark"}
    assert kwargs["json"]["model"] == "doubao-seedream-5.0-pro"
    assert kwargs["json"]["output_format"] == "png"
    assert "meteor" in kwargs["json"]["prompt"]


@pytest.mark.parametrize("source", ["local", "https://example.invalid/ref.png", "data:image/png;base64,YQ=="])
def test_edit_uses_generation_json_for_each_reference_format(config, wire, tmp_path, source):
    if source == "local":
        path = tmp_path / "ref.webp"
        path.write_bytes(b"reference")
        source = str(path)
        expected = "data:image/webp;base64," + base64.b64encode(b"reference").decode()
    else:
        expected = source
    output = tmp_path / "edited.png"
    result = image_gen.edit_image(config, prompt="blue", input_path=source, output=output)
    assert result["request_id"] == "fixture-request"
    assert output.read_bytes() == image_bytes()
    url, kwargs = wire[0]
    assert url.endswith("/images/generations")
    assert kwargs["json"]["image"] == expected
    assert "files" not in kwargs
    assert "quality" not in kwargs["json"]


@pytest.mark.parametrize("name", ["ARK_AGENT_PLAN_API_KEY"])
def test_missing_seedream_credentials_blocks_before_http(config, wire, tmp_path, monkeypatch, name):
    monkeypatch.delenv(name)
    config.image = ImageGenConfig.from_env()
    with pytest.raises(ToolError, match=name):
        image_gen.generate_image(config, prompt="meteor", output=tmp_path / "out.png")
    assert wire == []


@pytest.mark.parametrize("status,code", [(401, "AUTH_FAILED"), (403, "AUTH_FAILED"), (400, "IMAGE_GEN_FAILED"), (500, "IMAGE_GEN_FAILED")])
def test_failed_submission_does_not_publish_or_repeat(config, monkeypatch, tmp_path, status, code):
    calls = []
    monkeypatch.setattr(providers.requests, "post", lambda *a, **k: calls.append(1) or response(status))
    output = tmp_path / "asset.png"
    with pytest.raises(ToolError) as exc:
        image_gen.generate_image(config, prompt="meteor", output=output)
    assert exc.value.code == code
    assert calls == [1]
    assert not output.exists()


def test_download_failure_does_not_resubmit_generation(config, monkeypatch, wire, tmp_path):
    def fail(*args, **kwargs):
        raise providers.requests.exceptions.Timeout("fixture")
    monkeypatch.setattr(providers.requests, "get", fail)
    with pytest.raises(ToolError, match="download failed"):
        image_gen.generate_image(config, prompt="meteor", output=tmp_path / "out.png")
    assert len(wire) == 1


def test_rate_limit_retry_is_bounded(config, wire, monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(providers.requests, "post", lambda *a, **k: calls.append(1) or response(429))
    with pytest.raises(ToolError):
        image_gen.generate_image(config, prompt="meteor", output=tmp_path / "out.png", max_retries=2, retry_delay=0)
    assert calls == [1, 1]


def test_seedream_size_preserves_wide_aspect_and_bounds_area(config):
    provider = providers.ProviderClient()
    assert provider.image_output_size(config, "1536x864") == "1536x864"
    w, h = map(int, provider.image_output_size(config, "3840x2160").split("x"))
    assert 921600 <= w * h <= 4624220
    assert abs(w / h - 16 / 9) < 0.01


def test_credentials_preflight_uses_selected_provider(config, monkeypatch):
    monkeypatch.setenv("ARK_AGENT_PLAN_API_KEY", "fixture-ark")
    ctx = SimpleNamespace(config=config)
    assert lifecycle._credentials_present(ctx)
    monkeypatch.delenv("ARK_AGENT_PLAN_API_KEY")
    assert not lifecycle._credentials_present(ctx)
    assert "ARK_AGENT_PLAN_API_KEY" in lifecycle._credentials_check(ctx)["message"]


def test_local_mcp_boots_with_missing_image_credentials(config, monkeypatch):
    for name in ("OPENAI_API_KEY", "ARK_AGENT_PLAN_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(cli, "load_dotenv", lambda: None)
    calls = []
    async def fake_server(**kwargs):
        calls.append(kwargs)
    monkeypatch.setattr(server, "run_stdio_server", fake_server)
    repo = Path(__file__).parents[4]
    assert cli.main(["--repo-root", str(repo)]) == 0
    assert len(calls) == 1


def test_openai_explicit_compatibility_remains_available(monkeypatch):
    for name in ("GAME_ASSET_PROVIDER", "GAME_ASSET_BASE_URL", "GAME_ASSET_MODEL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GAME_ASSET_PROVIDER", "openai")
    config = ImageGenConfig.from_env()
    assert config.provider == "openai"
    assert config.model_id == "gpt-image-2"
    assert config.credential_env_names == ("OPENAI_API_KEY",)


@pytest.mark.parametrize("data", [{"data": []}, {"data": [7]}, {"error": {"message": "fixture"}}, []])
def test_malformed_response_leaves_output_absent(config, monkeypatch, tmp_path, data):
    monkeypatch.setattr(providers.requests, "post", lambda *a, **k: response(data=data))
    output = tmp_path / "asset.png"
    with pytest.raises(ToolError) as exc:
        image_gen.generate_image(config, prompt="meteor", output=output)
    assert exc.value.code == "BAD_RESPONSE"
    assert not output.exists()


def test_seedream_small_canvas_is_adapted(config):
    assert providers.ProviderClient().image_output_size(config, "816x816") == "960x960"


def test_seedream_base64_result(config, monkeypatch, tmp_path):
    monkeypatch.setattr(providers.requests, "post", lambda *a, **k: response(data={
        "data": [{"b64_json": base64.b64encode(image_bytes()).decode()}],
        "model": "actual-backend", "usage": {"generated_images": 1},
    }))
    result = image_gen.generate_image(config, prompt="ship", output=tmp_path / "ship.png")
    assert result["provider_metadata"]["response_model"] == "actual-backend"
    assert result["provider_metadata"]["usage"] == {"generated_images": 1}


def test_plan_endpoint_rejects_ordinary_ark(config, wire, tmp_path):
    from dataclasses import replace
    config.image = replace(config.image, base_url="https://ark.cn-beijing.volces.com/api/v3")
    with pytest.raises(ToolError, match="approved Plan"):
        image_gen.generate_image(config, prompt="ship", output=tmp_path / "ship.png")
    assert wire == []


def test_plan_video_checkpoint_resumes_accepted_id(config, video_ledger, monkeypatch, tmp_path):
    import json

    from game_developing_agent_mcp.adapters import seedance
    calls = []
    monkeypatch.setattr(providers.requests, "post", lambda url, **kw: calls.append((url, kw)) or response(data={"id": "plan-task"}))
    polls = []
    def poll(*args, **kwargs):
        polls.append(kwargs["task_id"])
        if len(polls) == 1:
            raise ToolError("SEEDANCE_TIMEOUT", "fixture poll timeout")
        return {"status": "succeeded", "content": {"video_url": "https://result.invalid/clip.mp4"}, "usage": {"completion_tokens": 1600}}
    monkeypatch.setattr(seedance, "_poll_task", poll)
    output = tmp_path / "clip.mp4"
    args = {"prompt": "hover", "output": output, "first_frame": "data:image/png;base64,YQ==", "print_url_only": True,
            "seed": 17, "camerafixed": True, "extra_params": {"generate_audio": False}}
    with pytest.raises(ToolError, match="fixture poll timeout"):
        seedance.generate_video(config, **args)
    saved = json.loads(output.with_suffix(".mp4.task.json").read_text())
    assert saved["task_id"] == "plan-task"
    result = seedance.generate_video(config, **args)
    assert result["task_id"] == "plan-task"
    assert len(calls) == 1
    assert polls == ["plan-task", "plan-task"]
    assert calls[0][0] == "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks"
    payload = calls[0][1]["json"]
    assert payload["model"] == "doubao-seedance-2.0-fast"
    assert payload["duration"] == 4 and payload["resolution"] == "480p" and payload["ratio"] == "1:1"
    assert payload["generate_audio"] is False
    assert "seed" not in payload and "camera_fixed" not in payload
    assert "--seed" not in payload["content"][0]["text"]
    assert calls[0][1]["headers"]["Authorization"] == "Bearer fixture-key"
    assert len(video_ledger.status()["tasks"]) == 1


def test_plan_unknown_submission_retains_checkpoint(config, video_ledger, monkeypatch, tmp_path):
    from game_developing_agent_mcp.adapters import seedance
    calls = []
    def fail(*a, **k):
        calls.append(1)
        raise providers.requests.exceptions.Timeout("fixture submit")
    monkeypatch.setattr(providers.requests, "post", fail)
    args = {"prompt": "hover", "output": tmp_path / "clip.mp4", "print_url_only": True}
    with pytest.raises(ToolError):
        seedance.generate_video(config, **args)
    with pytest.raises(ToolError) as exc:
        seedance.generate_video(config, **args)
    assert exc.value.code == "SUBMISSION_UNKNOWN"
    assert calls == [1]
    state = video_ledger.status()
    assert len(state["tasks"]) == 1
    assert state["tasks"][0]["status"] == "unknown"


@pytest.mark.parametrize("tokens", [1200, 3400])
def test_seedance_records_final_usage(
    config, video_ledger, monkeypatch, tmp_path, tokens
):
    from game_developing_agent_mcp.adapters import seedance

    calls = []
    def submit(url, **kwargs):
        state = video_ledger.status()
        assert len(state["tasks"]) == 1
        calls.append((url, kwargs))
        return response(data={"id": "accepted-task"})

    monkeypatch.setattr(providers.requests, "post", submit)
    monkeypatch.setattr(seedance, "_poll_task", lambda *a, **k: {
        "status": "succeeded", "content": {"video_url": "https://result.invalid/video.mp4"},
        "usage": {"completion_tokens": tokens, "total_tokens": tokens},
    })
    result = seedance.generate_video(
        config, prompt="hover", output=tmp_path / "clip.mp4", print_url_only=True
    )
    assert len(calls) == 1 and result["task_id"] == "accepted-task"
    state = video_ledger.status()
    row = state["tasks"][0]
    assert row["usage"] == {"completion_tokens": tokens, "total_tokens": tokens}






def test_standalone_resume_queries_original_task_and_downloads(config, tmp_path, monkeypatch):
    import json

    from game_developing_agent_mcp.local.media_resume import resume_video_task
    from game_developing_agent_mcp.local.usage import UsageLedger
    checkpoint = tmp_path / "loop.mp4.task.json"
    checkpoint.write_text(json.dumps({"task_id": "accepted-task", "request_id": "request-original"}))
    calls = []
    class Video:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def raise_for_status(self):
            return None
        def iter_content(self, **kwargs):
            yield b"fixture-video"
    def get(url, **kwargs):
        calls.append(url)
        if url.endswith("/accepted-task"):
            return response(data={"status": "succeeded", "content": {"video_url": "https://result.invalid/loop.mp4"},
                                  "usage": {"completion_tokens": 1600}})
        return Video()
    monkeypatch.setattr(providers.requests, "post", lambda *a, **k: pytest.fail("Resume must preserve the accepted task"))
    monkeypatch.setattr(providers.requests, "get", get)
    result = resume_video_task(config, checkpoint)
    assert result["task_id"] == "accepted-task" and result["resumed"]
    assert (tmp_path / "loop.mp4").read_bytes() == b"fixture-video"
    assert calls == ["https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks/accepted-task",
                     "https://result.invalid/loop.mp4"]
    state = UsageLedger(tmp_path).status()
    assert state["tasks"][0]["usage"] == {"completion_tokens": 1600}
    resume_video_task(config, checkpoint)
    assert calls[-1] == "https://result.invalid/loop.mp4"
    assert len(calls) == 3 and len(UsageLedger(tmp_path).status()["tasks"]) == 1


def test_standalone_resume_unknown_submission_stops(config, tmp_path, monkeypatch):
    from game_developing_agent_mcp.local.media_resume import resume_video_task
    checkpoint = tmp_path / "loop.mp4.task.json"
    checkpoint.write_text('{"status":"submitting"}')
    monkeypatch.setattr(providers.requests, "post", lambda *a, **k: pytest.fail("Unknown submission cannot repeat"))
    monkeypatch.setattr(providers.requests, "get", lambda *a, **k: pytest.fail("No accepted ID to poll"))
    with pytest.raises(ToolError) as exc:
        resume_video_task(config, checkpoint)
    assert exc.value.code == "SUBMISSION_UNKNOWN"


@pytest.mark.parametrize("attempts", [0, -1, True, 1.5])
def test_invalid_image_attempt_count_precedes_tracking_and_http(config, wire, tmp_path, monkeypatch, attempts):
    def unexpected_reservation(*args, **kwargs):
        pytest.fail("invalid count must fail before task tracking")
    monkeypatch.setattr(image_gen, "_reserve_plan_media", unexpected_reservation)
    with pytest.raises(ToolError) as exc:
        image_gen.generate_image(config, prompt="ship", output=tmp_path / "ship.png", max_retries=attempts)
    assert exc.value.code == "INVALID_CONFIG"
    assert wire == []

@pytest.fixture
def video_ledger(config, monkeypatch, tmp_path):
    from game_developing_agent_mcp.adapters import seedance
    from game_developing_agent_mcp.local import media_usage
    from game_developing_agent_mcp.local.usage import UsageLedger
    monkeypatch.setattr(seedance, "_reserve_plan_media", media_usage.reserve_media)
    monkeypatch.delenv("GAME_DEVELOPING_AGENT_LOCAL_PROJECT", raising=False)
    return UsageLedger(tmp_path)


def test_image_adapter_records_usage(config, wire, tmp_path, monkeypatch):
    from game_developing_agent_mcp.local import media_usage
    from game_developing_agent_mcp.local.usage import UsageLedger
    monkeypatch.setattr(image_gen, "_reserve_plan_media", media_usage.reserve_media)
    monkeypatch.delenv("GAME_DEVELOPING_AGENT_LOCAL_PROJECT", raising=False)
    image_gen.generate_image(config, prompt="ship", output=tmp_path / "ship.png")
    state = UsageLedger(tmp_path).status()
    assert state["tasks"][0]["provider_task_id"] == "fixture-request"
    image_gen.generate_image(config, prompt="ship", output=tmp_path / "second.png")
    assert len(wire) == 2 and len(UsageLedger(tmp_path).status()["tasks"]) == 2
