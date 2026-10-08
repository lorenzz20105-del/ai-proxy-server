"""
AI Provider Proxy Server — unified API with per-account egress proxying.
"""
import asyncio
import collections
import json
import os
import random
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, Header, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, JSONResponse

from features import (
    get_cached, set_cached, cache_stats, clear_cache,
    track_cost, cost_report, check_rate_limit, set_budget, record_spend,
    budget_status, is_over_budget, get_session_account, bind_session,
    record_failure, record_success, is_circuit_open, set_alias,
    resolve_model, list_aliases, usage_report, inc_request, inc_error,
    inc_cache_hit, prometheus_metrics,
    track_tokens, track_latency, track_model_usage,
)

from config import (
    MASTER_API_KEY,
    ROUTING_STRATEGY,
    ACCOUNTS,
    CONFIG_FILE,
    LOGS_FILE,
    ProviderAccount,
)

MAX_LOGS = 1000
request_logs: list[dict] = []

def add_log(entry: dict):
    entry.setdefault("id", uuid.uuid4().hex[:12])
    request_logs.append(entry)
    if len(request_logs) > MAX_LOGS:
        request_logs.pop(0)
    try:
        Path(LOGS_FILE).write_text(json.dumps(request_logs[-200:], indent=2, default=str))
    except Exception:
        pass

# ── State ──────────────────────────────────────────────────────────────────
class ProxyState:
    def __init__(self):
        self.accounts: list[ProviderAccount] = []
        self.strategy: str = ROUTING_STRATEGY
        self._lock = asyncio.Lock()
        self._rr_index = 0
        self._load()

    def _load(self):
        if Path(CONFIG_FILE).exists():
            try:
                data = json.loads(Path(CONFIG_FILE).read_text())
                self.accounts = [ProviderAccount(**a) for a in data.get("accounts", [])]
                self.strategy = data.get("strategy", self.strategy)
                return
            except Exception:
                pass
        self.accounts = list(ACCOUNTS)

    def save(self):
        Path(CONFIG_FILE).write_text(json.dumps({
            "accounts": [a.model_dump() for a in self.accounts],
            "strategy": self.strategy,
        }, indent=2))

    async def pick_account(self, model: Optional[str] = None) -> Optional[ProviderAccount]:
        async with self._lock:
            enabled = [a for a in self.accounts if a.enabled and a.healthy]
            if model:
                enabled = [a for a in enabled if model in a.models or not a.models]
            if not enabled:
                return None

            if self.strategy == "round_robin":
                acct = enabled[self._rr_index % len(enabled)]
                self._rr_index += 1
            elif self.strategy == "weighted":
                pool = []
                for a in enabled:
                    pool.extend([a] * max(1, a.weight))
                acct = random.choice(pool)
            elif self.strategy == "failover":
                acct = enabled[0]
            else:  # random
                acct = random.choice(enabled)

            acct.request_count += 1
            acct.last_used = time.time()
            return acct

    def mark_unhealthy(self, name: str):
        for a in self.accounts:
            if a.name == name:
                a.healthy = False
                a.error_count += 1
                break

    def reset_health(self):
        for a in self.accounts:
            a.healthy = True

    def get(self, name: str) -> Optional[ProviderAccount]:
        for a in self.accounts:
            if a.name == name:
                return a
        return None

state = ProxyState()

# ── Auth ───────────────────────────────────────────────────────────────────
async def verify_key(x_api_key: str = Header(default="")):
    if x_api_key != MASTER_API_KEY:
        raise HTTPException(401, "Invalid API key")
    return x_api_key

# ── Lifespan ───────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    async def health_loop():
        while True:
            await asyncio.sleep(120)
            state.reset_health()
    task = asyncio.create_task(health_loop())
    yield
    task.cancel()

