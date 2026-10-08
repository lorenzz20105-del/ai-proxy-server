"""Advanced features: caching, cost tracking, rate limits, budgets, sessions, circuit breakers, virtual models, usage API, metrics."""
import hashlib
import json
import time
import uuid
import threading
from collections import defaultdict, deque
from typing import Optional

# ── Response Cache ─────────────────────────────────────────────────────────
_cache_lock = threading.Lock()
_cache: dict[str, dict] = {}
CACHE_TTL = 300  # 5 minutes
CACHE_MAX = 500

def cache_key(messages, model) -> str:
    raw = json.dumps({"model": model, "messages": messages}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()

def get_cached(messages, model) -> Optional[dict]:
    k = cache_key(messages, model)
    with _cache_lock:
        entry = _cache.get(k)
        if entry and time.time() - entry["ts"] < CACHE_TTL:
            entry["hits"] += 1
            return entry["response"]
        if entry:
            del _cache[k]
        return None

def set_cached(messages, model, response: dict):
    k = cache_key(messages, model)
    with _cache_lock:
        if len(_cache) >= CACHE_MAX:
            oldest = min(_cache, key=lambda k: _cache[k]["ts"])
            del _cache[oldest]
        _cache[k] = {"response": response, "ts": time.time(), "hits": 0}

def cache_stats() -> dict:
    with _cache_lock:
        total_hits = sum(e["hits"] for e in _cache.values())
        return {"entries": len(_cache), "total_hits": total_hits}

def clear_cache():
    with _cache_lock:
        _cache.clear()

# ── Cost Tracking ──────────────────────────────────────────────────────────
MODEL_PRICES = {  # per 1K tokens (input/output)
    "gpt-4o": (0.0025, 0.01),
    "gpt-4o-mini": (0.00015, 0.0006),
    "o1-preview": (0.015, 0.06),
    "claude-sonnet-4-20250514": (0.003, 0.015),
    "claude-opus-4-20250514": (0.015, 0.075),
    "gemini-2.0-flash": (0.0001, 0.0004),
    "gemini-2.5-pro": (0.00125, 0.005),
}
_cost_lock = threading.Lock()
_total_cost = 0.0
_cost_by_model: dict[str, float] = defaultdict(float)
_cost_by_account: dict[str, float] = defaultdict(float)
_cost_by_day: dict[str, float] = defaultdict(float)

def track_cost(model: str, account: str, prompt_tokens: int, completion_tokens: int) -> float:
    global _total_cost
    prices = MODEL_PRICES.get(model, (0.001, 0.002))
    input_cost = (prompt_tokens / 1000) * prices[0]
    output_cost = (completion_tokens / 1000) * prices[1]
    cost = input_cost + output_cost
    with _cost_lock:
        _total_cost += cost
        _cost_by_model[model] += cost
        _cost_by_account[account] += cost
        _cost_by_day[time.strftime("%Y-%m-%d")] += cost
    return cost

def cost_report() -> dict:
    with _cost_lock:
        return {
            "total_usd": round(_total_cost, 6),
            "by_model": {k: round(v, 6) for k, v in _cost_by_model.items()},
            "by_account": {k: round(v, 6) for k, v in _cost_by_account.items()},
            "by_day": {k: round(v, 6) for k, v in _cost_by_day.items()},
        }

# ── Rate Limiting ──────────────────────────────────────────────────────────
_rate_lock = threading.Lock()
_rate_windows: dict[str, deque] = defaultdict(lambda: deque(maxlen=1000))

def check_rate_limit(account: str, max_per_minute: int = 60) -> bool:
    now = time.time()
    with _rate_lock:
        window = _rate_windows[account]
        while window and window[0] < now - 60:
            window.popleft()
        if len(window) >= max_per_minute:
            return False
        window.append(now)
        return True

# ── Budgets ────────────────────────────────────────────────────────────────
_budget_lock = threading.Lock()
_budget_usd: float = float('inf')
_spent_usd: float = 0.0

def set_budget(usd: float):
    global _budget_usd
    with _budget_lock:
        _budget_usd = usd

def record_spend(usd: float):
    global _spent_usd
    with _budget_lock:
        _spent_usd += usd

def budget_status() -> dict:
    with _budget_lock:
        return {"budget_usd": _budget_usd if _budget_usd != float('inf') else None,
                "spent_usd": round(_spent_usd, 6),
                "remaining_usd": round(_budget_usd - _spent_usd, 6) if _budget_usd != float('inf') else None}

def is_over_budget() -> bool:
    with _budget_lock:
        return _spent_usd >= _budget_usd

# ── Session Keeping ────────────────────────────────────────────────────────
_session_lock = threading.Lock()
_session_map: dict[str, str] = {}  # session_id -> account_name

def get_session_account(session_id: str) -> Optional[str]:
    with _session_lock:
        return _session_map.get(session_id)

def bind_session(session_id: str, account_name: str):
    with _session_lock:
        _session_map[session_id] = account_name

# ── Circuit Breaker ────────────────────────────────────────────────────────
_cb_lock = threading.Lock()
_circuit_failures: dict[str, int] = defaultdict(int)
_circuit_open_until: dict[str, float] = {}

CIRCUIT_THRESHOLD = 5
CIRCUIT_RESET = 60  # seconds

def record_failure(account: str):
    with _cb_lock:
        _circuit_failures[account] += 1
        if _circuit_failures[account] >= CIRCUIT_THRESHOLD:
            _circuit_open_until[account] = time.time() + CIRCUIT_RESET

def record_success(account: str):
    with _cb_lock:
        _circuit_failures[account] = 0
        _circuit_open_until.pop(account, None)

def is_circuit_open(account: str) -> bool:
    with _cb_lock:
        until = _circuit_open_until.get(account)
        if until and time.time() < until:
            return True
        if until:
            _circuit_open_until.pop(account, None)
            _circuit_failures[account] = 0
        return False

# ── Virtual Models (aliases) ───────────────────────────────────────────────
_alias_lock = threading.Lock()
_model_aliases: dict[str, list[str]] = {}  # alias -> [real_model1, real_model2, ...]

def set_alias(alias: str, targets: list[str]):
    with _alias_lock:
        _model_aliases[alias] = targets

def resolve_model(model: str) -> str:
    """Return the first real model for an alias, or the model itself."""
    with _alias_lock:
        targets = _model_aliases.get(model)
        if targets:
            return targets[0]
        return model

def list_aliases() -> dict:
    with _alias_lock:
        return dict(_model_aliases)

# ── Usage API ──────────────────────────────────────────────────────────────
def usage_report() -> dict:
    return {
        "cost": cost_report(),
        "cache": cache_stats(),
        "budget": budget_status(),
        "aliases": list_aliases(),
        "tokens": token_report(),
        "latency": latency_report(),
        "model_usage": model_usage_report(),
    }

# ── Prometheus-style Metrics ───────────────────────────────────────────────
_metrics_lock = threading.Lock()
_request_count = 0
_error_count = 0
_cache_hits = 0

def inc_request():
    global _request_count
    with _metrics_lock:
        _request_count += 1

def inc_error():
    global _error_count
    with _metrics_lock:
        _error_count += 1

def inc_cache_hit():
    global _cache_hits
    with _metrics_lock:
        _cache_hits += 1

def prometheus_metrics() -> str:
    with _metrics_lock:
        lines = [
            f"# HELP aiproxy_requests_total Total requests",
            f"# TYPE aiproxy_requests_total counter",
            f"aiproxy_requests_total {_request_count}",
            f"# HELP aiproxy_errors_total Total errors",
            f"# TYPE aiproxy_errors_total counter",
            f"aiproxy_errors_total {_error_count}",
            f"# HELP aiproxy_cache_hits_total Cache hits",
            f"# TYPE aiproxy_cache_hits_total counter",
            f"aiproxy_cache_hits_total {_cache_hits}",
        ]
        return "\n".join(lines) + "\n"


# ── Token Usage Tracking ───────────────────────────────────────────────────
_token_lock = threading.Lock()
_tokens_by_account: dict[str, dict] = defaultdict(lambda: {"prompt": 0, "completion": 0, "total": 0})
_tokens_by_model: dict[str, dict] = defaultdict(lambda: {"prompt": 0, "completion": 0, "total": 0})

def track_tokens(account: str, model: str, prompt_tokens: int, completion_tokens: int):
    with _token_lock:
        for key, pt, ct in [(account, prompt_tokens, completion_tokens), (model, prompt_tokens, completion_tokens)]:
            target = _tokens_by_account if key == account else _tokens_by_model
            target[key]["prompt"] += pt
            target[key]["completion"] += ct
            target[key]["total"] += pt + ct

def token_report() -> dict:
    with _token_lock:
        return {
            "by_account": {k: dict(v) for k, v in _tokens_by_account.items()},
            "by_model": {k: dict(v) for k, v in _tokens_by_model.items()},
        }

# ── Latency Tracking ───────────────────────────────────────────────────────
_latency_lock = threading.Lock()
_latency_by_account: dict[str, list] = defaultdict(list)
_latency_by_model: dict[str, list] = defaultdict(list)

def track_latency(account: str, model: str, latency: float):
    with _latency_lock:
        _latency_by_account[account].append(latency)
        _latency_by_model[model].append(latency)
        # Keep last 100
        if len(_latency_by_account[account]) > 100:
            _latency_by_account[account] = _latency_by_account[account][-100:]
        if len(_latency_by_model[model]) > 100:
            _latency_by_model[model] = _latency_by_model[model][-100:]

def latency_report() -> dict:
    with _latency_lock:
        def stats(lst):
            if not lst: return None
            return {"avg": round(sum(lst)/len(lst), 3), "min": round(min(lst), 3), "max": round(max(lst), 3), "count": len(lst)}
        return {
            "by_account": {k: stats(v) for k, v in _latency_by_account.items()},
            "by_model": {k: stats(v) for k, v in _latency_by_model.items()},
        }

# ── Model Usage Stats ──────────────────────────────────────────────────────
_model_lock = threading.Lock()
_model_usage: dict[str, int] = defaultdict(int)

def track_model_usage(model: str):
    with _model_lock:
        _model_usage[model] += 1

def model_usage_report() -> dict:
    with _model_lock:
        return dict(sorted(_model_usage.items(), key=lambda x: -x[1]))
