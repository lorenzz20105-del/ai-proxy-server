"""Prometheus metrics.

Hand-rolled (no client library): counters, a fixed-bucket latency histogram, gauges and
rolling statistics. `/metrics` renders the text exposition format.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from typing import Any

LATENCY_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 8.0, 15.0, 30.0, 60.0, 120.0)


class Histogram:
    __slots__ = ("buckets", "counts", "sum", "count")

    def __init__(self, buckets: tuple[float, ...] = LATENCY_BUCKETS) -> None:
        self.buckets = buckets
        self.counts = [0] * len(buckets)
        self.sum = 0.0
        self.count = 0

    def observe(self, value: float) -> None:
        self.sum += value
        self.count += 1
        for i, bound in enumerate(self.buckets):
            if value <= bound:
                self.counts[i] += 1

    def percentile(self, q: float) -> float:
        if not self.count:
            return 0.0
        target = self.count * q
        running = 0
        for i, bound in enumerate(self.buckets):
            running += self.counts[i]
            if running >= target:
                return bound
        return self.buckets[-1]

    def snapshot(self) -> dict[str, Any]:
        return {
            "count": self.count,
            "sum_ms": round(self.sum * 1000, 2),
            "avg_ms": round(self.sum / self.count * 1000, 2) if self.count else 0.0,
            "p50_ms": round(self.percentile(0.50) * 1000, 2) if self.count else 0.0,
            "p95_ms": round(self.percentile(0.95) * 1000, 2) if self.count else 0.0,
            "p99_ms": round(self.percentile(0.99) * 1000, 2) if self.count else 0.0,
        }


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.started = time.time()
        self.counters: dict[str, float] = defaultdict(float)
        self.gauges: dict[str, float] = {}
        self.histograms: dict[str, Histogram] = defaultdict(Histogram)
        # labelled series: (name, label) -> value
        self.series: dict[tuple[str, str], float] = defaultdict(float)
        self.by_account_latency: dict[str, Histogram] = defaultdict(Histogram)
        self.by_model_latency: dict[str, Histogram] = defaultdict(Histogram)
        self.by_status: dict[str, int] = defaultdict(int)

    # ── recording ─────────────────────────────────────────────────────────
    def inc(self, name: str, value: float = 1.0, **labels: str) -> None:
        with self._lock:
            self.counters[name] += value
            for key, val in labels.items():
                self.series[(name, f"{key}={val}")] += value

    def set(self, name: str, value: float) -> None:
        with self._lock:
            self.gauges[name] = value

    def observe(self, name: str, value: float, *, account: str = "", model: str = "") -> None:
        with self._lock:
            self.histograms[name].observe(value)
            if account:
                self.by_account_latency[account].observe(value)
            if model:
                self.by_model_latency[model].observe(value)

    def status(self, code: int) -> None:
        with self._lock:
            self.by_status[str(code)] += 1

    # ── reading ───────────────────────────────────────────────────────────
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            latency = self.histograms["request_latency_seconds"].snapshot()
            total = self.counters.get("requests_total", 0)
            errors = self.counters.get("upstream_errors_total", 0)
            hits = self.counters.get("cache_hits_total", 0)
            misses = self.counters.get("cache_misses_total", 0)
            cache_total = hits + misses
            return {
                "uptime_s": round(time.time() - self.started, 2),
                "requests_total": int(total),
                "upstream_errors_total": int(errors),
                "retries_total": int(self.counters.get("retries_total", 0)),
                "failovers_total": int(self.counters.get("failovers_total", 0)),
                "rate_limited_total": int(self.counters.get("rate_limited_total", 0)),
                "circuit_open_total": int(self.counters.get("circuit_open_total", 0)),
                "cache_hits_total": int(hits),
                "cache_misses_total": int(misses),
                "cache_hit_rate": round(hits / cache_total, 4) if cache_total else 0.0,
                "success_rate": round(1 - errors / total, 4) if total else 1.0,
                "tokens_in": int(self.counters.get("tokens_in_total", 0)),
                "tokens_out": int(self.counters.get("tokens_out_total", 0)),
                "cost_usd": round(self.counters.get("cost_usd_total", 0.0), 6),
                "streaming_requests_total": int(self.counters.get("streaming_requests_total", 0)),
                "latency": latency,
                "by_status": dict(self.by_status),
                "by_account": {
                    name: hist.snapshot() for name, hist in sorted(self.by_account_latency.items())
                },
                "by_model": {
                    name: hist.snapshot() for name, hist in sorted(self.by_model_latency.items())
                },
            }

    def account_latency(self, account: str) -> dict[str, Any]:
        with self._lock:
            hist = self.by_account_latency.get(account)
            if not hist or not hist.count:
                return {"avg": 0.0, "p95": 0.0, "count": 0}
            return {
                "avg": round(hist.sum / hist.count, 4),
                "p95": round(hist.percentile(0.95), 4),
                "count": hist.count,
            }

    def rolling_success_rate(self, account: str, window: int = 100) -> tuple[float, int]:
        """Success rate over the last `window` observations for an account."""
        with self._lock:
            hist = self.by_account_latency.get(account)
            total = hist.count if hist else 0
            errors = int(self.series.get(("account_errors_total", f"account={account}"), 0))
            return ((total - errors) / total if total else 1.0), total

    # ── exposition ────────────────────────────────────────────────────────
    def render(self) -> str:
        snap = self.snapshot()
        lines: list[str] = []

        def metric(name: str, help_text: str, kind: str, value: Any) -> None:
            lines.append(f"# HELP aiproxy_{name} {help_text}")
            lines.append(f"# TYPE aiproxy_{name} {kind}")
            lines.append(f"aiproxy_{name} {value}")

        metric("uptime_seconds", "Seconds since start", "gauge", snap["uptime_s"])
        for key in ("requests_total", "upstream_errors_total", "retries_total",
                    "failovers_total", "rate_limited_total", "circuit_open_total",
                    "cache_hits_total", "cache_misses_total", "tokens_in",
                    "tokens_out", "streaming_requests_total"):
            metric(key, key.replace("_", " "), "counter", snap[key])
        metric("cost_usd_total", "Estimated spend in USD", "counter", snap["cost_usd"])
        metric("cache_hit_ratio", "Cache hit ratio", "gauge", snap["cache_hit_rate"])
        metric("success_ratio", "Fraction of successful upstream calls", "gauge",
               snap["success_rate"])

        hist = self.histograms["request_latency_seconds"]
        lines.append("# HELP aiproxy_request_latency_seconds End-to-end request latency")
        lines.append("# TYPE aiproxy_request_latency_seconds histogram")
        for i, bound in enumerate(hist.buckets):
            lines.append(f'aiproxy_request_latency_seconds_bucket{{le="{bound}"}} {hist.counts[i]}')
        lines.append(f'aiproxy_request_latency_seconds_bucket{{le="+Inf"}} {hist.count}')
        lines.append(f"aiproxy_request_latency_seconds_sum {hist.sum:.6f}")
        lines.append(f"aiproxy_request_latency_seconds_count {hist.count}")

        with self._lock:
            for (name, label), value in sorted(self.series.items()):
                if name in ("requests_total", "upstream_errors_total"):
                    lines.append(f"aiproxy_{name}{{{label}}} {int(value)}")
            for name, value in sorted(self.gauges.items()):
                lines.append(f"aiproxy_{name} {value}")
            for status, count in sorted(self.by_status.items()):
                lines.append(f'aiproxy_responses_total{{status="{status}"}} {count}')
            for name, h in sorted(self.by_account_latency.items()):
                safe = name.replace('"', "")
                lines.append(
                    f'aiproxy_account_latency_seconds_count{{account="{safe}"}} {h.count}'
                )
                lines.append(
                    f'aiproxy_account_latency_seconds_sum{{account="{safe}"}} {h.sum:.6f}'
                )

        return "\n".join(lines) + "\n"


metrics = Metrics()