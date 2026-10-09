"""Application wiring: middleware, lifespan, system routes, static dashboard."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .admin import admin as admin_router
from .api import api as api_router
from .clientpool import client_pool
from .config import DEFAULT_MASTER_KEY, VERSION, settings
from .metrics import metrics
from .registry import registry
from .security import secret_box
from .usage import new_request_id, usage

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)-22s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("aiproxy")

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


def configure_logging() -> None:
    """Optional structured JSON logs — much better when logs are shipped anywhere."""
    if not settings.log_json:
        return
    import json as _json

    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            payload = {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)),
                "level": record.levelname,
                "logger": record.name,
                "message": record.getMessage(),
            }
            if record.exc_info:
                payload["exc"] = self.formatException(record.exc_info)
            return _json.dumps(payload)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(getattr(logging, settings.log_level, logging.INFO))


async def active_probe_loop() -> None:
    """Background connectivity probe.

    Deliberately *not* "reset every account to healthy": that is what made v2's circuit
    breaker decorative. Here an account is only revived by evidence.
    """
    while True:
        await asyncio.sleep(settings.active_probe_interval)
        accounts = registry.enabled_accounts()
        if not accounts:
            continue
        from .admin import probe

        for account in accounts:
            circuit = registry.breaker.status(account.name)
            idle = time.time() - account.last_used
            if circuit == "closed" and idle < 60:
                continue
            result = await probe(account)
            if not result["ok"]:
                registry.breaker.on_failure(account.name, result.get("error") or "probe failed")


async def retention_loop() -> None:
    while True:
        await asyncio.sleep(3600)
        try:
            from .store import get_store

            cutoff = time.time() - settings.log_retention_days * 86400
            await get_store().prune_logs(cutoff)
            await usage.refresh_spend()
        except Exception as exc:
            log.warning("retention sweep failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    settings.ensure_data_dir()
    await registry.start()
    await usage.start()

    tasks = [asyncio.create_task(retention_loop())]
    if settings.active_probe:
        tasks.append(asyncio.create_task(active_probe_loop()))

    log.info("AI Proxy %s ready on http://%s:%s", VERSION, settings.host, settings.port)
    if settings.using_default_master_key:
        log.info("master key: %s  (built-in default — set PROXY_MASTER_KEY to change it)",
                 settings.master_key)
    else:
        log.info("master key: %s…  (from PROXY_MASTER_KEY)", settings.master_key[:12])
    log.info("encryption: %s", secret_box.mode)

    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await usage.stop()
        await client_pool.close()
        await registry.shutdown()
        log.info("AI Proxy stopped")


app = FastAPI(
    title="AI Proxy Server",
    version=VERSION,
    description="Unified, OpenAI-compatible proxy for multi-account AI providers.",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or new_request_id()
    request.state.request_id = request_id
    started = time.time()
    try:
        response = await call_next(request)
    except Exception:
        metrics.inc("unhandled_errors_total")
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        response = JSONResponse(status_code=500, content={
            "error": {"message": "internal server error", "type": "internal_error",
                      "code": "internal_error", "request_id": request_id}})
    response.headers["x-aiproxy-request-id"] = request_id
    response.headers["x-aiproxy-version"] = VERSION
    if request.url.path.startswith(("/v1/", "/admin/")):
        latency = (time.time() - started) * 1000
        response.headers["x-aiproxy-latency-ms"] = f"{latency:.1f}"
    return response


# ── error envelope ─────────────────────────────────────────────────────────
def error_response(status: int, message: str, kind: str, code: str,
                   request: Request | None = None, **extra: Any) -> JSONResponse:
    payload = {"message": message, "type": kind, "code": code,
               "request_id": getattr(getattr(request, "state", None), "request_id", "")}
    payload.update(extra)
    return JSONResponse(status_code=status, content={"error": payload})


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        return error_response(exc.status_code, detail.get("message", "request failed"),
                              detail.get("type", "invalid_request_error"),
                              detail.get("code", "error"), request,
                              **{k: v for k, v in detail.items()
                                 if k not in ("message", "type", "code", "request_id")})
    return error_response(exc.status_code, str(detail), "invalid_request_error",
                          str(exc.status_code), request)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", [])[1:]) or "body"
    return error_response(422, f"{field}: {first.get('msg', 'invalid value')}",
                          "invalid_request_error", "validation_error", request)


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    log.exception("unhandled error", exc_info=exc)
    return error_response(500, f"{exc.__class__.__name__}: {exc}"[:300],
                          "internal_error", "internal_error", request)


# ── system ─────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    db_ok = True
    db_latency = 0.0
    try:
        start = time.time()
        await registry.store.kv_get("__health__")
        db_latency = (time.time() - start) * 1000
    except Exception:
        db_ok = False
    return {
        "status": "ok" if db_ok else "degraded",
        "version": VERSION,
        "uptime_s": round(time.time() - metrics.started, 2),
        "accounts": registry.health_summary(),
        "db": {"ok": db_ok, "latency_ms": round(db_latency, 2)},
        "cache": registry.cache.stats(),
    }


@app.get("/ready")
async def ready():
    summary = registry.health_summary()
    if summary["healthy"] == 0:
        return JSONResponse(status_code=503, content={
            "status": "not_ready", "reason": "no healthy accounts", **summary})
    return {"status": "ready", **summary}


@app.get("/metrics")
async def prometheus_metrics():
    return PlainTextResponse(metrics.render(), media_type="text/plain; version=0.0.4")


@app.get("/")
async def root():
    if FRONTEND_DIST.exists():
        return RedirectResponse("/app/")
    return {
        "name": "AI Proxy Server",
        "version": VERSION,
        "dashboard": None if FRONTEND_DIST.exists() else "/app/ (run: npm run build)",
        "docs": "/api/docs",
        "health": "/health",
    }


app.include_router(api_router)
app.include_router(admin_router)

if FRONTEND_DIST.exists():
    @app.get("/app/", include_in_schema=False)
    async def dashboard_boot():
        """Serve the console, pre-seeding the default key so the gate clears itself.

        Only the built-in default is injected — it is a public, documented value.
        A custom PROXY_MASTER_KEY is never written into the page.
        """
        html = (FRONTEND_DIST / "index.html").read_text(encoding="utf-8")
        if settings.using_default_master_key:
            seed = (
                "<script>try{localStorage.getItem('aiproxy.api_key')||"
                f"localStorage.setItem('aiproxy.api_key','{DEFAULT_MASTER_KEY}')}}catch(e){{}}</script>"
            )
            html = html.replace("<head>", "<head>\n    " + seed, 1)
        return HTMLResponse(html)

    app.mount("/app", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="dashboard")
else:  # dev convenience: still answer /app so the SPA router does not 404
    @app.get("/app")
    @app.get("/app/{path:path}")
    async def dashboard_missing(path: str = ""):
        return PlainTextResponse(
            "Dashboard not built.\n\n  cd frontend && npm install && npm run build\n",
            status_code=503,
        )