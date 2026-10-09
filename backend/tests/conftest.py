"""Shared test fixtures — a fake upstream so the whole stack can be exercised offline."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app import clientpool, security  # noqa: E402
from app.cache import ResponseCache  # noqa: E402
from app.config import settings  # noqa: E402


class FakeUpstream:
    """Records requests and replays scripted responses."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.routes: dict[tuple[str, str], Any] = {}
        self.default = {"status": 500, "body": {"error": {"message": "no route configured"}}}

    def add(self, method: str, path: str, status: int = 200,
            body: Any = None, raw: bytes | None = None,
            host: str | None = None) -> "FakeUpstream":
        """`host` scopes the route to one account's base_url (e.g. 'good.local')."""
        self.routes[(method.upper(), path, host)] = {
            "status": status, "body": body, "raw": raw}
        return self

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        host = request.url.host
        route = (self.routes.get((request.method.upper(), path, None))
                 or self.routes.get(("*", path, None)))
        for (method, route_path, route_host), value in self.routes.items():
            if route_host and route_host in host and route_path == path and \
                    (method == request.method.upper() or method == "*"):
                route = value
                break
        if route is None:
            return httpx.Response(404, json={"error": {"message": "unrouted: " + request.url.path}})
        if route.get("raw") is not None:
            return httpx.Response(route["status"], content=route["raw"],
                                  headers={"content-type": "text/event-stream"})
        return httpx.Response(route["status"], json=route.get("body", {}))

    def json_bodies(self) -> list[dict[str, Any]]:
        out = []
        for request in self.requests:
            try:
                out.append(json.loads(request.content))
            except Exception:
                pass
        return out


def openai_chat(text: str = "hello", model: str = "gpt-4o", **usage) -> dict[str, Any]:
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "created": 1,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, **usage},
    }


def sse(chunks: list[str]) -> bytes:
    return ("".join(chunks) + "data: [DONE]\n\n").encode()


OPENAI_STREAM = sse([
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",'
    '"choices":[{"index":0,"delta":{"role":"assistant","content":"He"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",'
    '"choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-4o",'
    '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
    '"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
])


@pytest.fixture
def upstream(monkeypatch) -> FakeUpstream:
    fake = FakeUpstream()

    async def fake_client(account):  # noqa: ANN001
        return httpx.AsyncClient(
            transport=httpx.MockTransport(fake.handle),
            timeout=httpx.Timeout(5.0),
        )

    monkeypatch.setattr(clientpool.client_pool, "get", fake_client)
    monkeypatch.setattr(clientpool.client_pool, "stream_client", fake_client)
    return fake


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    """Every test gets a fresh database, key set and registry."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(settings, "data_dir", str(data_dir))
    monkeypatch.setattr(settings, "master_key", "sk-proxy-testmasterkey0000000000000000")
    monkeypatch.setattr(settings, "encryption_key", "")
    monkeypatch.setattr(security, "secret_box", security.SecretBox())

    from app import registry as registry_module
    from app import usage as usage_module

    registry = registry_module.Registry()
    registry.cache = ResponseCache(ttl=60, max_entries=100)
    usage = usage_module.UsageTracker()

    monkeypatch.setattr(registry_module, "registry", registry)
    monkeypatch.setattr(usage_module, "usage", usage)

    for module_name in ("app.api", "app.admin", "app.main"):
        module = sys.modules.get(module_name)
        if module is not None and hasattr(module, "registry"):
            monkeypatch.setattr(module, "registry", registry)
        if module is not None and hasattr(module, "usage"):
            monkeypatch.setattr(module, "usage", usage)
        if module_name == "app.api" and module is not None:
            from app.router import Router

            monkeypatch.setattr(module, "router", Router(registry, clientpool.client_pool))
        if module_name == "app.admin" and module is not None:
            from app.router import Router

            monkeypatch.setattr(module, "router", Router(registry, clientpool.client_pool))

    yield registry

    registry.store.close()


async def make_account(registry, **overrides) -> Any:
    from app.models import AccountCreate

    payload = {
        "name": "test-openai",
        "provider_type": "openai",
        "base_url": "https://api.test.local/v1",
        "api_key": "sk-upstream-0001",
        "models": ["gpt-4o", "gpt-4o-mini"],
    }
    payload.update(overrides)
    return await registry.upsert_account(AccountCreate(**payload).to_account())