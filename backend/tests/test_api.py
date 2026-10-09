"""End-to-end tests through the real ASGI app, against a scripted upstream."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import OPENAI_STREAM, openai_chat

MASTER = "sk-proxy-testmasterkey0000000000000000"
AUTH = {"x-api-key": MASTER}
BODY = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}


@pytest.fixture
def client(isolated_state):
    import asyncio

    asyncio.get_event_loop().run_until_complete(isolated_state.start())
    with TestClient(app) as test_client:
        yield test_client


# ── auth ───────────────────────────────────────────────────────────────────
class TestAuth:
    def test_rejects_missing_key(self, client):
        assert client.post("/v1/chat/completions", json=BODY).status_code == 401

    def test_rejects_wrong_key(self, client):
        r = client.post("/v1/chat/completions", json=BODY, headers={"x-api-key": "nope"})
        assert r.status_code == 401
        assert r.json()["error"]["code"] == "invalid_api_key"

    def test_accepts_authorization_bearer(self, client, upstream, isolated_state):
        """The OpenAI SDK sends `Authorization: Bearer` — v2 rejected it."""
        import asyncio
        from tests.conftest import make_account
        asyncio.get_event_loop().run_until_complete(make_account(isolated_state))
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        r = client.post("/v1/chat/completions", json=BODY,
                        headers={"Authorization": f"Bearer {MASTER}"})
        assert r.status_code == 200

    def test_error_envelope_shape(self, client):
        body = client.post("/v1/chat/completions", json=BODY,
                           headers={"x-api-key": "bad"}).json()
        assert set(body) == {"error"}
        assert {"message", "type", "code", "request_id"} <= set(body["error"])

    def test_non_admin_key_is_blocked_from_admin(self, client, isolated_state):
        import asyncio
        record = asyncio.get_event_loop().run_until_complete(
            isolated_state.create_key("worker"))
        r = client.get("/admin/stats", headers={"x-api-key": record.key})
        assert r.status_code == 403


# ── chat completions ───────────────────────────────────────────────────────
class TestChatCompletions:
    @pytest.mark.asyncio
    async def _setup(self, registry, **kwargs):
        from tests.conftest import make_account
        return await make_account(registry, **kwargs)

    def test_happy_path(self, client, upstream, isolated_state):
        import asyncio
        asyncio.get_event_loop().run_until_complete(self._setup(isolated_state))
        upstream.add("POST", "/v1/chat/completions", body=openai_chat("pong"))

        r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        assert r.status_code == 200
        assert r.json()["choices"][0]["message"]["content"] == "pong"
        assert r.headers["x-aiproxy-account"] == "test-openai"
        assert r.headers["x-aiproxy-cache"] == "MISS"

    def test_no_accounts_is_503(self, client):
        r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        assert r.status_code == 503
        assert r.json()["error"]["code"] == "no_healthy_accounts"

    def test_model_not_served_is_503(self, client, upstream, isolated_state):
        import asyncio
        asyncio.get_event_loop().run_until_complete(self._setup(isolated_state))
        r = client.post("/v1/chat/completions",
                        json={**BODY, "model": "gpt-9"}, headers=AUTH)
        assert r.status_code == 503

    def test_failover_retries_a_second_account(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(
            isolated_state, name="bad", priority=1))
        loop.run_until_complete(make_account(
            isolated_state, name="good", priority=2, base_url="https://good.local/v1"))

        # only the priority-1 account is broken; the backup must serve the request
        upstream.add("POST", "/v1/chat/completions", status=500,
                     body={"error": {"message": "boom"}}, host="api.test.local")
        upstream.add("POST", "/v1/chat/completions", body=openai_chat("pong"),
                     host="good.local")

        r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        assert r.status_code == 200, r.text
        assert r.json()["choices"][0]["message"]["content"] == "pong"
        assert int(r.headers["x-aiproxy-attempts"]) >= 2

    def test_401_from_upstream_is_not_retried(self, client, upstream, isolated_state):
        import asyncio
        loop = asyncio.get_event_loop()
        loop.run_until_complete(self._setup(isolated_state))
        loop.run_until_complete(self._setup(isolated_state, name="second",
                                            base_url="https://two.local/v1"))
        upstream.add("POST", "/v1/chat/completions", status=401,
                     body={"error": {"message": "bad key"}})

        r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        assert r.status_code == 401
        assert len(upstream.requests) == 1     # not blindly retried

    def test_all_upstreams_down_is_502(self, client, upstream, isolated_state):
        import asyncio
        asyncio.get_event_loop().run_until_complete(self._setup(isolated_state))
        upstream.add("POST", "/v1/chat/completions", status=500,
                     body={"error": {"message": "boom"}})
        r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        assert r.status_code == 500
        assert r.json()["error"]["type"] == "upstream_error"


# ── cache ──────────────────────────────────────────────────────────────────
class TestCacheBehaviour:
    def _setup(self, registry):
        import asyncio
        from tests.conftest import make_account
        asyncio.get_event_loop().run_until_complete(make_account(registry))

    def test_deterministic_request_is_cached(self, client, upstream, isolated_state):
        self._setup(isolated_state)
        upstream.add("POST", "/v1/chat/completions", body=openai_chat("cached!"))
        payload = {**BODY, "temperature": 0}

        first = client.post("/v1/chat/completions", json=payload, headers=AUTH)
        second = client.post("/v1/chat/completions", json=payload, headers=AUTH)
        assert first.headers["x-aiproxy-cache"] == "MISS"
        assert second.headers["x-aiproxy-cache"] == "HIT"
        assert len(upstream.requests) == 1

    def test_temperature_change_is_a_different_key(self, client, upstream, isolated_state):
        """The v2 bug: a temperature=1 request served a temperature=0 cache entry."""
        self._setup(isolated_state)
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        client.post("/v1/chat/completions", json={**BODY, "temperature": 0}, headers=AUTH)
        client.post("/v1/chat/completions", json={**BODY, "temperature": 1}, headers=AUTH)
        assert len(upstream.requests) == 2

    def test_nondeterministic_is_not_stored(self, client, upstream, isolated_state):
        self._setup(isolated_state)
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        client.post("/v1/chat/completions", json={**BODY, "temperature": 0.9}, headers=AUTH)
        client.post("/v1/chat/completions", json={**BODY, "temperature": 0.9}, headers=AUTH)
        assert len(upstream.requests) == 2

    def test_no_cache_header_bypasses(self, client, upstream, isolated_state):
        self._setup(isolated_state)
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        payload = {**BODY, "temperature": 0}
        client.post("/v1/chat/completions", json=payload,
                    headers={**AUTH, "x-aiproxy-no-cache": "1"})
        r = client.post("/v1/chat/completions", json=payload, headers=AUTH)
        assert r.headers["x-aiproxy-cache"] == "MISS"


# ── streaming ──────────────────────────────────────────────────────────────
class TestStreaming:
    def test_stream_passthrough(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        asyncio.get_event_loop().run_until_complete(make_account(isolated_state))
        upstream.add("POST", "/v1/chat/completions", raw=OPENAI_STREAM)

        with client.stream("POST", "/v1/chat/completions",
                           json={**BODY, "stream": True}, headers=AUTH) as response:
            assert response.status_code == 200
            text = "".join(response.iter_text())

        assert text.count("data: ") >= 4
        assert text.rstrip().endswith("data: [DONE]")
        assert '"content":"He"' in text
        assert '"finish_reason":"stop"' in text

    def test_anthropic_stream_is_translated_to_openai(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(
            isolated_state, name="claude", provider_type="anthropic",
            base_url="https://api.anthropic.test/v1",
            models=["claude-sonnet-4-20250514"]))

        raw = b"".join([
            b'event: message_start\ndata: {"type":"message_start","message":'
            b'{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":'
            b'{"input_tokens":11,"output_tokens":1}}}\n\n',
            b'event: content_block_start\ndata: {"type":"content_block_start","index":0,'
            b'"content_block":{"type":"text","text":""}}\n\n',
            b'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,'
            b'"delta":{"type":"text_delta","text":"Hi there"}}\n\n',
            b'event: message_delta\ndata: {"type":"message_delta","delta":'
            b'{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
            b'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ])
        upstream.add("POST", "/v1/messages", raw=raw)

        with client.stream("POST", "/v1/chat/completions", json={
            **BODY, "model": "claude-sonnet-4-20250514", "stream": True,
        }, headers=AUTH) as response:
            assert response.status_code == 200
            text = "".join(response.iter_text())

        payloads = [
            json.loads(line[5:].strip())
            for line in text.splitlines()
            if line.startswith("data:") and "[DONE]" not in line
        ]
        assert all(p["object"] == "chat.completion.chunk" for p in payloads)
        content = "".join(
            p["choices"][0]["delta"].get("content", "")
            for p in payloads if p["choices"]
        )
        assert content == "Hi there"
        assert payloads[-1]["choices"][0]["finish_reason"] == "stop"
        # the request really was translated to the Anthropic Messages API
        sent = upstream.json_bodies()[0]
        assert "max_tokens" in sent and "messages" in sent


# ── translation through the full stack ─────────────────────────────────────
class TestProviderTranslation:
    def test_anthropic_non_streaming(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(
            isolated_state, name="claude", provider_type="anthropic",
            base_url="https://api.anthropic.test/v1",
            models=["claude-sonnet-4-20250514"]))
        upstream.add("POST", "/v1/messages", body={
            "id": "msg_9", "model": "claude-sonnet-4-20250514", "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "from claude"}],
            "usage": {"input_tokens": 9, "output_tokens": 3},
        })

        r = client.post("/v1/chat/completions", json={
            "model": "claude-sonnet-4-20250514",
            "messages": [{"role": "user", "content": "hi"}]}, headers=AUTH)
        assert r.status_code == 200
        payload = r.json()
        assert payload["object"] == "chat.completion"
        assert payload["choices"][0]["message"]["content"] == "from claude"
        assert payload["usage"]["total_tokens"] == 12
        assert upstream.json_bodies()[0]["max_tokens"] > 0

    def test_google_non_streaming(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        asyncio.get_event_loop().run_until_complete(make_account(
            isolated_state, name="gemini", provider_type="google",
            base_url="https://gemini.test/v1beta", models=["gemini-2.5-flash"]))
        upstream.add("POST", "/v1beta/models/gemini-2.5-flash:generateContent", body={
            "candidates": [{"content": {"parts": [{"text": "from gemini"}]},
                            "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 2,
                              "totalTokenCount": 6},
        })

        r = client.post("/v1/chat/completions", json={
            "model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "hi"}]},
            headers=AUTH)
        assert r.status_code == 200
        assert r.json()["choices"][0]["message"]["content"] == "from gemini"
        sent = upstream.json_bodies()[0]
        assert "contents" in sent and sent["contents"][0]["parts"][0]["text"] == "hi"
        # the key must not be in the URL
        assert "key=" not in upstream.requests[0].url.query.decode()

    def test_google_embeddings(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        asyncio.get_event_loop().run_until_complete(make_account(
            isolated_state, name="gemini", provider_type="google",
            base_url="https://gemini.test/v1beta", models=["text-embedding-004"]))
        upstream.add("POST", "/v1beta/models/text-embedding-004:embedContent",
                     body={"embedding": {"values": [0.1, 0.2, 0.3]}})

        r = client.post("/v1/embeddings",
                        json={"model": "text-embedding-004", "input": "hello"},
                        headers=AUTH)
        assert r.status_code == 200
        assert r.json()["data"][0]["embedding"] == [0.1, 0.2, 0.3]


# ── aliases / fallback chains ──────────────────────────────────────────────
class TestAliases:
    def test_fallback_chain_is_ordered(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(isolated_state, name="primary",
                                             models=["gpt-4o"]))
        loop.run_until_complete(make_account(isolated_state, name="backup",
                                             models=["gpt-4o-mini"],
                                             base_url="https://backup.local/v1"))
        loop.run_until_complete(
            isolated_state.set_alias("smart", ["gpt-4o", "gpt-4o-mini"]))

        # the first link in the chain is broken, so the router must fall through
        upstream.add("POST", "/v1/chat/completions", status=503,
                     body={"error": {"message": "unavailable"}}, host="api.test.local")
        upstream.add("POST", "/v1/chat/completions",
                     body=openai_chat("fallback used", model="gpt-4o-mini"),
                     host="backup.local")
        r = client.post("/v1/chat/completions", json={**BODY, "model": "smart"},
                        headers=AUTH)
        assert r.status_code == 200
        assert r.json()["model"] == "gpt-4o-mini"

    def test_alias_appears_in_models(self, client, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(isolated_state))
        loop.run_until_complete(isolated_state.set_alias("smart", ["gpt-4o"]))
        ids = [m["id"] for m in client.get("/v1/models", headers=AUTH).json()["data"]]
        assert "smart" in ids and "gpt-4o" in ids


# ── session affinity ───────────────────────────────────────────────────────
class TestSessionAffinity:
    def test_session_pins_to_one_account(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(isolated_state, name="a", priority=1))
        loop.run_until_complete(make_account(isolated_state, name="b", priority=2))
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())

        headers = {**AUTH, "x-session-id": "conversation-42"}
        first = client.post("/v1/chat/completions", json=BODY, headers=headers)
        second = client.post("/v1/chat/completions", json=BODY, headers=headers)
        assert first.headers["x-aiproxy-account"] == second.headers["x-aiproxy-account"]


# ── system + admin ─────────────────────────────────────────────────────────
class TestSystem:
    def test_health(self, client):
        body = client.get("/health").json()
        assert body["status"] in ("ok", "degraded")
        assert "accounts" in body and "uptime_s" in body

    def test_ready_without_accounts_is_503(self, client):
        assert client.get("/ready").status_code == 503

    def test_metrics_is_prometheus_text(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        asyncio.get_event_loop().run_until_complete(make_account(isolated_state))
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        client.post("/v1/chat/completions", json=BODY, headers=AUTH)

        text = client.get("/metrics").text
        assert "aiproxy_requests_total" in text
        assert "aiproxy_request_latency_seconds_bucket" in text
        assert "# TYPE aiproxy_requests_total counter" in text


class TestAdmin:
    def _setup(self, registry):
        import asyncio
        from tests.conftest import make_account
        return asyncio.get_event_loop().run_until_complete(make_account(registry))

    def test_account_crud(self, client, isolated_state):
        created = client.post("/admin/accounts", headers=AUTH, json={
            "name": "acme", "provider_type": "openai",
            "base_url": "https://acme.test/v1", "api_key": "sk-super-secret-1234",
            "models": ["gpt-4o"]})
        assert created.status_code == 201
        assert created.json()["api_key_masked"] != "sk-super-secret-1234"
        assert "sk-super-secret-1234" not in created.text

        assert client.get("/admin/accounts", headers=AUTH).json()["accounts"][0]["name"] == "acme"

        updated = client.put("/admin/accounts/acme", headers=AUTH,
                             json={"weight": 7, "location": "EU"})
        assert updated.status_code == 200
        assert updated.json()["weight"] == 7
        assert updated.json()["location"] == "EU"

        assert client.delete("/admin/accounts/acme", headers=AUTH).status_code == 200
        assert client.get("/admin/accounts", headers=AUTH).json()["accounts"] == []

    def test_duplicate_account_is_409(self, client, isolated_state):
        self._setup(isolated_state)
        r = client.post("/admin/accounts", headers=AUTH,
                        json={"name": "test-openai", "api_key": "x"})
        assert r.status_code == 409

    def test_patch_keeps_secret_when_omitted(self, client, isolated_state):
        account = self._setup(isolated_state)
        assert account.api_key == "sk-upstream-0001"
        client.put("/admin/accounts/test-openai", headers=AUTH, json={"weight": 3})
        assert isolated_state.get("test-openai").api_key == "sk-upstream-0001"

    def test_stats_and_usage(self, client, upstream, isolated_state):
        self._setup(isolated_state)
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        client.post("/v1/chat/completions", json=BODY, headers=AUTH)

        stats = client.get("/admin/stats", headers=AUTH).json()
        assert stats["totals"]["requests"] == 1

        logs = client.get("/admin/logs", headers=AUTH).json()
        assert len(logs["logs"]) == 1
        entry = logs["logs"][0]
        assert entry["model"] == "gpt-4o" and entry["account"] == "test-openai"
        assert entry["cost_usd"] > 0

        usage = client.get("/admin/usage", headers=AUTH).json()
        assert usage["totals"]["requests"] >= 1

    def test_log_filters(self, client, upstream, isolated_state):
        self._setup(isolated_state)
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        assert client.get("/admin/logs?account=test-openai", headers=AUTH).json()["total"] == 1
        assert client.get("/admin/logs?account=nope", headers=AUTH).json()["total"] == 0

    def test_alias_admin(self, client):
        r = client.put("/admin/aliases/fast", headers=AUTH,
                       json={"targets": ["gpt-4o-mini", "gpt-4o"]})
        assert r.status_code == 200
        assert client.get("/admin/aliases", headers=AUTH).json()["aliases"]["fast"]["targets"]
        assert client.delete("/admin/aliases/fast", headers=AUTH).status_code == 200

    def test_key_lifecycle(self, client):
        created = client.post("/admin/keys", headers=AUTH,
                              json={"name": "laptop", "daily_usd": 1.0, "rpm": 30})
        assert created.status_code == 201
        key = created.json()["key"]

        # the full key is returned exactly once
        listed = client.get("/admin/keys", headers=AUTH).json()["keys"]
        assert "key" not in listed[0] and listed[0]["key_masked"]

        assert client.get("/v1/models", headers={"x-api-key": key}).status_code == 200
        assert client.get("/v1/models", headers={"x-api-key": key + "x"}).status_code == 401

    def test_routing_update(self, client):
        r = client.put("/admin/routing", headers=AUTH, json={"strategy": "least_latency"})
        assert r.json()["strategy"] == "least_latency"
        bad = client.put("/admin/routing", headers=AUTH, json={"strategy": "nope"})
        assert bad.status_code == 422

    def test_budget_config(self, client):
        r = client.put("/admin/budget", headers=AUTH, json={"daily_usd": 5.0})
        assert r.json()["daily_usd"] == 5.0
        assert client.get("/admin/budget", headers=AUTH).json()["global"]["daily_usd"] == 5.0

    def test_cache_admin(self, client):
        assert client.get("/admin/cache", headers=AUTH).json()["enabled"] is True
        assert client.delete("/admin/cache", headers=AUTH).status_code == 200

    def test_export_csv(self, client, upstream, isolated_state):
        self._setup(isolated_state)
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        text = client.get("/admin/export.csv", headers=AUTH).text
        assert "time,method,path" in text and "gpt-4o" in text

    def test_config_masks_master_key(self, client):
        body = client.get("/admin/config", headers=AUTH).json()
        assert MASTER not in json.dumps(body)
        assert body["encryption"] in ("fernet", "xor", "plaintext")


# ── budget enforcement ─────────────────────────────────────────────────────
class TestBudget:
    def test_global_budget_blocks(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(isolated_state))
        upstream.add("POST", "/v1/chat/completions", body=openai_chat())
        client.put("/admin/budget", headers=AUTH, json={"daily_usd": 0.0000001})

        r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        # first call spends, second is refused
        client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        assert r.status_code == 429
        assert r.json()["error"]["code"] == "budget_exceeded"


# ── circuit breaker integration ────────────────────────────────────────────
class TestCircuitBreakerIntegration:
    def test_repeated_failures_open_the_circuit(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(
            isolated_state, name="flaky", priority=1))
        loop.run_until_complete(make_account(
            isolated_state, name="solid", priority=2, base_url="https://solid.local/v1"))

        # 'failover' always tries the priority-1 account first
        loop.run_until_complete(
            isolated_state.update_routing({"strategy": "failover"}))
        upstream.add("POST", "/v1/chat/completions", status=503,
                     body={"error": {"message": "overloaded"}}, host="api.test.local")
        upstream.add("POST", "/v1/chat/completions", body=openai_chat(),
                     host="solid.local")

        for _ in range(5):
            r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
            assert r.status_code == 200          # the backup always covered it
            assert r.headers["x-aiproxy-account"] == "solid"

        # five consecutive failures on 'flaky' must have opened its circuit …
        assert isolated_state.breaker.status("flaky") == "open"
        assert isolated_state.health_summary()["healthy"] == 1

        # … and the admin reset must close it again
        assert client.post("/admin/accounts/flaky/reset", headers=AUTH).status_code == 200
        assert isolated_state.breaker.status("flaky") == "closed"

    def test_open_circuit_is_skipped_by_the_router(self, client, upstream, isolated_state):
        import asyncio
        from tests.conftest import make_account
        loop = asyncio.get_event_loop()
        loop.run_until_complete(make_account(
            isolated_state, name="flaky", priority=1))
        loop.run_until_complete(make_account(
            isolated_state, name="solid", priority=2, base_url="https://solid.local/v1"))
        loop.run_until_complete(isolated_state.update_routing({"strategy": "failover"}))

        isolated_state.breaker.on_failure("flaky", "forced")
        isolated_state.breaker.on_failure("flaky", "forced")
        isolated_state.breaker.on_failure("flaky", "forced")
        isolated_state.breaker.on_failure("flaky", "forced")
        isolated_state.breaker.on_failure("flaky", "forced")
        assert isolated_state.breaker.status("flaky") == "open"

        upstream.add("POST", "/v1/chat/completions", body=openai_chat(), host="solid.local")
        r = client.post("/v1/chat/completions", json=BODY, headers=AUTH)
        assert r.status_code == 200
        assert r.headers["x-aiproxy-account"] == "solid"
        assert int(r.headers["x-aiproxy-attempts"]) == 1     # never even tried 'flaky'
