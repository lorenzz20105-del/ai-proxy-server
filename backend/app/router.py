"""Routing engine: pick an account, call it, retry, fail over, account for it.

This is where v2's "failover" strategy actually becomes one: v2 returned `enabled[0]`
and then gave up with a 502 on the first error. Here a failed attempt feeds the circuit
breaker, the next candidate is chosen with backoff, and the *streaming* case retries
safely because nothing has been written to the client until the first byte arrives.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import httpx

from . import pricing
from .breaker import CircuitBreaker
from .cache import ResponseCache, cache_key, is_deterministic
from .clientpool import ClientPool
from .config import settings
from .metrics import metrics
from .models import ProviderAccount
from .ratelimit import rate_limiter
from .registry import Registry
from .upstream import Provider, UpstreamRequest, get_provider
from .usage import usage

log = logging.getLogger("aiproxy.router")

NON_RETRYABLE = {400, 401, 403, 404, 405, 413, 415, 422}


class NoAccountsAvailable(Exception):
    pass


class UpstreamFailed(Exception):
    def __init__(self, message: str, status: int = 502, account: str = "",
                 attempts: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.account = account
        self.attempts = attempts
        self.body = body


class RateLimited(Exception):
    def __init__(self, message: str, retry_after: float = 1.0) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass
class Context:
    request_id: str
    requested_model: str
    session_id: str = ""
    key_name: str = "master"
    method: str = "POST"
    path: str = "/v1/chat/completions"
    prompt_tokens_estimate: int = 0
    request_body: dict[str, Any] = field(default_factory=dict)
    include_usage: bool = False

    def base_entry(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "requested_model": self.requested_model,
            "key_name": self.key_name,
            "session_id": self.session_id,
            "method": self.method,
            "path": self.path,
        }


@dataclass
class Outcome:
    data: Any = None
    account: str = ""
    status: int = 200
    attempts: int = 1
    latency_ms: float = 0.0
    ttft_ms: float | None = None
    usage_data: dict[str, Any] = field(default_factory=dict)
    cost_usd: float = 0.0
    from_cache: bool = False
    stream: bool = False
    prompt_tokens: int = 0
    completion_tokens: int = 0


class Router:
    def __init__(self, registry: Registry, pool: ClientPool) -> None:
        self.registry = registry
        self.pool = pool
        self._rr_cursor: dict[str, int] = {}
        self._sessions: dict[str, tuple[str, float]] = {}

    # ── selection ─────────────────────────────────────────────────────────
    @property
    def breaker(self) -> CircuitBreaker:
        return self.registry.breaker

    @property
    def cache(self) -> ResponseCache:
        return self.registry.cache

    def candidates(self, model: str, exclude: set[str]) -> list[ProviderAccount]:
        """Enabled accounts that serve `model` and whose circuit is not open."""
        matching = self.registry.routing.get("model_matching", "exact")
        out: list[ProviderAccount] = []
        for account in self.registry.enabled_accounts():
            if account.name in exclude:
                continue
            if not account.supports_model(model, matching):
                continue
            out.append(account)
        return out

    def order(self, pool: list[ProviderAccount], strategy: str,
              model: str, prompt_tokens: int) -> list[ProviderAccount]:
        if not pool:
            return []
        key = f"{strategy}:{model}"
        cursor = self._rr_cursor.get(key, 0)

        if strategy == "priority":
            groups: dict[int, list[ProviderAccount]] = {}
            for account in pool:
                groups.setdefault(account.priority, []).append(account)
            ordered: list[ProviderAccount] = []
            for priority in sorted(groups):
                group = groups[priority]
                start = cursor % len(group)
                ordered.extend(group[start:] + group[:start])
                cursor += 1
            self._rr_cursor[key] = cursor
            return ordered

        if strategy == "random":
            shuffled = list(pool)
            random.shuffle(shuffled)
            return shuffled

        if strategy == "weighted":
            expanded: list[ProviderAccount] = []
            for account in pool:
                expanded.extend([account] * min(account.weight, 20))
            random.shuffle(expanded)
            return expanded

        if strategy == "least_latency":
            return sorted(pool, key=lambda a: metrics.account_latency(a.name)["avg"])

        if strategy == "least_requests":
            return sorted(
                pool,
                key=lambda a: (
                    rate_limiter.in_flight(f"account:{a.name}")
                    + a.request_count / max(1, a.request_count + 50),
                ),
            )

        if strategy == "least_cost":
            price = pricing.get_price(model)
            per_token = (price.input + price.output) / 2_000_000
            return sorted(pool, key=lambda a: a.routing.cost_multiplier * per_token
                          * pricing.estimate_prompt_tokens({"messages": [{"content": "x"}]}) * 0.0
                          + a.routing.cost_multiplier * per_token * max(1, prompt_tokens))

        # round_robin (default) and failover both rotate; failover simply starts from
        # the front of the list every time, so ordering falls through to `cursor`.
        start = cursor % len(pool)
        self._rr_cursor[key] = cursor + 1
        rotated = pool[start:] + pool[:start]
        if strategy == "failover":
            rotated = sorted(rotated, key=lambda a: (a.priority, a.name))
            merged: list[ProviderAccount] = []
            seen: set[str] = set()
            for account in rotated + sorted(pool, key=lambda a: (a.priority, a.name)):
                if account.name not in seen:
                    seen.add(account.name)
                    merged.append(account)
            return merged
        return rotated

    def select(self, model: str, session_id: str, exclude: set[str],
               prompt_tokens: int = 0) -> tuple[ProviderAccount, Provider]:
        """Choose the next account to try, honouring session pinning and circuits."""
        pool = self.candidates(model, exclude)
        if not pool:
            raise NoAccountsAvailable(
                f"no enabled account serves model '{model}'"
                if self.registry.enabled_accounts()
                else "no enabled accounts configured"
            )

        affinity = self.registry.routing.get("session_affinity", {})
        if session_id and affinity.get("enabled"):
            pinned = self._pinned_account(session_id)
            if pinned is not None and pinned.name not in exclude:
                strategy = pinned.routing.strategy or self.registry.routing["strategy"]
                ordered = self.order(pool, strategy, model, prompt_tokens)
                if ordered and ordered[0].name != pinned.name:
                    ordered = [pinned] + [a for a in ordered if a.name != pinned.name]
                if self.breaker.try_acquire(pinned.name):
                    return pinned, get_provider(pinned)

        strategy = self.registry.routing["strategy"]
        for account in self.order(pool, strategy, model, prompt_tokens):
            if self.breaker.try_acquire(account.name):
                return account, get_provider(account)

        raise NoAccountsAvailable("all accounts for this model have open circuits")

    # ── session affinity ──────────────────────────────────────────────────
    def _pinned_account(self, session_id: str) -> ProviderAccount | None:
        affinity = self.registry.routing.get("session_affinity", {})
        ttl = float(affinity.get("ttl_seconds", 1800.0))
        entry = self._sessions.get(session_id)
        if entry is None:
            return None
        account_name, expires = entry
        if time.time() > expires:
            self._sessions.pop(session_id, None)
            return None
        account = self.registry.get(account_name)
        if account is None or not account.enabled:
            self._sessions.pop(session_id, None)
            return None
        return account

    def pin(self, session_id: str, account_name: str) -> None:
        affinity = self.registry.routing.get("session_affinity", {})
        if not (session_id and affinity.get("enabled")):
            return
        ttl = float(affinity.get("ttl_seconds", 1800.0))
        if len(self._sessions) > 10_000:
            now = time.time()
            self._sessions = {k: v for k, v in self._sessions.items() if v[1] > now}
        self._sessions[session_id] = (account_name, time.time() + ttl)

    # ── retry policy ──────────────────────────────────────────────────────
    def _should_retry(self, status: int, attempt: int) -> bool:
        retry_codes = set(self.registry.routing.get("retry", {}).get(
            "retry_status_codes", settings.retry_status_codes))
        if status in NON_RETRYABLE:
            return False
        return status in retry_codes and attempt < self.max_attempts

    @property
    def max_attempts(self) -> int:
        return max(1, int(self.registry.routing.get("retry", {}).get(
            "max_attempts", settings.max_attempts)))

    def _backoff(self, attempt: int) -> float:
        retry = self.registry.routing.get("retry", {})
        base = float(retry.get("backoff_seconds", settings.retry_backoff))
        cap = float(retry.get("max_backoff_seconds", settings.retry_max_backoff))
        delay = min(cap, base * (2 ** (attempt - 1)))
        if retry.get("jitter", True):
            delay *= random.uniform(0.75, 1.5)
        return max(0.0, delay)

    # ── rate limits ───────────────────────────────────────────────────────
    def _check_limits(self, account: ProviderAccount, prompt_tokens: int) -> None:
        decision = rate_limiter.check(f"account:{account.name}", tokens=prompt_tokens)
        if not decision.allowed:
            metrics.inc("rate_limited_total", scope=decision.scope)
            raise RateLimited(decision.detail, decision.retry_after)

    # ── non-streaming chat ────────────────────────────────────────────────
    async def chat(self, body: dict[str, Any], ctx: Context) -> Outcome:
        started = time.time()
        chain = self.registry.resolve_chain(ctx.requested_model)
        exclude: set[str] = set()
        last_error = ""
        last_status = 502
        attempts = 0
        prompt_estimate = ctx.prompt_tokens_estimate or pricing.estimate_prompt_tokens(body)

        for concrete_model in chain:
            model_exhausted = False
            while True:
                if attempts >= self.max_attempts:
                    model_exhausted = True
                    break
                try:
                    account, provider = self.select(
                        concrete_model, ctx.session_id, exclude, prompt_estimate)
                except NoAccountsAvailable as exc:
                    last_error = str(exc)
                    model_exhausted = True
                    break
                attempts += 1

                exclude.add(account.name)
                rate_limiter.acquire(f"account:{account.name}")
                try:
                    self._check_limits(account, prompt_estimate)
                    outcome = await self._call_upstream(
                        account, provider, body, concrete_model, ctx, prompt_estimate)
                    outcome.attempts = attempts
                    outcome.latency_ms = (time.time() - started) * 1000
                    if ctx.session_id:
                        self.pin(ctx.session_id, account.name)
                    metrics.inc("requests_total", status=outcome.status)
                    metrics.status(outcome.status)
                    metrics.observe("request_latency_seconds",
                                    outcome.latency_ms / 1000, account=account.name,
                                    model=concrete_model)
                    if attempts > 1:
                        metrics.inc("failovers_total")
                    return outcome
                except RateLimited:
                    self.breaker.release(account.name)
                    raise
                except UpstreamFailed as exc:
                    last_error, last_status = str(exc), exc.status
                    metrics.inc("upstream_errors_total", account=account.name)
                    if not self._should_retry(exc.status, attempts):
                        self.breaker.release(account.name)
                        raise
                    await asyncio.sleep(self._backoff(attempts))
                    metrics.inc("retries_total")
                    continue
                finally:
                    rate_limiter.release(f"account:{account.name}")

            if model_exhausted:
                continue

        if attempts == 0:
            # Nothing was ever even attempted — that is a capacity problem, not an
            # upstream problem, and must surface as 503 rather than 502.
            raise NoAccountsAvailable(last_error or "no healthy accounts available")
        raise UpstreamFailed(last_error or "all upstreams failed", last_status,
                             attempts=attempts)

    async def _call_upstream(self, account: ProviderAccount, provider: Provider,
                            body: dict[str, Any], model: str, ctx: Context,
                            prompt_estimate: int) -> Outcome:
        request = provider.chat(account, body, model, stream=False)
        client = await self.pool.get(account)
        try:
            response = await client.post(
                request.url, json=request.json, headers=request.headers,
                params=request.query or None,
            )
        except httpx.TimeoutException as exc:
            self.breaker.on_failure(account.name, f"timeout: {exc.__class__.__name__}")
            raise UpstreamFailed(f"upstream timeout: {exc.__class__.__name__}", 504,
                                 account.name) from exc
        except httpx.HTTPError as exc:
            self.breaker.on_failure(account.name, f"transport: {exc}")
            raise UpstreamFailed(f"upstream transport error: {exc}", 502, account.name) from exc

        if response.status_code >= 400:
            error_text = self._error_text(response)
            retryable = response.status_code in set(
                self.registry.routing.get("retry", {}).get(
                    "retry_status_codes", settings.retry_status_codes))
            if response.status_code in (429,) or retryable:
                self.breaker.on_failure(account.name, error_text)
            else:
                # A 400 is our client's fault, not the account's — do not trip a circuit.
                self.breaker.release(account.name)
            raise UpstreamFailed(error_text, response.status_code, account.name,
                                 body=self._safe_json(response))

        try:
            data = provider.chat_response(account, response.json(), model)
        except (json.JSONDecodeError, ValueError) as exc:
            self.breaker.on_failure(account.name, f"bad json: {exc}")
            raise UpstreamFailed(f"upstream returned invalid JSON: {exc}", 502,
                                 account.name) from exc
        except RuntimeError as exc:
            self.breaker.on_failure(account.name, str(exc))
            raise UpstreamFailed(str(exc), 502, account.name) from exc

        self.breaker.on_success(account.name)
        account.request_count += 1
        account.last_used = time.time()

        cost = pricing.compute_cost(model, data.get("usage"),
                                    account.routing.cost_multiplier)
        account.cost_usd += cost.cost_usd
        account.tokens_in += cost.prompt_tokens
        account.tokens_out += cost.completion_tokens

        metrics.inc("tokens_in_total", cost.prompt_tokens)
        metrics.inc("tokens_out_total", cost.completion_tokens)
        metrics.inc("cost_usd_total", cost.cost_usd)

        return Outcome(
            data=data, account=account.name, status=response.status_code,
            usage_data=data.get("usage") or {}, cost_usd=cost.cost_usd,
            prompt_tokens=cost.prompt_tokens, completion_tokens=cost.completion_tokens,
        )

    @staticmethod
    def _error_text(response: httpx.Response) -> str:
        try:
            payload = response.json()
        except Exception:
            return (response.text or f"HTTP {response.status_code}")[:500]
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict):
            return str(error.get("message") or error)[:500]
        if isinstance(error, str):
            return error[:500]
        return str(payload)[:500]

    @staticmethod
    def _safe_json(response: httpx.Response) -> Any:
        try:
            return response.json()
        except Exception:
            return None

    # ── streaming chat ────────────────────────────────────────────────────
    async def chat_stream(self, body: dict[str, Any], ctx: Context) -> AsyncIterator[str]:
        """Yield OpenAI SSE lines. Retries happen before the first byte is yielded."""
        started = time.time()
        chain = self.registry.resolve_chain(ctx.requested_model)
        exclude: set[str] = set()
        last_error = ""
        last_status = 502
        attempts = 0
        prompt_estimate = ctx.prompt_tokens_estimate or pricing.estimate_prompt_tokens(body)

        for concrete_model in chain:
            while True:
                if attempts >= self.max_attempts:
                    break
                try:
                    account, provider = self.select(
                        concrete_model, ctx.session_id, exclude, prompt_estimate)
                except NoAccountsAvailable as exc:
                    last_error = str(exc)
                    break
                attempts += 1

                exclude.add(account.name)
                rate_limiter.acquire(f"account:{account.name}")
                opened = False
                try:
                    self._check_limits(account, prompt_estimate)
                    request = provider.chat(account, body, concrete_model, stream=True)
                    client = await self.pool.stream_client(account)
                    stream_ctx = client.stream(
                        request.method, request.url, json=request.json,
                        headers=request.headers, params=request.query or None,
                    )
                    response = await stream_ctx.__aenter__()
                    if response.status_code >= 400:
                        error_text = self._error_text(response)
                        await stream_ctx.__aexit__(None, None, None)
                        retryable = response.status_code not in NON_RETRYABLE
                        if retryable:
                            self.breaker.on_failure(account.name, error_text)
                        else:
                            self.breaker.release(account.name)
                        last_error, last_status = error_text, response.status_code
                        if not retryable or attempts >= self.max_attempts:
                            raise UpstreamFailed(error_text, response.status_code, account.name)
                        await asyncio.sleep(self._backoff(attempts))
                        metrics.inc("retries_total")
                        continue

                    opened = True
                    if ctx.session_id:
                        self.pin(ctx.session_id, account.name)
                    metrics.inc("requests_total", status=200)
                    metrics.inc("streaming_requests_total")
                    self.breaker.on_success(account.name)
                    account.request_count += 1
                    account.last_used = time.time()

                    async for line in self._pump(response, provider, concrete_model, ctx,
                                                 account, attempts, started):
                        yield line
                    return
                except UpstreamFailed:
                    raise
                except httpx.HTTPError as exc:
                    self.breaker.on_failure(account.name, str(exc))
                    last_error, last_status = f"upstream transport error: {exc}", 502
                    if attempts >= self.max_attempts:
                        raise UpstreamFailed(last_error, last_status, account.name) from exc
                    await asyncio.sleep(self._backoff(attempts))
                    metrics.inc("retries_total")
                    continue
                finally:
                    if opened:
                        pass
                    rate_limiter.release(f"account:{account.name}")

        if attempts == 0:
            raise NoAccountsAvailable(last_error or "no healthy accounts available")
        raise UpstreamFailed(last_error or "all upstreams failed", last_status,
                             attempts=attempts)

    async def _pump(self, response: httpx.Response, provider: Provider, model: str,
                    ctx: Context, account: ProviderAccount, attempts: int,
                    started: float) -> AsyncIterator[str]:
        """Translate and emit the upstream stream, then account for it."""
        first_byte = time.time()
        collected: list[str] = []
        usage_data: dict[str, Any] = {}
        emitted = 0

        try:
            async for payload in provider.chat_stream(
                account, response.aiter_lines(), model, ctx.include_usage):
                emitted += 1
                if emitted == 1:
                    metrics.observe("ttft_seconds", time.time() - first_byte,
                                    account=account.name, model=model)
                delta = payload.get("choices")
                if delta:
                    for choice in delta:
                        collected.append((choice.get("delta") or {}).get("content") or "")
                if payload.get("usage"):
                    usage_data = payload["usage"]
                yield f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
        except Exception as exc:  # upstream died mid-stream
            log.warning("stream from %s failed after %d chunks: %s", account.name, emitted, exc)
            yield "data: " + json.dumps({"error": {
                "message": f"upstream stream failed: {exc}", "type": "upstream_error",
                "code": "upstream_error"}}) + "\n\n"

        text = "".join(collected)
        if not usage_data:
            usage_data = {
                "prompt_tokens": ctx.prompt_tokens_estimate
                or pricing.estimate_prompt_tokens(ctx.request_body),
                "completion_tokens": pricing.estimate_completion_tokens(text),
            }
            estimated = True
        else:
            estimated = False

        cost = pricing.compute_cost(model, usage_data, account.routing.cost_multiplier)
        account.cost_usd += cost.cost_usd
        account.tokens_in += cost.prompt_tokens
        account.tokens_out += cost.completion_tokens
        metrics.inc("tokens_in_total", cost.prompt_tokens)
        metrics.inc("tokens_out_total", cost.completion_tokens)
        metrics.inc("cost_usd_total", cost.cost_usd)

        latency_ms = (time.time() - started) * 1000
        metrics.observe("request_latency_seconds", latency_ms / 1000,
                        account=account.name, model=model)

        await usage.record(
            **ctx.base_entry(),
            model=model,
            account=account.name,
            status=200,
            attempts=attempts,
            latency_ms=latency_ms,
            ttft_ms=(first_byte - started) * 1000,
            stream=True,
            prompt_tokens=cost.prompt_tokens,
            completion_tokens=cost.completion_tokens,
            cost_usd=cost.cost_usd,
            location=account.location,
            estimated_usage=estimated,
        )

    # ── cache ─────────────────────────────────────────────────────────────
    def cache_lookup(self, body: dict[str, Any], model: str) -> dict[str, Any] | None:
        return self.cache.get(cache_key(body, model))

    def cache_store(self, body: dict[str, Any], model: str, data: dict[str, Any]) -> None:
        cache_cfg = self.registry.routing.get("cache", {})
        if not cache_cfg.get("enabled", True):
            return
        if cache_cfg.get("deterministic_only") and not is_deterministic(body):
            return
        if (body.get("n") or 1) > 1:
            return
        self.cache.set(cache_key(body, model), data)

    # ── simple pass-through endpoints ─────────────────────────────────────
    async def passthrough(self, build: Any, ctx: Context,
                          prompt_tokens: int = 0) -> Outcome:
        """embeddings / images / legacy completions: pick, retry, return JSON."""
        started = time.time()
        exclude: set[str] = set()
        chain = self.registry.resolve_chain(ctx.requested_model)
        last_error = ""
        last_status = 502
        attempts = 0

        for concrete_model in chain:
            while True:
                if attempts >= self.max_attempts:
                    break
                try:
                    account, provider = self.select(concrete_model, ctx.session_id, exclude,
                                                    prompt_tokens)
                except NoAccountsAvailable as exc:
                    last_error = str(exc)
                    break
                attempts += 1
                exclude.add(account.name)
                rate_limiter.acquire(f"account:{account.name}")
                try:
                    self._check_limits(account, prompt_tokens)
                    request = build(account, provider, concrete_model)
                    client = await self.pool.get(account)
                    try:
                        response = await client.request(
                            request.method, request.url, json=request.json,
                            headers=request.headers, params=request.query or None,
                        )
                    except httpx.HTTPError as exc:
                        self.breaker.on_failure(account.name, str(exc))
                        last_error, last_status = str(exc), 502
                        if attempts >= self.max_attempts:
                            raise UpstreamFailed(last_error, last_status,
                                                 account.name) from exc
                        await asyncio.sleep(self._backoff(attempts))
                        metrics.inc("retries_total")
                        continue

                    if response.status_code >= 400:
                        error_text = self._error_text(response)
                        if response.status_code not in NON_RETRYABLE:
                            self.breaker.on_failure(account.name, error_text)
                        else:
                            self.breaker.release(account.name)
                        last_error, last_status = error_text, response.status_code
                        if not self._should_retry(response.status_code, attempts):
                            raise UpstreamFailed(error_text, response.status_code,
                                                 account.name)
                        await asyncio.sleep(self._backoff(attempts))
                        metrics.inc("retries_total")
                        continue

                    self.breaker.on_success(account.name)
                    account.request_count += 1
                    account.last_used = time.time()
                    data = response.json()
                    usage_data = data.get("usage") or {}
                    cost = pricing.compute_cost(concrete_model, usage_data,
                                                account.routing.cost_multiplier)
                    account.cost_usd += cost.cost_usd
                    account.tokens_in += cost.prompt_tokens
                    account.tokens_out += cost.completion_tokens
                    metrics.inc("tokens_in_total", cost.prompt_tokens)
                    metrics.inc("tokens_out_total", cost.completion_tokens)
                    metrics.inc("cost_usd_total", cost.cost_usd)
                    metrics.inc("requests_total", status=response.status_code)
                    metrics.observe("request_latency_seconds", time.time() - started,
                                    account=account.name, model=concrete_model)
                    return Outcome(
                        data=data, account=account.name, status=response.status_code,
                        attempts=attempts, latency_ms=(time.time() - started) * 1000,
                        usage_data=usage_data, cost_usd=cost.cost_usd,
                        prompt_tokens=cost.prompt_tokens,
                        completion_tokens=cost.completion_tokens,
                    )
                finally:
                    rate_limiter.release(f"account:{account.name}")

        raise UpstreamFailed(last_error or "all upstreams failed", last_status,
                             attempts=attempts)
