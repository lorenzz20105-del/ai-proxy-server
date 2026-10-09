"""Provider adapters.

Each adapter knows three things: how to build the upstream HTTP request, how to turn
the upstream's response into the OpenAI shape, and how to translate its SSE stream.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from . import translator as tr
from .models import ProviderAccount


@dataclass
class UpstreamRequest:
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    json: dict[str, Any] | None = None
    method: str = "POST"
    query: dict[str, str] = field(default_factory=dict)


class Provider:
    """Base adapter — the OpenAI-compatible behaviour, which most providers share."""

    name = "openai"
    default_base_url = "https://api.openai.com/v1"

    def supports(self, account: ProviderAccount) -> bool:
        return True

    # ── chat ──────────────────────────────────────────────────────────────
    def chat(self, account: ProviderAccount, body: dict[str, Any], model: str,
             stream: bool = False) -> UpstreamRequest:
        payload = dict(body)
        payload["model"] = model
        if stream:
            payload["stream"] = True
        return UpstreamRequest(
            url=f"{account.base_url}/chat/completions",
            headers=self.auth_headers(account),
            json=payload,
        )

    def chat_response(self, account: ProviderAccount, data: dict[str, Any],
                      model: str) -> dict[str, Any]:
        return data

    async def chat_stream(self, account: ProviderAccount, lines: AsyncIterator[str], model: str,
                          include_usage: bool = False) -> AsyncIterator[dict[str, Any]]:
        """Default: the upstream already speaks OpenAI SSE, so pass the data through."""
        async for payload in self._sse_payloads(lines):
            yield payload

    # ── embeddings ────────────────────────────────────────────────────────
    def embeddings(self, account: ProviderAccount, body: dict[str, Any]) -> UpstreamRequest:
        return UpstreamRequest(
            url=f"{account.base_url}/embeddings",
            headers=self.auth_headers(account),
            json=body,
        )

    def embeddings_response(self, account: ProviderAccount, data: dict[str, Any],
                            model: str, encoding_format: str = "float") -> dict[str, Any]:
        return data

    # ── misc ──────────────────────────────────────────────────────────────
    def auth_headers(self, account: ProviderAccount) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if account.api_key:
            headers["Authorization"] = f"Bearer {account.api_key}"
        if account.user_agent:
            headers["User-Agent"] = account.user_agent
        headers.update(account.extra_headers)
        return headers

    def models(self, account: ProviderAccount) -> UpstreamRequest:
        return UpstreamRequest(url=f"{account.base_url}/models",
                               headers=self.auth_headers(account), method="GET")

    def probe(self, account: ProviderAccount) -> UpstreamRequest:
        return self.models(account)

    @staticmethod
    async def _sse_payloads(lines: AsyncIterator[str]) -> AsyncIterator[dict[str, Any]]:
        async for raw in lines:
            line = raw.strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            try:
                yield json.loads(data)
            except json.JSONDecodeError:
                continue

    @staticmethod
    def stream_error(lines: Iterator[str]) -> str:
        """Pull an error message out of an OpenAI-style error stream."""
        for raw in lines:
            if "error" in raw:
                try:
                    payload = json.loads(raw[5:].strip()) if raw.strip().startswith("data:") else {}
                except json.JSONDecodeError:
                    continue
                error = payload.get("error")
                if isinstance(error, dict):
                    return str(error.get("message", ""))[:500]
                if error:
                    return str(error)[:500]
        return ""


class OpenAICompatible(Provider):
    name = "openai"


class AzureOpenAI(Provider):
    """Azure needs a deployment path and `api-key` instead of a bearer token."""

    name = "azure"

    def chat(self, account, body, model, stream=False):
        url = (
            f"{account.base_url}/openai/deployments/{model}/chat/completions"
            f"?api-version={account.azure_api_version}"
        )
        payload = dict(body)
        payload.pop("model", None)  # the deployment carries the model
        if stream:
            payload["stream"] = True
        headers = {
            "Content-Type": "application/json",
            "api-key": account.api_key,
            "Accept": "application/json",
        }
        if account.user_agent:
            headers["User-Agent"] = account.user_agent
        headers.update(account.extra_headers)
        return UpstreamRequest(url=url, headers=headers, json=payload)

    def auth_headers(self, account):
        headers = {"Content-Type": "application/json", "api-key": account.api_key}
        if account.user_agent:
            headers["User-Agent"] = account.user_agent
        headers.update(account.extra_headers)
        return headers

    def models(self, account):
        return UpstreamRequest(
            url=f"{account.base_url}/openai/models?api-version={account.azure_api_version}",
            headers=self.auth_headers(account), method="GET",
        )


class Anthropic(Provider):
    name = "anthropic"

    def auth_headers(self, account):
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-api-key": account.api_key,
            "anthropic-version": "2023-06-01",
        }
        if account.user_agent:
            headers["User-Agent"] = account.user_agent
        headers.update(account.extra_headers)
        return headers

    def chat(self, account, body, model, stream=False):
        payload = tr.openai_to_anthropic(body, model)
        if stream:
            payload["stream"] = True
        return UpstreamRequest(
            url=f"{account.base_url}/messages",
            headers=self.auth_headers(account),
            json=payload,
        )

    def chat_response(self, account, data, model):
        if "error" in data and "choices" not in data:
            raise RuntimeError(data["error"].get("message", "anthropic error"))
        return tr.anthropic_to_openai(data, model)

    async def chat_stream(self, account, lines, model, include_usage=False):
        async for payload in tr.anthropic_sse_to_openai(
            self._sse_payloads(lines), model, include_usage):
            yield payload

    def models(self, account):
        return UpstreamRequest(
            url=f"{account.base_url}/models",
            headers=self.auth_headers(account), method="GET",
        )

    def probe(self, account):
        # /models is not always reachable for scoped keys; a 1-token message is definitive.
        return UpstreamRequest(
            url=f"{account.base_url}/messages",
            headers=self.auth_headers(account),
            json={
                "model": (account.models or ["claude-3-5-haiku-latest"])[0],
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}],
            },
        )


class Google(Provider):
    name = "google"

    def auth_headers(self, account):
        # The key goes in a header, never the query string: URLs end up in every
        # access log and crash report on the planet.
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-goog-api-key": account.api_key,
        }
        if account.user_agent:
            headers["User-Agent"] = account.user_agent
        headers.update(account.extra_headers)
        return headers

    def chat(self, account, body, model, stream=False):
        payload = tr.openai_to_gemini(body, model)
        verb = "streamGenerateContent?alt=sse" if stream else "generateContent"
        return UpstreamRequest(
            url=f"{account.base_url}/models/{model}:{verb}",
            headers=self.auth_headers(account),
            json=payload,
        )

    def chat_response(self, account, data, model):
        if "error" in data:
            raise RuntimeError(data["error"].get("message", "gemini error"))
        return tr.gemini_to_openai(data, model)

    async def chat_stream(self, account, lines, model, include_usage=False):
        async for payload in tr.gemini_sse_to_openai(
            self._sse_payloads(lines), model, include_usage):
            yield payload

    def embeddings(self, account, body):
        batch, payload = tr.openai_embedding_to_gemini(body)
        model = str(body.get("model") or "text-embedding-004").removeprefix("models/")
        method = "batchEmbedContents" if batch else "embedContent"
        return UpstreamRequest(
            url=f"{account.base_url}/models/{model}:{method}",
            headers=self.auth_headers(account),
            json=payload,
        )

    def embeddings_response(self, account, data, model, encoding_format="float"):
        return tr.gemini_embeddings_to_openai(data, model, encoding_format)

    def models(self, account):
        return UpstreamRequest(
            url=f"{account.base_url}/models",
            headers=self.auth_headers(account), method="GET",
        )


PROVIDERS: dict[str, Provider] = {
    "openai": OpenAICompatible(),
    "azure": AzureOpenAI(),
    "anthropic": Anthropic(),
    "google": Google(),
}


def get_provider(account: ProviderAccount) -> Provider:
    return PROVIDERS.get(account.provider_type, PROVIDERS["openai"])


def register_provider(adapter: Provider) -> None:
    PROVIDERS[adapter.name] = adapter