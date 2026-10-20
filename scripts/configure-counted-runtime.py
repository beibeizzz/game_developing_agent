# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Configure installed-CLI request profiles from a successful local isolated probe."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

from game_developing_agent_mcp.local.request_tracker import TRANSPORT_VERSION
from game_developing_agent_mcp.local.runtime import FLASH, VISION, claude_executable

ROOT = Path(__file__).resolve().parents[1]


def validate_probe(probe: dict, installed_version: str) -> None:
    if not installed_version or probe.get("claude_version") != installed_version:
        raise ValueError("Probe must match the currently installed Claude version")
    if probe.get("network") != "isolated Linux network namespace; loopback only":
        raise ValueError("Probe requires the isolated loopback-only network")
    cases = probe.get("cases", [])
    required = {(FLASH, "sse"), (FLASH, "json"), (FLASH, "child"), (VISION, "sse")}
    if len(cases) != 4 or {(c.get("model"), c.get("case")) for c in cases} != required:
        raise ValueError("Probe requires Flash SSE/fallback/child and Seed SSE cases")
    for case in cases:
        transport = case.get("transport", {})
        forwarded = transport.get("forwarded_requests")
        maximum = transport.get("maximum_requests")
        records = transport.get("records", [])
        calls = case.get("upstream_calls", [])
        if (
            transport.get("transport") != TRANSPORT_VERSION
            or type(forwarded) is not int
            or type(maximum) is not int
            or not 1 <= forwarded <= maximum
            or len(records) != forwarded
            or len(calls) != forwarded
            or any(r.get("model") != case["model"] for r in [*records, *calls])
        ):
            raise ValueError("Probe request counters and model routes must match")
        if case["case"] == "json":
            if maximum != 1 or forwarded != 1 or not transport.get("denied"):
                raise ValueError(
                    "Fallback probe must demonstrate denial after one request"
                )
        elif case.get("returncode") != 0:
            raise ValueError("SSE and child probes must complete successfully")
        if case["case"] == "child":
            events = [
                json.loads(line)
                for line in case.get("stdout", "").splitlines()
                if line.strip()
            ]
            if forwarded < 3 or not any(
                event.get("parent_tool_use_id") for event in events
            ):
                raise ValueError(
                    "Child probe must show a real joined child sharing the transport"
                )


def configure(evidence: Path, output: Path, *, installed_version: str, maximum_requests: int | None = None) -> dict:
    evidence, output = evidence.expanduser().resolve(), output.expanduser().resolve()
    probe = json.loads(evidence.read_text(encoding="utf-8"))
    validate_probe(probe, installed_version)
    evidence_path = os.path.relpath(evidence, output.parent)
    if maximum_requests is not None and (type(maximum_requests) is not int or maximum_requests < 1):
        raise ValueError("maximum_requests must be a positive integer or None")
    profiles = {}
    for name, turns, tokens, size, images in [
        ("pipeline", 20, 16000, 40000, 0),
        ("review", 1, 12000, 40000, 0),
        ("vision", 1, 12000, 40000, 6),
        ("smoke", 5, 1500, 8000, 0),
    ]:
        profiles[name] = {
            "verified": True,
            "transport": TRANSPORT_VERSION,
            "maximum_requests": maximum_requests,
            "max_turns": turns,
            "max_output_tokens": tokens,
            "max_prompt_bytes": size,
            "max_images": images,
            "evidence_path": evidence_path,
        }
    record = {
        "claude_version": probe["claude_version"],
        "profiles": profiles,
        "probe_generated_at_utc": probe.get("generated_at_utc"),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--evidence", type=Path, default=ROOT / ".game_developing_agent/counted-runtime-probe.json"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / ".game_developing_agent/runtime-bounds.json"
    )
    parser.add_argument("--maximum-requests", type=int, help="Optional per-task HTTP request limit")
    return parser.parse_args(argv)


def main():
    args = parse_args()
    executable = claude_executable()
    version = subprocess.run(
        [executable, "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()
    record = configure(args.evidence, args.output, installed_version=version, maximum_requests=args.maximum_requests)
    print(
        json.dumps(
            {
                "status": "configured",
                "claude_version": record["claude_version"],
                "profiles": list(record["profiles"]),
                "output": str(args.output.resolve()),
            }
        )
    )


if __name__ == "__main__":
    main()
