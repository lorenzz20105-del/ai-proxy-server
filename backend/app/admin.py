"""Admin API — everything the dashboard needs."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from . import pricing
from .api import require_admin_key, router
from .clientpool import client_pool
from .config import VERSION, settings
from .metrics import metrics
from .models import AccountCreate, AccountPatch, ProviderAccount, mask_secret
from .ratelimit import rate_limiter
from .registry import registry
from .security import AuthResult, generate_key, secret_box
from .store import get_store
from .usage import export_csv, new_request_id, utc_day, usage
from .upstream import get_provider

log = logging.getLogger("aiproxy.admin")

admin = APIRouter(prefix="/admin", tags=["admin"])


# ── views ──────────────────────────────────────────────────────────────────
def account_view(account: ProviderAccount) -> dict[str, Any]:
    circuit = registry.breaker.snapshot(account.name)
    latency = metrics.account_latency(account.name)
    store = get_store()
    public = account.public()
    public.pop("proxy", None)
    return {
        "name": account.name,
        "provider_type": account.provider_type,
        "base_url": account.base_url,
        "api_key_masked": mask_secret(account.api_key),
        "has_api_key": bool(account.api_key),
        "models": account.models,
        "models_exact": account.models_exact,
        "models_deny": account.models_deny,
        "weight": account.weight,
        "priority": account.priority,
        "enabled": account.enabled,
        "rate_limit": account.rate_limit.model_dump(),
        "budget": {**account.budget.model_dump(), "spent_today_usd":
                   round(usage.spent_by_key.get(account.name, 0.0), 6)},
        "routing": account.routing.model_dump(),
        "proxy": {
            "enabled": account.proxy.enabled,
            "url_masked": mask_secret(account.proxy.url) if account.proxy.url else "",
            "configured": bool(account.proxy.url),
        },
        "location": account.location,
        "user_agent": account.user_agent,
        "extra_headers": account.extra_headers,
        "azure_api_version": account.azure_api_version,
        "aws_region": account.aws_region,
        "notes": account.notes,
        "created_ts": account.created_ts,
        "updated_ts": account.updated_ts,
        "health": {
            "circuit": circuit["circuit"],
            "consecutive_failures": circuit["consecutive_failures"],
            "cooldown_remaining": circuit["cooldown_remaining"],
            "last_error": circuit["last_error"],
            "last_error_ts": circuit["last_error_ts"],
            "last_success_ts": circuit["last_success_ts"],
            "in_flight": rate_limiter.in_flight(f"account:{account.name}"),
            "avg_latency_ms": round(latency["avg"] * 1000, 1),
            "p95_latency_ms": round(latency["p95"] * 1000, 1),
            "success_rate": account.request_count
            and round(1 - account.error_count / account.request_count, 4) or 1.0,
        },
        "counters": {
            "requests": account.request_count,
            "errors": account.error_count,
            "tokens_in": account.tokens_in,
            "tokens_out": account.tokens_out,
            "cost_usd": round(account.cost_usd, 6),
        },
        "last_used_ago": round(time.time() - account.last_used, 1) if account.last_used else None,
    }


# ── accounts ───────────────────────────────────────────────────────────────
@admin.get("/accounts")
async def list_accounts(auth: AuthResult = Depends(require_admin_key)):
    return {"accounts": [account_view(a) for a in registry.accounts.values()]}


@admin.post("/accounts", status_code=201)
async def create_account(payload: AccountCreate, auth: AuthResult = Depends(require_admin_key)):
    if registry.get(payload.name):
        raise HTTPException(409, {"message": f"account '{payload.name}' already exists",
                                  "type": "conflict", "code": "duplicate_account"})
    account = payload.to_account()
    await registry.upsert_account(account)
    await client_pool.invalidate(account)
    await usage.record(request_id=new_request_id(), kind="audit", level="info",
                       account=account.name, status=201, method="POST", path="/admin/accounts",
                       key_name=auth.name, event="account_created")
    return account_view(account)


@admin.put("/accounts/{name}")
async def update_account(name: str, patch: AccountPatch,
                         auth: AuthResult = Depends(require_admin_key)):
    existing = registry.get(name)
    if existing is None:
        raise HTTPException(404, {"message": f"account '{name}' not found",
                                  "type": "not_found", "code": "account_not_found"})

    data = patch.model_dump(exclude_none=True)
    new_name = data.pop("name", name)

    if "api_key" in data:
        data["api_key"] = data["api_key"] or existing.api_key
    else:
        data["api_key"] = existing.api_key
    if "proxy" in data:
        proxy = dict(existing.proxy.model_dump())
        incoming = data["proxy"] or {}
        if not incoming.get("url"):
            incoming["url"] = existing.proxy.url
        data["proxy"] = proxy | incoming
    else:
        data["proxy"] = existing.proxy

    merged = existing.model_dump()
    merged.update(data)
    merged["name"] = new_name
    try:
        account = ProviderAccount(**merged)
    except Exception as exc:
        raise HTTPException(422, {"message": f"invalid account: {exc}",
                                  "type": "invalid_request_error"}) from exc

    if new_name != name and registry.get(new_name):
        raise HTTPException(409, {"message": f"account '{new_name}' already exists",
                                  "type": "conflict", "code": "duplicate_account"})

    if new_name != name:
        await registry.rename_account(name, account)
        await client_pool.invalidate(existing)
        registry.breaker.reset(name)
    else:
        await registry.upsert_account(account)
    await client_pool.invalidate(account)

    await usage.record(request_id=new_request_id(), kind="audit", level="info",
                       account=new_name, status=200, method="PUT",
                       path=f"/admin/accounts/{name}", key_name=auth.name,
                       event="account_updated")
    return account_view(account)


@admin.delete("/accounts/{name}")
async def delete_account(name: str, auth: AuthResult = Depends(require_admin_key)):
    if not await registry.delete_account(name):
        raise HTTPException(404, {"message": f"account '{name}' not found",
                                  "type": "not_found", "code": "account_not_found"})
    await client_pool.invalidate(ProviderAccount(name=name))
    await usage.record(request_id=new_request_id(), kind="audit", level="warn",
                       account=name, status=200, method="DELETE",
                       path=f"/admin/accounts/{name}", key_name=auth.name,
                       event="account_deleted")
    return {"deleted": name}


@admin.post("/accounts/{name}/test")
async def test_account(name: str, auth: AuthResult = Depends(require_admin_key)):
    account = registry.get(name)
    if account is None:
        raise HTTPException(404, {"message": f"account '{name}' not found",
                                  "type": "not_found", "code": "account_not_found"})
    return await probe(account)


async def probe(account: ProviderAccount) -> dict[str, Any]:
    provider = get_provider(account)
    request = provider.probe(account)
    client = await client_pool.get(account)
    started = time.time()
    kwargs: dict[str, Any] = {"headers": request.headers}
    if request.method == "GET":
        kwargs["params"] = request.query or None
    else:
        kwargs["json"] = request.json
    try:
        response = await client.request(request.method, request.url, **kwargs)
        latency = (time.time() - started) * 1000
        ok = response.status_code < 400
        result = {
            "name": account.name,
            "ok": ok,
            "status": response.status_code,
            "latency_ms": round(latency, 1),
            "error": None if ok else _brief(response),
            "url": request.url.split("?")[0],
        }
        if ok:
            registry.breaker.on_success(account.name)
        return result
    except Exception as exc:
        return {"name": account.name, "ok": False, "status": 0,
                "latency_ms": round((time.time() - started) * 1000, 1),
                "error": f"{exc.__class__.__name__}: {exc}"[:300]}


def _brief(response: Any) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
            return str(payload["error"].get("message", ""))[:300]
        return json.dumps(payload)[:300]
    except Exception:
        return (response.text or "")[:300]


@admin.post("/accounts/{name}/reset")
async def reset_account(name: str, auth: AuthResult = Depends(require_admin_key)):
    account = registry.get(name)
    if account is None:
        raise HTTPException(404, {"message": f"account '{name}' not found",
                                  "type": "not_found"})
    registry.breaker.reset(name)
    rate_limiter.reset(f"account:{name}")
    if account:
        account.error_count = 0
    return {"status": "ok", "account": name}


# ── stats & health ─────────────────────────────────────────────────────────
@admin.get("/stats")
async def stats(auth: AuthResult = Depends(require_admin_key)):
    accounts = [account_view(a) for a in registry.accounts.values()]
    circuits = registry.breaker.all_statuses()
    total_requests = sum(a["counters"]["requests"] for a in accounts)
    total_errors = sum(a["counters"]["errors"] for a in accounts)
    return {
        "version": VERSION,
        "strategy": registry.routing["strategy"],
        "uptime_s": round(time.time() - metrics.started, 1),
        "totals": {
            "requests": total_requests,
            "errors": total_errors,
            "success_rate": round(1 - total_errors / total_requests, 4) if total_requests else 1.0,
            "tokens_in": sum(a["counters"]["tokens_in"] for a in accounts),
            "tokens_out": sum(a["counters"]["tokens_out"] for a in accounts),
            "cost_usd": round(sum(a["counters"]["cost_usd"] for a in accounts), 6),
        },
        "health": registry.health_summary(),
        "circuits": circuits,
        "ratelimits": rate_limiter.snapshot(),
        "accounts": accounts,
        "metrics": metrics.snapshot(),
    }


@admin.post("/health-check")
async def health_check(auth: AuthResult = Depends(require_admin_key)):
    results = await asyncio.gather(
        *(probe(a) for a in registry.enabled_accounts()), return_exceptions=True
    )
    return {"results": [r if isinstance(r, dict) else
                        {"name": "?", "ok": False, "error": str(r)[:200]} for r in results]}


@admin.get("/locations")
async def locations(auth: AuthResult = Depends(require_admin_key)):
    grouped: dict[str, list[str]] = {}
    for account in registry.accounts.values():
        grouped.setdefault(account.location or "default", []).append(account.name)
    return {"locations": grouped}


# ── routing ────────────────────────────────────────────────────────────────
@admin.get("/routing")
async def get_routing(auth: AuthResult = Depends(require_admin_key)):
    return registry.routing


@admin.put("/routing")
async def put_routing(patch: dict[str, Any], auth: AuthResult = Depends(require_admin_key)):
    try:
        return await registry.update_routing(patch)
    except ValueError as exc:
        raise HTTPException(422, {"message": str(exc), "type": "invalid_request_error"})


# ── aliases ────────────────────────────────────────────────────────────────
@admin.get("/aliases")
async def get_aliases(auth: AuthResult = Depends(require_admin_key)):
    return {"aliases": registry.aliases}


@admin.put("/aliases/{alias}")
async def put_alias(alias: str, payload: dict[str, Any],
                    auth: AuthResult = Depends(require_admin_key)):
    targets = payload.get("targets") or []
    if not isinstance(targets, list) or not targets:
        raise HTTPException(422, {"message": "'targets' must be a non-empty list",
                                  "type": "invalid_request_error"})
    entry = await registry.set_alias(alias, [str(t) for t in targets],
                                     str(payload.get("strategy") or "first_available"))
    return {"alias": alias, **entry}


@admin.post("/aliases")
async def post_alias(payload: dict[str, Any], auth: AuthResult = Depends(require_admin_key)):
    alias = payload.get("alias")
    if not alias:
        raise HTTPException(422, {"message": "'alias' is required",
                                  "type": "invalid_request_error"})
    return await put_alias(alias, payload, auth)


@admin.delete("/aliases/{alias}")
async def delete_alias(alias: str, auth: AuthResult = Depends(require_admin_key)):
    if not await registry.delete_alias(alias):
        raise HTTPException(404, {"message": f"alias '{alias}' not found", "type": "not_found"})
    return {"deleted": alias}


# ── budget ─────────────────────────────────────────────────────────────────
@admin.get("/budget")
async def get_budget(auth: AuthResult = Depends(require_admin_key)):
    state = usage.budget_state(registry.budget)
    return {
        "global": state,
        "alerts": [{"threshold_pct": t, "fired": float(t) in usage.alerts_fired}
                   for t in registry.budget.get("alerts") or []],
        "keys": [
            {"key": mask_secret(k.key), "name": k.name,
             "daily_usd": k.daily_usd or None,
             "spent_today_usd": round(usage.spent_by_key.get(k.name, 0.0), 6),
             "rpm": k.rpm, "tpm": k.tpm,
             "models_allow": k.models_allow, "models_deny": k.models_deny}
            for k in registry.keys.values()
        ],
    }


@admin.put("/budget")
async def put_budget(patch: dict[str, Any], auth: AuthResult = Depends(require_admin_key)):
    return await registry.update_budget(patch)


# ── usage & cache ──────────────────────────────────────────────────────────
@admin.get("/usage")
async def get_usage(range: str = Query("24h"), auth: AuthResult = Depends(require_admin_key)):
    return await usage.report(range, registry)


@admin.get("/cache")
async def get_cache(auth: AuthResult = Depends(require_admin_key)):
    return registry.cache.stats()


@admin.delete("/cache")
async def clear_cache(auth: AuthResult = Depends(require_admin_key)):
    cleared = registry.cache.clear()
    registry.cache.reset_stats()
    return {"cleared": cleared}


@admin.get("/pricing")
async def get_pricing(auth: AuthResult = Depends(require_admin_key)):
    return {"prices": pricing.get_pricing_table(),
            "overrides": pricing.price_overrides.as_dict()}


@admin.post("/pricing")
async def set_pricing(payload: dict[str, Any], auth: AuthResult = Depends(require_admin_key)):
    from .pricing import Price

    model = payload.get("model")
    if not model:
        raise HTTPException(422, {"message": "'model' is required",
                                  "type": "invalid_request_error"})
    price = Price(input=float(payload.get("input_per_1m", 0)),
                  output=float(payload.get("output_per_1m", 0)),
                  cached_input=payload.get("cached_input_per_1m"))
    pricing.price_overrides.set(model, price)
    return {"model": model, **price.as_dict()}


@admin.delete("/pricing/{model}")
async def delete_pricing(model: str, auth: AuthResult = Depends(require_admin_key)):
    pricing.price_overrides.remove(model)
    return {"deleted": model}


# ── logs ───────────────────────────────────────────────────────────────────
@admin.get("/logs")
async def get_logs(
    limit: int = Query(200, ge=1, le=5000),
    account: str = "",
    model: str = "",
    status: str = "",
    kind: str = "",
    level: str = "",
    since: float = 0.0,
    search: str = "",
    source: str = "memory",
    auth: AuthResult = Depends(require_admin_key),
):
    if source == "memory":
        entries = [e for e in usage.ring if _matches(e, account, model, status, kind, level,
                                                     since, search)]
        total = len(entries)
        entries = list(reversed(entries))[:limit]
    else:
        entries, total = await get_store().query_logs(
            limit=limit, account=account, model=model, status=status, kind=kind,
            level=level, since=since, search=search)
    return {"logs": entries, "total": total}


def _matches(entry: dict, account: str, model: str, status: str, kind: str, level: str,
             since: float, search: str) -> bool:
    if account and entry.get("account") != account:
        return False
    if model and entry.get("model") != model:
        return False
    if kind and entry.get("kind") != kind:
        return False
    if level and entry.get("level") != level:
        return False
    if since and (entry.get("ts") or 0) < since:
        return False
    if status:
        code = entry.get("status") or 0
        if status.isdigit():
            if code != int(status):
                return False
        elif code // 100 != int(status) // 100:
            return False
    if search and search.lower() not in json.dumps(entry, default=str).lower():
        return False
    return True


@admin.get("/logs/stream")
async def stream_logs(level: str = "all", auth: AuthResult = Depends(require_admin_key)):
    levels = {"info", "warn", "error"} if level == "all" else {level}

    async def events():
        queue = usage.subscribe()
        try:
            async for entry in usage.stream(queue, levels):
                if entry.get("__heartbeat__"):
                    yield ": ping\n\n"
                else:
                    yield f"event: log\ndata: {json.dumps(entry, default=str)}\n\n"
        finally:
            usage.unsubscribe(queue)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@admin.delete("/logs")
async def clear_logs(auth: AuthResult = Depends(require_admin_key)):
    deleted = await get_store().clear_logs()
    usage.ring.clear()
    return {"deleted": deleted}


@admin.get("/export.csv")
async def export_logs_csv(auth: AuthResult = Depends(require_admin_key)):
    entries = list(usage.ring)
    return PlainTextResponse(await export_csv(entries), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=aiproxy-logs.csv"})


@admin.get("/export.json")
async def export_logs_json(auth: AuthResult = Depends(require_admin_key)):
    return JSONResponse(list(usage.ring), headers={
        "Content-Disposition": "attachment; filename=aiproxy-logs.json"})


# ── keys ───────────────────────────────────────────────────────────────────
@admin.get("/keys")
async def list_keys(auth: AuthResult = Depends(require_admin_key)):
    return {"keys": [k.public() for k in registry.keys.values()]}


@admin.post("/keys", status_code=201)
async def create_key(payload: dict[str, Any], auth: AuthResult = Depends(require_admin_key)):
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(422, {"message": "'name' is required",
                                  "type": "invalid_request_error"})
    record = await registry.create_key(
        name,
        enabled=bool(payload.get("enabled", True)),
        daily_usd=float(payload.get("daily_usd") or 0),
        rpm=int(payload.get("rpm") or 0),
        tpm=int(payload.get("tpm") or 0),
        models_allow=payload.get("models_allow") or None,
        models_deny=payload.get("models_deny") or None,
        admin=bool(payload.get("admin", False)),
    )
    return record.public() | {"key": record.key}


@admin.delete("/keys/{key}")
async def delete_key(key: str, auth: AuthResult = Depends(require_admin_key)):
    if not await registry.delete_key(key):
        raise HTTPException(404, {"message": "key not found", "type": "not_found"})
    return {"deleted": True}


@admin.patch("/keys/{key}")
async def patch_key(key: str, payload: dict[str, Any],
                    auth: AuthResult = Depends(require_admin_key)):
    record = await registry.update_key(key, **payload)
    if record is None:
        raise HTTPException(404, {"message": "key not found", "type": "not_found"})
    return record.public()


# ── config ─────────────────────────────────────────────────────────────────
@admin.get("/config")
async def get_config(auth: AuthResult = Depends(require_admin_key)):
    return {
        "version": VERSION,
        "data_dir": settings.data_path_str(),
        "db": "sqlite",
        "encryption": secret_box.mode,
        "master_key_masked": mask_secret(settings.master_key),
        "server": {
            "host": settings.host,
            "port": settings.port,
            "request_timeout_s": settings.request_timeout,
            "stream_timeout_s": settings.stream_timeout,
        },
        "limits": {
            "max_body_bytes": settings.max_body_bytes,
            "max_concurrency": settings.max_concurrency,
        },
        "cors": {"origins": settings.cors_origins},
        "features": {
            "cache": registry.routing["cache"]["enabled"],
            "retry": registry.routing["retry"]["max_attempts"] > 1,
            "circuit_breaker": True,
            "budget": float(registry.budget.get("daily_usd") or 0) > 0,
            "active_probe": settings.active_probe,
            "usage_accounting": settings.usage_accounting,
        },
        "environment": {
            k: v for k, v in sorted(settings.to_dict().items())
            if not k.endswith("_key") and "master" not in k
        },
    }


@admin.put("/config")
async def put_config(patch: dict[str, Any], auth: AuthResult = Depends(require_admin_key)):
    applied: dict[str, Any] = {}
    if "cache" in patch:
        await registry.update_routing({"cache": patch["cache"]})
        applied["cache"] = registry.routing["cache"]
    if "cors" in patch and isinstance(patch["cors"], dict):
        origins = patch["cors"].get("origins") or ["*"]
        settings.cors_origins = [str(o) for o in origins]
        applied["cors"] = {"origins": settings.cors_origins}
    for key, attribute in (("max_body_bytes", "max_body_bytes"),
                           ("request_timeout_s", "request_timeout"),
                           ("stream_timeout_s", "stream_timeout"),
                           ("max_concurrency", "max_concurrency")):
        if key in patch and patch[key] is not None:
            setattr(settings, attribute, type(getattr(settings, attribute))(patch[key]))
            applied[key] = getattr(settings, attribute)
    return {"applied": applied, "config": await get_config(auth)}