app = FastAPI(title="AI Provider Proxy", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Helper: build httpx client with optional per-account proxy ────────────
def client_for(account: ProviderAccount, timeout: float = 120.0) -> httpx.AsyncClient:
    kwargs: dict[str, Any] = {"timeout": timeout}
    if account.proxy_url:
        kwargs["proxy"] = account.proxy_url
    return httpx.AsyncClient(**kwargs)

def headers_for(account: ProviderAccount, api_key_header: str = "Authorization") -> dict:
    h = {"Content-Type": "application/json"}
    if account.provider_type == "claude":
        h["x-api-key"] = account.api_key
        h["anthropic-version"] = "2023-06-01"
    elif account.provider_type == "google":
        pass  # key in query param
    else:
        h["Authorization"] = f"Bearer {account.api_key}"
    if account.user_agent:
        h["User-Agent"] = account.user_agent
    return h

# ── Admin API ──────────────────────────────────────────────────────────────
@app.get("/admin/accounts", dependencies=[Depends(verify_key)])
async def list_accounts():
    return {"accounts": [a.model_dump() for a in state.accounts]}

@app.post("/admin/accounts", dependencies=[Depends(verify_key)])
async def add_account(account: ProviderAccount):
    if state.get(account.name):
        raise HTTPException(409, f"Account '{account.name}' already exists")
    state.accounts.append(account)
    state.save()
    add_log({"event": "account_added", "account": account.name, "timestamp": time.time()})
    return {"status": "ok"}

@app.put("/admin/accounts/{name}", dependencies=[Depends(verify_key)])
async def update_account(name: str, updated: ProviderAccount):
    for i, a in enumerate(state.accounts):
        if a.name == name:
            state.accounts[i] = updated
            state.save()
            return {"status": "ok"}
    raise HTTPException(404, "Account not found")

@app.delete("/admin/accounts/{name}", dependencies=[Depends(verify_key)])
async def delete_account(name: str):
    state.accounts = [a for a in state.accounts if a.name != name]
    state.save()
    return {"status": "ok"}

@app.get("/admin/stats", dependencies=[Depends(verify_key)])
async def get_stats():
    return {
        "strategy": state.strategy,
        "accounts": [
            {
                "name": a.name,
                "enabled": a.enabled,
                "healthy": a.healthy,
                "requests": a.request_count,
                "errors": a.error_count,
                "success_rate": round((a.request_count - a.error_count) / max(a.request_count, 1) * 100, 1),
                "last_used_ago": int(time.time() - a.last_used) if a.last_used > 0 else None,
                "models": a.models,
                "provider_type": a.provider_type,
                "location": a.location,
                "proxy_url": a.proxy_url,
            }
            for a in state.accounts
        ],
    }

@app.put("/admin/strategy", dependencies=[Depends(verify_key)])
async def set_strategy(strategy: str):
    if strategy not in ("round_robin", "failover", "weighted", "random"):
        raise HTTPException(400, "Invalid strategy")
    state.strategy = strategy
    state.save()
    return {"status": "ok", "strategy": strategy}

@app.get("/admin/key", dependencies=[Depends(verify_key)])
async def get_master_key():
    return {"api_key": MASTER_API_KEY}

@app.get("/admin/logs", dependencies=[Depends(verify_key)])
async def get_logs(limit: int = 100):
    return {"logs": request_logs[-limit:][::-1]}

@app.delete("/admin/logs", dependencies=[Depends(verify_key)])
async def clear_logs():
    request_logs.clear()
    return {"status": "ok"}


@app.get("/admin/logs/account/{name}", dependencies=[Depends(verify_key)])
async def get_logs_by_account(name: str, limit: int = 100):
    filtered = [l for l in request_logs if l.get("account") == name]
    return {"logs": filtered[-limit:][::-1]}

@app.get("/admin/logs/model/{model}", dependencies=[Depends(verify_key)])
async def get_logs_by_model(model: str, limit: int = 100):
    filtered = [l for l in request_logs if l.get("model") == model]
    return {"logs": filtered[-limit:][::-1]}

@app.get("/admin/export-logs", dependencies=[Depends(verify_key)])
async def export_logs():
    import io, csv
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["time", "model", "account", "location", "status", "latency", "stream"])
    for l in request_logs:
        w.writerow([
            time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(l.get("timestamp", 0))),
            l.get("model", ""), l.get("account", ""), l.get("location", ""),
            l.get("status", ""), l.get("latency", ""), l.get("stream", ""),
        ])
    return JSONResponse(content=buf.getvalue(), media_type="text/csv")

@app.get("/admin/locations", dependencies=[Depends(verify_key)])
async def list_locations():
    locations = {}
    for a in state.accounts:
        loc = a.location or "default"
        locations.setdefault(loc, []).append(a.name)
    return {"locations": locations}



