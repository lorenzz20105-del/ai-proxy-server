"""Usage accounting and the live log feed.

Every request produces exactly one log entry, which is:
  * appended to a bounded in-memory ring (the live feed and the export),
  * written to SQLite in batches (never one file rewrite per request),
  * folded into hourly/daily usage rollups,
  * fanned out to any `/admin/logs/stream` subscribers.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict, deque
from typing import Any, AsyncIterator

from .config import settings
from .store import get_store

log = logging.getLogger("aiproxy.usage")

MAX_RING = 2000
FLUSH_INTERVAL = 2.0


def new_request_id() -> str:
    return uuid.uuid4().hex[:12]


def utc_day(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts if ts is not None else time.time()))


def hour_bucket(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(ts if ts is not None else time.time()))


class UsageTracker:
    def __init__(self) -> None:
        self.ring: deque[dict[str, Any]] = deque(maxlen=MAX_RING)
        self._pending: list[dict[str, Any]] = []
        self._subscribers: set[asyncio.Queue] = set()
        self._flush_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

        # spend tracking, refreshed from the DB rather than kept forever in RAM
        self.spent_today = 0.0
        self.spent_month = 0.0
        self.spent_by_key: dict[str, float] = {}
        self.alerts_fired: set[float] = set()

    # ── lifecycle ─────────────────────────────────────────────────────────
    async def start(self) -> None:
        await self.refresh_spend()
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def stop(self) -> None:
        if self._flush_task:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
        await self.flush()

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            try:
                await self.flush()
            except Exception as exc:
                log.warning("usage flush failed: %s", exc)

    async def flush(self) -> None:
        async with self._lock:
            batch, self._pending = self._pending, []
        if batch:
            try:
                await get_store().add_logs(batch)
            except Exception as exc:
                log.warning("log persist failed: %s", exc)

    # ── recording ─────────────────────────────────────────────────────────
    async def record(
        self,
        *,
        request_id: str,
        method: str = "",
        path: str = "",
        model: str = "",
        requested_model: str = "",
        account: str = "",
        key_name: str = "",
        session_id: str = "",
        status: int = 0,
        attempts: int = 1,
        latency_ms: float = 0.0,
        ttft_ms: float | None = None,
        stream: bool = False,
        cached: bool = False,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        cost_usd: float = 0.0,
        error: str | None = None,
        location: str = "",
        kind: str = "request",
        level: str = "info",
        ts: float | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        now = ts if ts is not None else time.time()
        if error and level == "info":
            level = "error" if status >= 500 else "warn"
        entry = {
            "id": request_id,
            "ts": now,
            "kind": kind,
            "level": level,
            "method": method,
            "path": path,
            "model": model,
            "requested_model": requested_model or model,
            "account": account,
            "key_name": key_name,
            "session_id": session_id,
            "status": status,
            "attempts": attempts,
            "latency_ms": round(latency_ms, 2),
            "ttft_ms": round(ttft_ms, 2) if ttft_ms is not None else None,
            "stream": stream,
            "cached": cached,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "cost_usd": round(cost_usd, 8),
            "error": error,
            "location": location,
            **extra,
        }

        self.ring.append(entry)
        async with self._lock:
            self._pending.append(entry)
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(entry)
            except asyncio.QueueFull:
                pass

        if settings.usage_accounting:
            await get_store().bump_usage(
                bucket=hour_bucket(now), day=utc_day(now), account=account, model=model,
                key_name=key_name or "master", requests=1,
                errors=1 if status >= 400 else 0, cached=1 if cached else 0,
                tokens_in=prompt_tokens, tokens_out=completion_tokens,
                cost_usd=cost_usd, latency=latency_ms / 1000.0,
            )
        return entry

    # ── budgets ───────────────────────────────────────────────────────────
    async def refresh_spend(self) -> None:
        store = get_store()
        today = utc_day()
        self.spent_today, self.spent_month = await store.daily_cost_since(today)
        self.spent_by_key = await store.daily_cost_by_key(today)

    async def spend(self, cost_usd: float, budget: dict[str, Any]) -> None:
        self.spent_today += cost_usd
        self.spent_month += cost_usd
        daily = float(budget.get("daily_usd") or 0)
        if daily > 0:
            pct = self.spent_today / daily * 100
            for threshold in budget.get("alerts") or []:
                if pct >= float(threshold) and float(threshold) not in self.alerts_fired:
                    self.alerts_fired.add(float(threshold))
                    log.warning("budget alert: %.0f%% of the $%.2f daily budget used "
                                "($%.4f spent)", pct, daily, self.spent_today)

    def budget_state(self, budget: dict[str, Any], key_name: str = "master",
                     key_limit: float = 0.0) -> dict[str, Any]:
        daily = float(budget.get("daily_usd") or 0)
        monthly = float(budget.get("monthly_usd") or 0)
        key_spend = self.spent_by_key.get(key_name, 0.0)
        remaining = None
        if daily > 0:
            remaining = round(max(0.0, daily - self.spent_today), 6)
        return {
            "daily_usd": daily or None,
            "monthly_usd": monthly or None,
            "spent_today_usd": round(self.spent_today, 6),
            "spent_month_usd": round(self.spent_month, 6),
            "remaining_today_usd": remaining,
            "hard_stop": bool(budget.get("hard_stop", True)),
            "window_utc": utc_day(),
            "over_daily": bool(daily > 0 and self.spent_today >= daily),
            "over_monthly": bool(monthly > 0 and self.spent_month >= monthly),
            "key_spent_usd": round(key_spend, 6),
            "key_over": bool(key_limit > 0 and key_spend >= key_limit),
        }

    def budget_blocked(self, key_name: str = "master", key_limit: float = 0.0) -> str:
        if key_limit > 0 and self.spent_by_key.get(key_name, 0.0) >= key_limit:
            return f"daily budget for API key '{key_name}' exhausted"
        return ""

    # ── reports ───────────────────────────────────────────────────────────
    async def report(self, range_name: str = "24h", registry: Any = None) -> dict[str, Any]:
        seconds, bucket_width = _range_to_seconds(range_name)
        now = time.time()
        since_bucket = time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(now - seconds))
        since_day = utc_day(now - seconds)
        hourly, daily = await get_store().usage_rollups(since_bucket, since_day)
        rows = hourly if bucket_width <= 3600 else _collapse_daily(hourly, bucket_width)

        timeline: dict[str, dict[str, Any]] = {}
        by_account: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"requests": 0, "errors": 0, "cached": 0, "tokens_in": 0,
                     "tokens_out": 0, "cost_usd": 0.0, "latency_sum": 0.0}
        )
        by_model: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"requests": 0, "errors": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}
        )
        by_key: dict[str, dict[str, Any]] = defaultdict(
            lambda: {"requests": 0, "cost_usd": 0.0}
        )

        totals = {"requests": 0, "errors": 0, "cached": 0, "tokens_in": 0,
                  "tokens_out": 0, "cost_usd": 0.0, "latency_sum": 0.0}

        for row in rows:
            bucket = timeline.setdefault(row["bucket"], {
                "bucket": row["bucket"], "requests": 0, "errors": 0, "cost_usd": 0.0,
                "tokens_in": 0, "tokens_out": 0,
            })
            for target in (bucket, totals):
                target["requests"] += row["requests"]
                target["errors"] += row["errors"]
                target["cost_usd"] += row["cost_usd"]
                target["tokens_in"] += row["tokens_in"]
                target["tokens_out"] += row["tokens_out"]
            bucket.setdefault("cached", 0)
            totals["latency_sum"] += row.get("latency_sum") or 0.0

            account = row["account"] or "unknown"
            acc = by_account[account]
            acc["requests"] += row["requests"]
            acc["errors"] += row["errors"]
            acc["cached"] += row["cached"]
            acc["tokens_in"] += row["tokens_in"]
            acc["tokens_out"] += row["tokens_out"]
            acc["cost_usd"] += row["cost_usd"]
            acc["latency_sum"] += row.get("latency_sum") or 0.0

            model = row["model"] or "unknown"
            mod = by_model[model]
            mod["requests"] += row["requests"]
            mod["errors"] += row["errors"]
            mod["tokens_in"] += row["tokens_in"]
            mod["tokens_out"] += row["tokens_out"]
            mod["cost_usd"] += row["cost_usd"]

            key_entry = by_key[row["key_name"] or "master"]
            key_entry["requests"] += row["requests"]
            key_entry["cost_usd"] += row["cost_usd"]

        from .metrics import metrics

        latency = metrics.histograms["request_latency_seconds"].snapshot()
        requests = totals["requests"] or 0
        hits = metrics.counters.get("cache_hits_total", 0)
        misses = metrics.counters.get("cache_misses_total", 0)

        account_rows = []
        for name, data in by_account.items():
            count = data["requests"] or 1
            account_rows.append({
                "name": name,
                "requests": data["requests"],
                "errors": data["errors"],
                "cached": data["cached"],
                "cost_usd": round(data["cost_usd"], 6),
                "tokens_in": data["tokens_in"],
                "tokens_out": data["tokens_out"],
                "success_rate": round(1 - data["errors"] / count, 4),
                "avg_latency_ms": round(data["latency_sum"] / count * 1000, 2),
                "circuit": (registry.breaker.status(name) if registry else "unknown"),
            })

        return {
            "range": range_name,
            "totals": {
                "requests": requests,
                "errors": totals["errors"],
                "success_rate": round(1 - totals["errors"] / requests, 4) if requests else 1.0,
                "tokens_in": totals["tokens_in"],
                "tokens_out": totals["tokens_out"],
                "cost_usd": round(totals["cost_usd"], 6),
                "cached_requests": totals["cached"],
                "cache_hit_rate": round(hits / (hits + misses), 4) if hits + misses else 0.0,
                "avg_latency_ms": latency["avg_ms"],
                "p95_latency_ms": latency["p95_ms"],
            },
            "timeline": [timeline[key] for key in sorted(timeline)],
            "by_account": sorted(account_rows, key=lambda r: -r["requests"]),
            "by_model": [
                {"model": name, **{k: (round(v, 6) if isinstance(v, float) else v)
                                   for k, v in data.items()}}
                for name, data in sorted(by_model.items(), key=lambda kv: -kv[1]["requests"])
            ],
            "by_key": [{"name": name, **data} for name, data in by_key.items()],
        }

    # ── live feed ─────────────────────────────────────────────────────────
    def subscribe(self, maxsize: int = 500) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    async def stream(self, queue: asyncio.Queue, levels: set[str]) -> AsyncIterator[dict]:
        try:
            while True:
                try:
                    entry = await asyncio.wait_for(queue.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    yield {"__heartbeat__": True}
                    continue
                if entry.get("level") in levels or "all" in levels:
                    yield entry
        finally:
            self.unsubscribe(queue)


def _range_to_seconds(range_name: str) -> tuple[float, int]:
    return {
        "1h": (3600, 300),
        "6h": (6 * 3600, 1800),
        "24h": (24 * 3600, 3600),
        "7d": (7 * 86400, 21600),
        "30d": (30 * 86400, 86400),
        "all": (365 * 86400, 86400),
    }.get(range_name, (24 * 3600, 3600))


def _collapse_daily(rows: list[dict[str, Any]], width: int) -> list[dict[str, Any]]:
    """Fold hourly rollups into coarser buckets for long ranges."""
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        stamp = time.mktime(time.strptime(row["bucket"], "%Y-%m-%dT%H:%M:%SZ")) - time.timezone
        bucket = time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(stamp - (stamp % width)))
        entry = out.setdefault(bucket, {
            "bucket": bucket, "requests": 0, "errors": 0, "cached": 0, "cost_usd": 0.0,
            "tokens_in": 0, "tokens_out": 0, "latency_sum": 0.0,
        })
        for field in ("requests", "errors", "cached", "tokens_in", "tokens_out"):
            entry[field] += row.get(field) or 0
        entry["cost_usd"] += row.get("cost_usd") or 0.0
        entry["latency_sum"] += row.get("latency_sum") or 0.0
    return [out[key] for key in sorted(out)]


usage = UsageTracker()


async def export_csv(entries: list[dict[str, Any]]) -> str:
    import csv
    import io

    columns = ["id", "time", "method", "path", "requested_model", "model", "account",
               "key_name", "status", "attempts", "latency_ms", "ttft_ms", "stream",
               "cached", "prompt_tokens", "completion_tokens", "cost_usd", "location",
               "level", "error"]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    for entry in entries:
        row = dict(entry)
        row["time"] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(entry.get("ts", 0)))
        writer.writerow([row.get(column, "") for column in columns])
    return buffer.getvalue()


def json_dumps(value: Any) -> str:
    return json.dumps(value, default=str)