# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from game_developing_agent_mcp.local import runtime
from game_developing_agent_mcp.local.request_tracker import TRANSPORT_VERSION

SCRIPTS = Path(__file__).parents[4] / "scripts"


def load_script(name):
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), SCRIPTS / (name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def probe_report():
    cases = []
    for model, kind, forwarded, maximum in [
        (runtime.FLASH, "sse", 1, 2),
        (runtime.FLASH, "json", 1, 1),
        (runtime.FLASH, "child", 3, 6),
        (runtime.VISION, "sse", 1, 2),
    ]:
        cases.append(
            {
                "model": model,
                "case": kind,
                "returncode": 1 if kind == "json" else 0,
                "transport": {
                    "transport": TRANSPORT_VERSION,
                    "forwarded_requests": forwarded,
                    "maximum_requests": maximum,
                    "records": [{"model": model}] * forwarded,
                    "denied": ["Task HTTP request limit exhausted"]
                    if kind == "json"
                    else [],
                },
                "upstream_calls": [{"model": model}] * forwarded,
                "stdout": json.dumps(
                    {"type": "assistant", "parent_tool_use_id": "child"}
                )
                if kind == "child"
                else "",
            }
        )
    return {
        "claude_version": "2.1.303 (Claude Code)",
        "network": "isolated Linux network namespace; loopback only",
        "generated_at_utc": "2026-10-20T00:00:00Z",
        "cases": cases,
    }


def test_runtime_setup_defaults_use_checkout_parent_without_delivery():
    configure = load_script("configure-counted-runtime")
    probe = load_script("probe-counted-runtime")
    root = SCRIPTS.parent
    assert (
        configure.parse_args([]).evidence
        == root / ".game_developing_agent/counted-runtime-probe.json"
    )
    assert configure.parse_args([]).output == root / ".game_developing_agent/runtime-bounds.json"
    assert probe.parse_args([]).output == root / ".game_developing_agent/counted-runtime-probe.json"
    assert probe.parse_args(["--output", "/tmp/custom.json"]).output == Path(
        "/tmp/custom.json"
    )
    events = probe.response_bytes(runtime.FLASH, tool="Task").decode()
    assert '"name": "Task"' in events


def test_configure_creates_portable_relative_evidence_and_runtime_consumes_it(
    tmp_path, monkeypatch
):
    configure = load_script("configure-counted-runtime")
    evidence = tmp_path / "evidence" / "probe.json"
    evidence.parent.mkdir()
    probe = probe_report()
    evidence.write_text(json.dumps(probe))
    output = tmp_path / "workspace/.game_developing_agent/runtime-bounds.json"
    record = configure.configure(
        evidence, output, installed_version=probe["claude_version"]
    )
    assert record["profiles"]["pipeline"]["maximum_requests"] is None
    for profile in record["profiles"].values():
        assert not Path(profile["evidence_path"]).is_absolute()
        assert (output.parent / profile["evidence_path"]).resolve() == evidence
    monkeypatch.setattr(
        runtime.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(stdout=probe["claude_version"]),
    )
    assert (
        runtime.runtime_bounds(output.parent.parent, "fixture-cli", "pipeline")
        == record["profiles"]["pipeline"]
    )
    assert (
        configure.configure(evidence, output, installed_version=probe["claude_version"])
        == record
    )


def test_verify_runtime_shell_defaults_reach_runtime_consumer(tmp_path, monkeypatch):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    shutil.copy2(SCRIPTS / "verify-runtime.sh", scripts / "verify-runtime.sh")
    # Exercise the real shell entry point while replacing its expensive probe.
    (scripts / "run.sh").write_text(
        'printf "%s\\n" "$@" >> "$(dirname "$0")/calls.txt"\n'
    )
    subprocess.run(["bash", str(scripts / "verify-runtime.sh")], check=True)
    args = (scripts / "calls.txt").read_text().splitlines()
    evidence = Path(args[3])
    output = Path(args[-1])
    evidence.parent.mkdir(parents=True)
    probe = probe_report()
    evidence.write_text(json.dumps(probe))
    load_script("configure-counted-runtime").configure(
        evidence, output, installed_version=probe["claude_version"]
    )
    monkeypatch.setattr(
        runtime.subprocess, "run",
        lambda *args, **kwargs: SimpleNamespace(stdout=probe["claude_version"]),
    )
    assert runtime.runtime_bounds(tmp_path, "fixture-cli", "pipeline")[
        "maximum_requests"
    ] is None


@pytest.mark.parametrize(
    "problem",
    [
        "version",
        "missing_case",
        "failed_sse",
        "fallback",
        "child",
        "route",
        "count",
        "network",
    ],
)
def test_invalid_probe_cannot_replace_existing_configuration(tmp_path, problem):
    configure = load_script("configure-counted-runtime")
    probe = probe_report()
    version = probe["claude_version"]
    if problem == "version":
        version = "another installed version"
    elif problem == "missing_case":
        probe["cases"].pop()
    elif problem == "failed_sse":
        probe["cases"][0]["returncode"] = 1
    elif problem == "fallback":
        probe["cases"][1]["transport"]["denied"] = []
    elif problem == "child":
        probe["cases"][2]["stdout"] = ""
    elif problem == "route":
        probe["cases"][0]["upstream_calls"][0]["model"] = runtime.VISION
    elif problem == "count":
        probe["cases"][0]["transport"]["forwarded_requests"] = 3
    else:
        probe["network"] = "external network"
    evidence, output = tmp_path / "probe.json", tmp_path / "bounds.json"
    evidence.write_text(json.dumps(probe))
    output.write_text("existing bounds")
    with pytest.raises(ValueError):
        configure.configure(evidence, output, installed_version=version)
    assert output.read_text() == "existing bounds"
