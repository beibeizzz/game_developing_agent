# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from game_developing_agent_mcp.local.request_tracker import HOST, RequestTracker


def test_retries_and_children_share_atomic_limit():
    guard = RequestTracker('deepseek-v4.1-flash', 3, 'real-key-fixture')
    headers = {'Authorization': 'Bearer ' + guard.token}
    body = json.dumps({'model': guard.model, 'max_tokens': 2500}).encode()
    def attempt(_):
        try:
            guard.admit('/api/plan/v1/messages?beta=true', headers, body)
            return True
        except ValueError:
            return False
    with ThreadPoolExecutor(max_workers=8) as workers:
        assert sum(workers.map(attempt, range(20))) == 3
    assert len(guard.records) == 3


def test_wrong_route_model_and_credential_cannot_use_allowance():
    guard = RequestTracker('doubao-seed-2.1-pro', 2, 'real-key-fixture')
    headers = {'Authorization': 'Bearer ' + guard.token}
    body = json.dumps({'model': guard.model}).encode()
    for path, auth, payload in [('/api/v3/chat/completions', headers, body),
                                ('/api/plan/v1/messages', {'Authorization': 'Bearer wrong'}, body),
                                ('/api/plan/v1/messages', headers, b'{"model":"other"}')]:
        with pytest.raises(ValueError):
            guard.admit(path, auth, payload)
    assert guard.records == []


def test_real_key_stays_at_verified_fixed_upstream_boundary(monkeypatch):
    captured = {}
    class Connection:
        def __init__(self, host, **kwargs):
            captured['host'] = host
            assert kwargs['context'].check_hostname
        def request(self, method, path, **kwargs):
            captured.update(method=method, path=path, **kwargs)
        def getresponse(self):
            return object()
    monkeypatch.setattr('http.client.HTTPSConnection', Connection)
    guard = RequestTracker('deepseek-v4.1-flash', 2, 'real-key-fixture')
    guard._forward('/api/plan/v1/messages', {'Authorization': 'Bearer ephemeral', 'x-api-key': 'ephemeral'}, b'{}')
    assert captured['host'] == HOST
    assert captured['headers']['Authorization'] == 'Bearer real-key-fixture'
    assert 'x-api-key' not in captured['headers']
    with guard:
        env = guard.environment({'ARK_AGENT_PLAN_API_KEY': 'real-key-fixture', 'https_proxy': 'http://foreign',
                                 'ANTHROPIC_BASE_URL': 'https://' + HOST + '/api/plan'})
        assert 'real-key-fixture' not in json.dumps(env)
        assert env['ANTHROPIC_AUTH_TOKEN'] == guard.token
        assert env['HTTPS_PROXY'].startswith('http://127.0.0.1:')
        assert 'https_proxy' not in env


def test_tracking_without_optional_limit_records_every_request():
    tracker = RequestTracker("deepseek-v4.1-flash", None, "fixture-key")
    headers = {"Authorization": "Bearer " + tracker.token}
    body = json.dumps({"model": tracker.model}).encode()
    for _ in range(60):
        tracker.admit("/api/plan/v1/messages", headers, body)
    assert tracker.report()["forwarded_requests"] == 60
    assert tracker.report()["maximum_requests"] is None
