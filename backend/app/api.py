"""OpenAI-compatible endpoints."""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import pricing
from .clientpool import client_pool
from .config import settings
from .metrics import metrics
from .registry import registry
from .router import Context, NoAccountsAvailable, Outcome, RateLimited, Router, UpstreamFailed
from .security import AuthResult, authenticate, extract_key, key_allowed
from .usage import new_request_id, usage

log = logging.getLogger("aiproxy.api")

router = Router(registry, client_pool)

api = APIRouter()


# ── auth ───────────────────────────────────────────────────────────────────
async def require_key(request: Request) -> AuthResult:
    candidate = extract_key(dict(request.headers), request.url.query)
    result = authenticate(candidate, registry.keys, allow_admin=False)
    if not result.ok:
        raise HTTPException(
            status_code=401,
            detail={"message": result.reason or "Invalid API key",
                    "type": "invalid_api_key", "code": "invalid_api_key",
                    "request_id": getattr(request.state, "request_id", "")},
        )
    request.state.key_name = result.name
    return result


async def require_admin_key(request: Request) -> AuthResult:
    candidate = extract_key(dict(request.headers), request.url.query)
    result = authenticate(candidate, registry.keys, allow_admin=True)
    if not result.ok:
        raise HTTPException(
            status_code=401 if not result.reason.startswith("admin") else 403,
            detail={"message": result.reason or "Invalid API key",
                    "type": "invalid_api_key", "code": "invalid_api_key",
                    "request_id": getattr(request.state, "request_id", "")},
        )
    request.state.key_name = result.name
    return result


def proxy_headers(request: Request, outcome: Outcome, cached: bool = False) -> dict[str, str]:
    return {
        "x-aiproxy-request-id": getattr(request.state, "request_id", ""),
        "x-aiproxy-account": outcome.account,
        "x-aiproxy-attempts": str(outcome.attempts),
        "x-aiproxy-latency-ms": f"{outcome.latency_ms:.1f}",
        "x-aiproxy-cache": "HIT" if cached else "MISS",
        "x-aiproxy-upstream-status": str(outcome.status),
        "x-aiproxy-cost-usd": f"{outcome.cost_usd:.8f}",
    }


def make_context(request: Request, body: dict[str, Any], model: str,
                 key_name: str = "master") -> Context:
    affinity = registry.routing.get("session_affinity", {})
    header = affinity.get("header", "x-session-id")
    session_id = request.headers.get(header) or request.headers.get("x-conversation-id") or ""
    stream_options = body.get("stream_options") or {}
    return Context(
        request_id=getattr(request.state, "request_id", new_request_id()),
        requested_model=model,
        session_id=session_id,
        key_name=key_name,
        method=request.method,
        path=request.url.path,
        prompt_tokens_estimate=pricing.estimate_prompt_tokens(body),
        request_body=body,
        include_usage=bool(stream_options.get("include_usage")),
    )


async def guard_budget(key_name: str, record: Any) -> None:
    state = usage.budget_state(registry.budget)
    if state["over_daily"] or state["over_monthly"]:
        raise HTTPException(429, {
            "message": "daily/monthly budget exhausted — top up or raise the limit",
            "type": "insufficient_quota", "code": "budget_exceeded",
            "spent_usd": state["spent_today_usd"],
        })
    key_limit = float(getattr(record, "daily_usd", 0) or 0)
    blocked = usage.budget_blocked(key_name, key_limit)
    if blocked:
        raise HTTPException(429, {"message": blocked, "type": "insufficient_quota",
                                  "code": "budget_exceeded"})


# ── models ─────────────────────────────────────────────────────────────────
@api.get("/v1/models")
async def list_models(auth: AuthResult = Depends(require_key)):
    data = registry.all_models()
    if settings.strict_models:
        allowed = getattr(auth.record, "models_allow", None)
        if allowed:
            data = [m for m in data if m["id"] in allowed]
    return {"object": "list", "data": data}


@api.get("/v1/models/{model_id:path}")
async def get_model(model_id: str, auth: AuthResult = Depends(require_key)):
    for entry in registry.all_models():
        if entry["id"] == model_id:
            return entry
    raise HTTPException(404, {"message": f"model '{model_id}' not found",
                              "type": "invalid_request_error", "code": "model_not_found"})