@app.post("/admin/health-check", dependencies=[Depends(verify_key)])
async def health_check():
    """Test connectivity to all accounts."""
    results = []
    for a in state.accounts:
        if not a.enabled:
            results.append({"name": a.name, "status": "disabled"})
            continue
        try:
            async with client_for(a, 10.0) as client:
                if a.provider_type == "google":
                    url = f"{a.base_url}/models?key={a.api_key}"
                    resp = await client.get(url)
                elif a.provider_type == "claude":
                    url = f"{a.base_url}/messages"
                    resp = await client.post(url, json={"model": a.models[0] if a.models else "claude-3-sonnet-20240229", "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]})
                else:
                    url = f"{a.base_url}/models"
                    resp = await client.get(url)
                results.append({"name": a.name, "status": "ok" if resp.status_code < 400 else f"error_{resp.status_code}", "status_code": resp.status_code})
        except Exception as e:
            results.append({"name": a.name, "status": "unreachable", "error": str(e)[:100]})
    return {"results": results}

@app.get("/admin/usage", dependencies=[Depends(verify_key)])
async def get_usage():
    return usage_report()

@app.get("/admin/cache", dependencies=[Depends(verify_key)])
async def get_cache_stats():
    return cache_stats()

@app.delete("/admin/cache", dependencies=[Depends(verify_key)])
async def clear_cache_endpoint():
    clear_cache()
    return {"status": "ok"}

@app.put("/admin/budget", dependencies=[Depends(verify_key)])
async def set_budget_endpoint(usd: float):
    set_budget(usd)
    return {"status": "ok", "budget_usd": usd}

@app.get("/admin/budget", dependencies=[Depends(verify_key)])
async def get_budget():
    return budget_status()

@app.post("/admin/alias", dependencies=[Depends(verify_key)])
async def create_alias(alias: str, targets: list[str]):
    set_alias(alias, targets)
    return {"status": "ok", "alias": alias, "targets": targets}

@app.get("/admin/aliases", dependencies=[Depends(verify_key)])
async def get_aliases():
    return {"aliases": list_aliases()}

@app.get("/admin/metrics", dependencies=[Depends(verify_key)])
async def get_metrics():
    return JSONResponse(content=prometheus_metrics(), media_type="text/plain")

@app.get("/metrics")
async def public_metrics():
    return JSONResponse(content=prometheus_metrics(), media_type="text/plain")

# ── OpenAI-compatible endpoints ────────────────────────────────────────────
@app.get("/v1/models", dependencies=[Depends(verify_key)])
async def list_models():
    all_models = set()
    for a in state.accounts:
        if a.enabled:
            all_models.update(a.models)
    return {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "proxy"} for m in sorted(all_models)]}

