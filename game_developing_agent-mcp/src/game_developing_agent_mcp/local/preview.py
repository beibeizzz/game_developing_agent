# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Loopback static preview and bounded local gameplay event intake."""

from __future__ import annotations

import functools
import json
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

EVENTS = {"enter", "pause", "resume", "collision", "end", "crash"}
ID = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")


def validate_event(row: dict, spec: dict) -> None:
    if not isinstance(row, dict) or row.get("project_id") != spec["project_id"]:
        raise ValueError("Unknown project")
    if row.get("event") not in EVENTS or row.get("difficulty") not in {
        "easy",
        "normal",
        "hard",
    }:
        raise ValueError("Invalid event or difficulty")
    for key in ("run_id", "play_session_id"):
        if not isinstance(row.get(key), str) or not ID.fullmatch(row[key]):
            raise ValueError("Invalid session ID")
    if row["run_id"] != spec["run_id"]:
        raise ValueError("Stale production run")
    if row.get("seed") not in spec["level_factory"]["seeds"]:
        raise ValueError("Unknown seed")
    for key in ("elapsed_active_ms", "elapsed_wall_ms"):
        value = row.get(key)
        if type(value) not in (int, float) or not 0 <= value <= 7 * 86400000:
            raise ValueError("Invalid elapsed time")
    if row["elapsed_active_ms"] > row["elapsed_wall_ms"] + 1000:
        raise ValueError("Active time exceeds wall time")
    for key, value in spec["revisions"].items():
        if row.get(key) != value:
            raise ValueError("Stale game revision")
    if row["event"] == "end" and row.get("outcome") not in {
        "win",
        "loss",
        "quit",
        "restart",
    }:
        raise ValueError("Invalid outcome")


class Preview(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, project: Path, port: int = 0, source: str = "human"):
        self.project = project
        self.spec = json.loads((project / "game-spec.json").read_text())
        self.source = source
        self.write_lock = threading.Lock()
        super().__init__(
            ("127.0.0.1", port),
            functools.partial(Handler, directory=str(project / "dist")),
        )

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_port}/?game_developing_agent_telemetry=1"


class Handler(SimpleHTTPRequestHandler):
    server: Preview

    def log_message(self, *_):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/.playtest/"):
            # Runtime receipts are the only internal artifact browsers may read.
            candidate = (self.server.project / path.lstrip("/")).resolve()
            allowed = (
                self.server.project / ".playtest" / "verify" / "runtime"
            ).resolve()
            if (
                candidate.is_relative_to(allowed)
                and candidate.is_file()
                and candidate.suffix == ".json"
            ):
                payload = candidate.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/__game_developing_agent/events":
            self.send_error(404)
            return
        origin = self.headers.get("Origin")
        host = self.headers.get("Host")
        if origin != f"http://{host}" or host not in {
            f"127.0.0.1:{self.server.server_port}",
            f"localhost:{self.server.server_port}",
        }:
            self.send_error(403)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 8192:
                raise ValueError("Invalid event size")
            row = json.loads(self.rfile.read(size))
            validate_event(row, self.server.spec)
            row["evidence_source"] = self.server.source
            folder = self.server.project / ".playtest" / "telemetry" / row["run_id"]
            folder.mkdir(parents=True, exist_ok=True)
            with (
                self.server.write_lock,
                (folder / f"{row['play_session_id']}.jsonl").open(
                    "a", encoding="utf-8"
                ) as out,
            ):
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
        except (ValueError, TypeError, KeyError):
            self.send_error(400)
            return
        self.send_response(204)
        self.end_headers()


def aggregate(project: Path, *, source: str = "human") -> dict:
    groups: dict[str, dict] = {}
    for path in (project / ".playtest" / "telemetry").glob("*/*.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("evidence_source") != source:
                continue
            version = {
                key: row[key]
                for key in ("spec_rev", "game_rev", "asset_rev", "level_rev")
            }
            key = json.dumps([row["difficulty"], row["seed"], version], sort_keys=True)
            group = groups.setdefault(
                key,
                {
                    "difficulty": row["difficulty"],
                    "seed": row["seed"],
                    "revisions": version,
                    "sessions": 0,
                    "wins": 0,
                    "losses": 0,
                    "damage_events": 0,
                    "active_ms": 0,
                    "wall_ms": 0,
                },
            )
            if row["event"] == "enter":
                group["sessions"] += 1
            if row["event"] == "collision" and row.get("damage_applied"):
                group["damage_events"] += 1
            if row["event"] == "end":
                group["wins"] += int(row["outcome"] == "win")
                group["losses"] += int(row["outcome"] == "loss")
                group["active_ms"] += row["elapsed_active_ms"]
                group["wall_ms"] += row["elapsed_wall_ms"]
    return {"evidence_source": source, "groups": list(groups.values())}