# ── chat completions ───────────────────────────────────────────────────────
@api.post("/v1/chat/completions")
async def chat_completions(request: Request, auth: AuthResult = Depends(require_key)):
    body = await read_json(request)
    model = body.get("model") or ""
    if not model:
        raise HTTPException(400, {"message": "'model' is required",
                                  "type": "invalid_request_error", "code": "missing_parameter"})
    if not key_allowed(auth.record, model):
        raise HTTPException(403, {"message": f"this key may not use model '{model}'",
                                  "type": "permission_error", "code": "model_not_allowed"})
    await guard_budget(auth.name, auth.record)

    chain = registry.resolve_chain(model)
    ctx = make_context(request, body, model, auth.name)
    stream = bool(body.get("stream"))

    # ── cache lookup (non-streaming only) ────────────────────────────────
    if not stream and not request.headers.get("x-aiproxy-no-cache"):
        concrete = chain[0]
        cached = router.cache_lookup(body, concrete)
        if cached is not None:
            metrics.inc("cache_hits_total")
            outcome = Outcome(data=cached, account="cache", status=200,
                              latency_ms=0.1, from_cache=True)
            usage_ = cached.get("usage") or {}
            outcome.prompt_tokens = int(usage_.get("prompt_tokens") or 0)
            outcome.completion_tokens = int(usage_.get("completion_tokens") or 0)
            outcome.cost_usd = pricing.compute_cost(
                concrete, usage_, 1.0).cost_usd
            await usage.record(**ctx.base_entry(), model=concrete, account="cache",
                               status=200, attempts=0, latency_ms=0.1, cached=True,
                               prompt_tokens=outcome.prompt_tokens,
                               completion_tokens=outcome.completion_tokens,
                               cost_usd=outcome.cost_usd)
            return JSONResponse(cached, headers=proxy_headers(request, outcome, cached=True))
        metrics.inc("cache_misses_total")

    # ── streaming ────────────────────────────────────────────────────────
    if stream:
        return StreamingResponse(
            _stream_response(request, body, ctx, auth.name),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                "x-aiproxy-request-id": ctx.request_id,
            },
        )

    # ── non-streaming ────────────────────────────────────────────────────
    started = time.time()
    try:
        outcome = await router.chat(body, ctx)
    except RateLimited as exc:
        raise HTTPException(429, {"message": str(exc), "type": "rate_limit_error",
                                  "code": "rate_limited"}) from exc
    except NoAccountsAvailable as exc:
        await usage.record(**ctx.base_entry(), model=model, status=503, error=str(exc))
        raise HTTPException(503, {"message": str(exc), "type": "service_unavailable",
                                  "code": "no_healthy_accounts"}) from exc
    except UpstreamFailed as exc:
        await usage.record(**ctx.base_entry(), model=model, account=exc.account,
                           status=exc.status, attempts=exc.attempts,
                           latency_ms=(time.time() - started) * 1000, error=str(exc))
        raise HTTPException(exc.status if exc.status >= 400 else 502, {
            "message": str(exc), "type": "upstream_error", "code": "upstream_error",
            "account": exc.account,
        }) from exc

    await usage.record(**ctx.base_entry(), model=chain[0], account=outcome.account,
                       status=outcome.status, attempts=outcome.attempts,
                       latency_ms=outcome.latency_ms, prompt_tokens=outcome.prompt_tokens,
                       completion_tokens=outcome.completion_tokens,
                       cost_usd=outcome.cost_usd,
                       location=(registry.get(outcome.account).location
                                 if registry.get(outcome.account) else ""))
    await usage.spend(outcome.cost_usd, registry.budget)

    if not stream and not request.headers.get("x-aiproxy-no-cache"):
        router.cache_store(body, chain[0], outcome.data)

    return JSONResponse(outcome.data, headers=proxy_headers(request, outcome))


async def _stream_response(request: Request, body: dict[str, Any], ctx: Context, key_name: str):
    try:
        async for line in router.chat_stream(body, ctx):
            yield line
    except RateLimited as exc:
        yield _error_event(str(exc), "rate_limit_error")
    except NoAccountsAvailable as exc:
        yield _error_event(str(exc), "service_unavailable")
    except UpstreamFailed as exc:
        yield _error_event(str(exc), "upstream_error")
    yield "data: [DONE]\n\n"


def _error_event(message: str, kind: str) -> str:
    return "data: " + json.dumps(
        {"error": {"message": message, "type": kind, "code": kind}}
    ) + "\n\n"


# ── embeddings ─────────────────────────────────────────────────────────────
@api.post("/v1/embeddings")
async def embeddings(request: Request, auth: AuthResult = Depends(require_key)):
    body = await read_json(request)
    model = body.get("model") or ""
    if not model:
        raise HTTPException(400, {"message": "'model' is required",
                                  "type": "invalid_request_error", "code": "missing_parameter"})
    await guard_budget(auth.name, auth.record)
    ctx = make_context(request, body, model, auth.name)
    encoding = body.get("encoding_format") or "float"

    def build(account, provider, concrete_model):
        return provider.embeddings(account, body)

    try:
        outcome = await router.passthrough(build, ctx)
    except UpstreamFailed as exc:
        raise HTTPException(exc.status or 502, {"message": str(exc), "type": "upstream_error"})
    except NoAccountsAvailable as exc:
        raise HTTPException(503, {"message": str(exc), "type": "service_unavailable"})

    account = registry.get(outcome.account)
    provider = None
    from .upstream import get_provider
    if account is not None:
        provider = get_provider(account)
        data = provider.embeddings_response(account, outcome.data, model, encoding)
    else:
        data = outcome.data

    await usage.record(**ctx.base_entry(), model=model, account=outcome.account,
                       status=outcome.status, attempts=outcome.attempts,
                       latency_ms=outcome.latency_ms, cost_usd=outcome.cost_usd)
    await usage.spend(outcome.cost_usd, registry.budget)
    return JSONResponse(data, headers=proxy_headers(request, outcome))