@app.post("/v1/chat/completions", dependencies=[Depends(verify_key)])
async def chat_completions(request: Request):
    body = await request.json()
    model = body.get("model", "")
    stream = body.get("stream", False)
    inc_request()

    if is_over_budget():
        raise HTTPException(429, "Budget exceeded")

    # Resolve virtual model alias
    real_model = resolve_model(model)

    # Session pinning
    session_id = request.headers.get("x-session-id")
    if session_id:
        pinned = get_session_account(session_id)
        if pinned:
            account = state.get(pinned)
            if not account or not account.healthy:
                account = await state.pick_account(real_model)
            if account:
                bind_session(session_id, account.name)
        else:
            account = await state.pick_account(real_model)
            if account:
                bind_session(session_id, account.name)
    else:
        account = await state.pick_account(real_model)

    if not account:
        raise HTTPException(503, "No healthy accounts available")

    # Circuit breaker check
    if is_circuit_open(account.name):
        account = await state.pick_account(real_model)
        if not account or is_circuit_open(account.name):
            raise HTTPException(503, "All circuits open")

    # Rate limit
    if not check_rate_limit(account.name):
        raise HTTPException(429, f"Rate limit exceeded for {account.name}")

    # Cache check (non-streaming only)
    messages = body.get("messages", [])
    if not stream and messages:
        cached = get_cached(messages, real_model)
        if cached:
            inc_cache_hit()
            add_log({"timestamp": time.time(), "model": model, "account": "cache", "status": 200, "latency": 0.0, "stream": False, "cached": True})
            return JSONResponse(content=cached)

    # Replace model in body with real model
    body["model"] = real_model

    if account.provider_type == "claude":
        upstream_url = f"{account.base_url}/messages"
    elif account.provider_type == "google":
        upstream_url = f"{account.base_url}/models/{model}:generateContent?key={account.api_key}"
    else:
        upstream_url = f"{account.base_url}/chat/completions"

    headers = headers_for(account)
    start = time.time()

    try:
        async with client_for(account) as client:
            if stream:
                async def stream_gen() -> AsyncGenerator[str, None]:
                    async with client.stream("POST", upstream_url, json=body, headers=headers) as resp:
                        async for chunk in resp.aiter_text():
                            yield chunk
                    add_log({"timestamp": start, "model": model, "account": account.name,
                             "status": 200, "latency": round(time.time() - start, 2), "stream": True,
                             "location": account.location})
                return StreamingResponse(stream_gen(), media_type="text/event-stream")
            else:
                resp = await client.post(upstream_url, json=body, headers=headers)
                resp_data = resp.json()
                add_log({"timestamp": start, "model": model, "account": account.name,
                         "status": resp.status_code, "latency": round(time.time() - start, 2), "stream": False,
                         "location": account.location})
                # Cache successful responses
                if resp.status_code == 200 and messages:
                    set_cached(messages, real_model, resp_data)
                # Track cost
                usage = resp_data.get("usage", {})
                if usage:
                    pt = usage.get("prompt_tokens", 0)
                    ct = usage.get("completion_tokens", 0)
                    cost = track_cost(real_model, account.name, pt, ct)
                    record_spend(cost)
                    track_tokens(account.name, real_model, pt, ct)
                track_latency(account.name, real_model, time.time() - start)
                track_model_usage(real_model)
                record_success(account.name)
                return JSONResponse(content=resp_data, status_code=resp.status_code)
    except Exception as e:
        state.mark_unhealthy(account.name)
        record_failure(account.name)
        inc_error()
        add_log({"timestamp": start, "model": model, "account": account.name,
                 "status": 502, "error": str(e), "stream": stream, "location": account.location})
        raise HTTPException(502, f"Upstream error: {e}")

@app.post("/v1/embeddings", dependencies=[Depends(verify_key)])
async def embeddings(request: Request):
    body = await request.json()
    account = await state.pick_account()
    if not account:
        raise HTTPException(503, "No healthy accounts available")

    upstream_url = f"{account.base_url}/embeddings"
    headers = headers_for(account)
    start = time.time()

    try:
        async with client_for(account, 60.0) as client:
            resp = await client.post(upstream_url, json=body, headers=headers)
            track_model_usage(body.get("model", "unknown"))
            add_log({"timestamp": start, "model": body.get("model", "?"), "account": account.name,
                     "status": resp.status_code, "latency": round(time.time() - start, 2), "endpoint": "embeddings",
                     "location": account.location})
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as e:
        state.mark_unhealthy(account.name)
        add_log({"timestamp": start, "model": body.get("model", "?"), "account": account.name,
                 "status": 502, "error": str(e), "endpoint": "embeddings", "location": account.location})
        raise HTTPException(502, f"Upstream error: {e}")

@app.post("/v1/images/generations", dependencies=[Depends(verify_key)])
async def image_generations(request: Request):
    body = await request.json()
    account = await state.pick_account()
    if not account:
        raise HTTPException(503, "No healthy accounts available")

    upstream_url = f"{account.base_url}/images/generations"
    headers = headers_for(account)
    start = time.time()

    try:
        async with client_for(account) as client:
            resp = await client.post(upstream_url, json=body, headers=headers)
            track_model_usage(body.get("model", "unknown"))
            add_log({"timestamp": start, "model": body.get("model", "?"), "account": account.name,
                     "status": resp.status_code, "latency": round(time.time() - start, 2), "endpoint": "images",
                     "location": account.location})
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as e:
        state.mark_unhealthy(account.name)
        add_log({"timestamp": start, "model": body.get("model", "?"), "account": account.name,
                 "status": 502, "error": str(e), "endpoint": "images", "location": account.location})
        raise HTTPException(502, f"Upstream error: {e}")

@app.get("/health")
async def health():
    healthy = sum(1 for a in state.accounts if a.healthy and a.enabled)
    return {"status": "ok", "healthy_accounts": healthy, "total_accounts": len(state.accounts)}

# ── Serve React frontend ──────────────────────────────────────────────────
_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/app", StaticFiles(directory=str(_dist), html=True), name="app")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
