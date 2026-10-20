# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Per-task HTTPS request tracking for Claude's fixed Ark Plan connection.

Claude receives an ephemeral credential. Only this local proxy holds the real
Plan key; it records requests and applies an optional caller-selected limit. The proxy
uses Claude's documented HTTPS_PROXY and NODE_EXTRA_CA_CERTS support, preserves
the configured Plan base URL, and verifies Ark's upstream TLS certificate.
"""
from __future__ import annotations

import http.client
import json
import secrets
import socketserver
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

HOST = "ark.cn-beijing.volces.com"
TRANSPORT_VERSION = "ark-plan-counted-https-v1"


class RequestTracker:
    def __init__(self, model: str, maximum: int | None, key: str, *, forward=None):
        if maximum is not None and (type(maximum) is not int or maximum < 1):
            raise ValueError("Request limit must be a positive integer or None")
        self.model, self.maximum, self.key = model, maximum, key
        self.token = secrets.token_urlsafe(32)
        self.records: list[dict] = []
        self.denied: list[str] = []
        self.lock = threading.Lock()
        self.closed = False
        self.slots = threading.BoundedSemaphore(2)
        self.forward = forward or self._forward

    def admit(self, path: str, headers, body: bytes) -> dict:
        if path.split("?")[0] not in {"/api/plan/v1/messages", "/api/plan/v1/messages/count_tokens"}:
            raise ValueError("Only Plan Messages requests are allowed")
        token = headers.get("Authorization", "").removeprefix("Bearer ")
        if token != self.token and headers.get("x-api-key") != self.token:
            raise ValueError("Task credential mismatch")
        payload = json.loads(body)
        if payload.get("model") != self.model:
            raise ValueError("Model differs from reserved route")
        if payload.get("harness") or any(t.get("type") not in (None, "custom") for t in payload.get("tools", [])):
            raise ValueError("Server-side tools/Harness require a supported transport integration")
        with self.lock:
            if self.closed or (self.maximum is not None and len(self.records) >= self.maximum):
                raise ValueError("Task HTTP request limit exhausted")
            record = {"request": len(self.records) + 1, "path": path,
                      "model": self.model, "body_bytes": len(body),
                      "max_tokens": payload.get("max_tokens"), "status": "submitted"}
            record["thinking"] = payload.get("thinking")
            self.records.append(record)
            return record

    def _forward(self, path, headers, body):
        connection = http.client.HTTPSConnection(HOST, timeout=180, context=ssl.create_default_context())
        forwarded = {k: v for k, v in headers.items() if k.lower() not in {
            "authorization", "x-api-key", "host", "connection", "proxy-connection", "content-length"}}
        forwarded.update(Authorization="Bearer " + self.key, Host=HOST, Connection="close")
        forwarded["Accept-Encoding"] = "identity"
        connection.request("POST", path, body=body, headers=forwarded)
        response = connection.getresponse()
        return connection, response

    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix="game_developing_agent-request-tracker-")
        folder = Path(self.directory.name)
        self.certificate = folder / "task-ca.pem"
        private = folder / "task-key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(private), "-out", str(self.certificate), "-days", "1",
                        "-subj", "/CN=" + HOST, "-addext", "subjectAltName=DNS:" + HOST],
                       check=True, capture_output=True)
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(self.certificate, private)
        self.tls.set_alpn_protocols(["http/1.1"])
        self.server = _Server(("127.0.0.1", 0), _Connect)
        self.server.owner = self
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def environment(self, original):
        env = dict(original)
        for name in ("ARK_AGENT_PLAN_API_KEY", "ANTHROPIC_API_KEY", "HTTP_PROXY", "HTTPS_PROXY",
                     "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"):
            env.pop(name, None)
        proxy = f"http://127.0.0.1:{self.server.server_address[1]}"
        env.update(HTTPS_PROXY=proxy, HTTP_PROXY=proxy, NO_PROXY="localhost,127.0.0.1",
                   NODE_EXTRA_CA_CERTS=str(self.certificate), ANTHROPIC_AUTH_TOKEN=self.token,
                   CLAUDE_CODE_GZIP_REQUEST_BODIES="0")
        return env

    def report(self):
        return {"transport": TRANSPORT_VERSION, "maximum_requests": self.maximum,
                "forwarded_requests": len(self.records),
                "records": self.records, "denied": self.denied,
                "credential_scope": "ephemeral Claude credential; real key only at fixed upstream forwarding boundary"}

    def __exit__(self, *_):
        with self.lock:
            self.closed = True
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class _Connect(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(240)
        line = self.rfile.readline(8192).decode("ascii", errors="replace").strip()
        if line != f"CONNECT {HOST}:443 HTTP/1.1":
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        for _ in range(100):
            if self.rfile.readline(8192) in (b"\r\n", b"\n", b""):
                break
        self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        self.wfile.flush()
        try:
            with self.server.owner.tls.wrap_socket(self.connection, server_side=True) as secured:
                _Messages(secured, self.client_address, self.server)
        except (OSError, ssl.SSLError):
            pass


class _Messages(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        owner = self.server.owner
        self.close_connection = True
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 32 * 1024 * 1024 or self.headers.get("Content-Encoding"):
                raise ValueError("Unsupported request size/encoding")
            body = self.rfile.read(size)
            record = owner.admit(self.path, self.headers, body)
        except (ValueError, KeyError, TypeError) as exc:
            owner.denied.append(str(exc))
            self.send_error(403, "Local request tracker rejected this request")
            return
        with owner.slots:
            connection = None
            try:
                connection, response = owner.forward(self.path, self.headers, body)
                record["http_status"] = response.status
                record["provider_request_id"] = response.getheader("X-Request-Id")
                self.send_response(response.status)
                self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
                self.send_header("Connection", "close")
                self.end_headers()
                captured = bytearray()
                while chunk := response.read1(8192):
                    captured.extend(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
                record["status"] = "response_complete"
                usages = []
                record["terminal_event_received"] = False
                for line in bytes(captured).decode(errors="replace").splitlines():
                    line = line.removeprefix("data: ")
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get("type") == "message_stop" or (
                        event.get("type") == "message" and event.get("stop_reason")
                    ):
                        record["terminal_event_received"] = True
                    usage = event.get("usage") or event.get("message", {}).get("usage")
                    if usage:
                        usages.append(usage)
                record["usage_events"] = usages
            except (OSError, http.client.HTTPException) as exc:
                record.update(status="outcome_unknown", error=type(exc).__name__)
            finally:
                if connection:
                    connection.close()