# ── images ─────────────────────────────────────────────────────────────────
@api.post("/v1/images/generations")
async def images(request: Request, auth: AuthResult = Depends(require_key)):
    body = await read_json(request)
    model = body.get("model") or ""
    ctx = make_context(request, body, model, auth.name)

    def build(account, provider, concrete_model):
        from .upstream import UpstreamRequest

        payload = dict(body)
        payload["model"] = concrete_model
        return UpstreamRequest(
            url=f"{account.base_url}/images/generations",
            headers=provider.auth_headers(account),
            json=payload,
        )

    try:
        outcome = await router.passthrough(build, ctx)
    except UpstreamFailed as exc:
        raise HTTPException(exc.status or 502, {"message": str(exc), "type": "upstream_error"})
    except NoAccountsAvailable as exc:
        raise HTTPException(503, {"message": str(exc), "type": "service_unavailable"})

    await usage.record(**ctx.base_entry(), model=model, account=outcome.account,
                       status=outcome.status, attempts=outcome.attempts,
                       latency_ms=outcome.latency_ms)
    return JSONResponse(outcome.data, headers=proxy_headers(request, outcome))


# ── passthrough endpoints (OpenAI-compatible upstreams only) ───────────────
@api.post("/v1/completions")
async def completions(request: Request, auth: AuthResult = Depends(require_key)):
    body = await read_json(request)
    model = body.get("model") or ""
    ctx = make_context(request, body, model, auth.name)

    def build(account, provider, concrete_model):
        from .upstream import UpstreamRequest

        if provider.name != "openai":
            raise NoAccountsAvailable(
                f"{account.name} does not implement legacy /v1/completions")
        payload = dict(body)
        payload["model"] = concrete_model
        return UpstreamRequest(url=f"{account.base_url}/completions",
                               headers=provider.auth_headers(account), json=payload)

    try:
        outcome = await router.passthrough(build, ctx)
    except UpstreamFailed as exc:
        raise HTTPException(exc.status or 502, {"message": str(exc), "type": "upstream_error"})
    except NoAccountsAvailable as exc:
        raise HTTPException(501, {"message": str(exc), "type": "not_implemented"})

    await usage.record(**ctx.base_entry(), model=model, account=outcome.account,
                       status=outcome.status, attempts=outcome.attempts,
                       latency_ms=outcome.latency_ms)
    return JSONResponse(outcome.data, headers=proxy_headers(request, outcome))


@api.post("/v1/responses")
async def responses(request: Request, auth: AuthResult = Depends(require_key)):
    body = await read_json(request)
    model = body.get("model") or ""
    ctx = make_context(request, body, model, auth.name)

    def build(account, provider, concrete_model):
        from .upstream import UpstreamRequest

        if provider.name != "openai":
            raise NoAccountsAvailable(
                f"{account.name} does not implement the Responses API")
        payload = dict(body)
        payload["model"] = concrete_model
        return UpstreamRequest(url=f"{account.base_url}/responses",
                               headers=provider.auth_headers(account), json=payload)

    try:
        outcome = await router.passthrough(build, ctx)
    except UpstreamFailed as exc:
        raise HTTPException(exc.status or 502, {"message": str(exc), "type": "upstream_error"})
    except NoAccountsAvailable as exc:
        raise HTTPException(501, {"message": str(exc), "type": "not_implemented"})

    await usage.record(**ctx.base_entry(), model=model, account=outcome.account,
                       status=outcome.status, attempts=outcome.attempts,
                       latency_ms=outcome.latency_ms)
    return JSONResponse(outcome.data, headers=proxy_headers(request, outcome))


# ── helpers ────────────────────────────────────────────────────────────────
async def read_json(request: Request) -> dict[str, Any]:
    length = request.headers.get("content-length")
    if length and int(length) > settings.max_body_bytes:
        raise HTTPException(413, {"message": "request body too large",
                                  "type": "invalid_request_error", "code": "payload_too_large"})
    raw = await request.body()
    if len(raw) > settings.max_body_bytes:
        raise HTTPException(413, {"message": "request body too large",
                                  "type": "invalid_request_error", "code": "payload_too_large"})
    try:
        body = json.loads(raw or b"{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, {"message": f"invalid JSON body: {exc}",
                                  "type": "invalid_request_error",
                                  "code": "invalid_json"}) from exc
    if not isinstance(body, dict):
        raise HTTPException(400, {"message": "request body must be a JSON object",
                                  "type": "invalid_request_error"})
    return body