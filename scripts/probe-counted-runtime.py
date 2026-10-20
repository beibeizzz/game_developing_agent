# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Exercise installed Claude and its child behind the real counted HTTPS transport, offline."""

import argparse
import fcntl
import io
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from game_developing_agent_mcp.local.request_tracker import RequestTracker
from game_developing_agent_mcp.local.runtime import FLASH, VISION, claude_executable, process_environment


def response_bytes(model, *, tool=None, sse=True):
    content = (
        {
            "type": "tool_use",
            "id": "tool_probe_child",
            "name": tool,
            "input": {
                "subagent_type": "general-purpose",
                "description": "offline child route probe",
                "prompt": 'Return the JSON object {"child":true}.',
            },
        }
        if tool
        else {"type": "text", "text": '{"ok":true}'}
    )
    message = {
        "id": "msg_offline",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [content],
        "stop_reason": "tool_use" if tool else "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 100, "output_tokens": 20},
    }
    if not sse:
        return json.dumps(message).encode()
    events = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": dict(
                    message,
                    content=[],
                    stop_reason=None,
                    usage={"input_tokens": 100, "output_tokens": 0},
                ),
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": dict(
                    content, **({"input": {}} if tool else {"text": ""})
                ),
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": json.dumps(content["input"]),
                }
                if tool
                else {"type": "text_delta", "text": content["text"]},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None},
                "usage": {"output_tokens": 20},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    return "".join(
        f"event: {name}\ndata: {json.dumps(event)}\n\n" for name, event in events
    ).encode()


class Response(io.BytesIO):
    status = 200

    def __init__(self, data, kind):
        super().__init__(data)
        self.kind = kind

    def getheader(self, name, default=None):
        return self.kind if name.lower() == "content-type" else default


class Connection:
    def close(self):
        pass


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / ".game_developing_agent/counted-runtime-probe.json",
    )
    parser.add_argument("--isolated", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main():
    options = parse_args()
    if not options.isolated:
        os.execvp(
            "unshare",
            [
                "unshare",
                "--user",
                "--map-root-user",
                "--net",
                sys.executable,
                __file__,
                "--isolated",
                *sys.argv[1:],
            ],
        )
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
        fcntl.ioctl(control, 0x8914, struct.pack("16sh", b"lo", 0x1 | 0x8))
    output = options.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    executable = claude_executable()
    cases = []
    for model, kind, maximum in [
        (FLASH, "sse", 2),
        (FLASH, "json", 1),
        (FLASH, "child", 6),
        (VISION, "sse", 2),
    ]:
        calls = []

        def forward(path, headers, body, *, calls=calls, kind=kind, model=model):
            payload = json.loads(body)
            calls.append(
                {
                    "model": payload["model"],
                    "tools": [t["name"] for t in payload.get("tools", [])],
                }
            )
            use_child = kind == "child" and len(calls) == 1
            child_tool = next(
                (name for name in ("Task", "Agent") if name in calls[-1]["tools"]), None
            )
            if use_child and child_tool is None:
                raise ValueError("Installed CLI has no Task/Agent tool")
            sse = kind != "json"
            return Connection(), Response(
                response_bytes(model, tool=child_tool if use_child else None, sse=sse),
                "text/event-stream" if sse else "application/json",
            )

        with (
            tempfile.TemporaryDirectory(prefix="game_developing_agent-counted-probe-") as temp,
            RequestTracker(
                model, maximum, "offline-placeholder", forward=forward
            ) as guard,
        ):
            env = process_environment(
                model,
                {
                    "PATH": os.environ["PATH"],
                    "HOME": temp,
                    "LANG": "C.UTF-8",
                    "CLAUDE_CONFIG_DIR": temp,
                    "ARK_AGENT_PLAN_API_KEY": "offline-placeholder",
                },
            )
            env = guard.environment(env)
            args = [
                executable,
                "-p",
                "Perform the assigned task and return one JSON object.",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                model,
                "--max-turns",
                "4" if kind == "child" else "1",
                "--setting-sources",
                "",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--mcp-config",
                '{"mcpServers":{}}',
                "--tools",
                "Task,Agent" if kind == "child" else "",
                "--permission-mode",
                "dontAsk",
                "--system-prompt",
                "Follow the provided task. Use the available Task or Agent tool when requested. Return JSON.",
            ]
            if kind == "child":
                args += ["--allowedTools", "Task,Agent"]
            result = subprocess.run(
                args,
                env=env,
                cwd=temp,
                text=True,
                capture_output=True,
                timeout=90,
                check=False,
            )
            case = {
                "model": model,
                "case": kind,
                "returncode": result.returncode,
                "transport": guard.report(),
                "upstream_calls": calls,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
            cases.append(case)
            print(
                json.dumps(
                    {
                        "case": kind,
                        "model": model,
                        "returncode": result.returncode,
                        "calls": len(calls),
                        "denied": guard.denied,
                    }
                ),
                flush=True,
            )
    version = subprocess.run(
        [executable, "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()
    report = {
        "claude_version": version,
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "network": "isolated Linux network namespace; loopback only",
        "cases": cases,
    }
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": "probe_complete",
                "evidence": str(output),
                "claude_version": version,
            }
        )
    )


if __name__ == "__main__":
    main()
