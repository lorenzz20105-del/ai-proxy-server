"""Rate limiting: token buckets per account (rpm/tpm) and in-flight concurrency caps.

A token bucket rather than a fixed window, so a burst at the boundary does not buy a
double allowance and a slow trickle is never penalised.
"""
from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class BucketState:
    tokens: float
    last_refill: float


class TokenBucket:
    def __init__(self, capacity: float, refill_per_second: float) -> None:
        self.capacity = float(capacity)
        self.refill_per_second = float(refill_per_second)
        self._state = BucketState(float(capacity), time.monotonic())
        self._lock = threading.Lock()

    def _refill(self, now: float) -> None:
        elapsed = max(0.0, now - self._state.last_refill)
        self._state.tokens = min(
            self.capacity, self._state.tokens + elapsed * self.refill_per_second
        )
        self._state.last_refill = now

    def try_consume(self, amount: float = 1.0) -> bool:
        if self.capacity <= 0:
            return True
        with self._lock:
            now = time.monotonic()
            self._refill(now)
            if self._state.tokens >= amount:
                self._state.tokens -= amount
                return True
            return False

    def refund(self, amount: float = 1.0) -> None:
        """Give tokens back when the caller's request was never actually sent."""
        with self._lock:
            self._state.tokens = min(self.capacity, self._state.tokens + amount)

    def retry_after(self) -> float:
        with self._lock:
            self._refill(time.monotonic())
            if self._state.tokens >= 1:
                return 0.0
            if self.refill_per_second <= 0:
                return 60.0
            return (1.0 - self._state.tokens) / self.refill_per_second

    def reset(self) -> None:
        with self._lock:
            self._state = BucketState(float(self.capacity), time.monotonic())


@dataclass
class LimitDecision:
    allowed: bool
    scope: str = ""          # "rpm" | "tpm" | "concurrency" | "budget"
    retry_after: float = 0.0
    detail: str = ""


class RateLimiter:
    def __init__(self) -> None:
        self._buckets: dict[str, dict[str, TokenBucket]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._inflight: dict[str, int] = {}
        self._max_inflight: dict[str, int] = {}
        self._guard = threading.Lock()

    def configure(self, scope: str, *, rpm: int, tpm: int, burst: int, concurrency: int) -> None:
        """(Re)build the buckets for one scope. Keeps the current token level on RPM."""
        with self._guard:
            existing = self._buckets.get(scope, {})
            rpm_bucket = existing.get("rpm")
            if rpm <= 0:
                new_rpm = None
            elif rpm_bucket is not None and abs(rpm_bucket.capacity - float(rpm)) < 1e-9:
                new_rpm = rpm_bucket
            else:
                capacity = float(rpm) * max(1, burst)
                new_rpm = TokenBucket(capacity, float(rpm) / 60.0)
            new_tpm = None if tpm <= 0 else TokenBucket(
                float(tpm) * max(1, burst), float(tpm) / 60.0
            )
            self._buckets[scope] = {"rpm": new_rpm, "tpm": new_tpm}  # type: ignore[dict-item]
            self._max_inflight[scope] = max(0, concurrency)

    def check(self, scope: str, tokens: int = 0) -> LimitDecision:
        buckets = self._buckets.get(scope)
        if buckets:
            rpm = buckets.get("rpm")
            if rpm is not None and not rpm.try_consume(1.0):
                return LimitDecision(False, "rpm", rpm.retry_after(),
                                     f"{scope}: requests-per-minute limit reached")
            tpm = buckets.get("tpm")
            if tpm is not None and tokens > 0 and not tpm.try_consume(float(tokens)):
                retry = tpm.retry_after()
                # refund the request token — the caller was never sent
                if rpm is not None:
                    rpm.refund(1.0)
                return LimitDecision(False, "tpm", retry,
                                     f"{scope}: tokens-per-minute limit reached")

        max_inflight = self._max_inflight.get(scope, 0)
        if max_inflight > 0 and self._inflight.get(scope, 0) >= max_inflight:
            return LimitDecision(False, "concurrency", 1.0,
                                 f"{scope}: max concurrent requests reached")
        return LimitDecision(True)

    def acquire(self, scope: str) -> None:
        with self._guard:
            self._inflight[scope] = self._inflight.get(scope, 0) + 1

    def release(self, scope: str) -> None:
        with self._guard:
            current = self._inflight.get(scope, 0)
            if current > 0:
                self._inflight[scope] = current - 1

    def in_flight(self, scope: str) -> int:
        return self._inflight.get(scope, 0)

    def reset(self, scope: str) -> None:
        with self._guard:
            buckets = self._buckets.get(scope)
            if buckets:
                for bucket in buckets.values():
                    if bucket is not None:
                        bucket.reset()
            self._inflight[scope] = 0

    def forget(self, scope: str) -> None:
        with self._guard:
            self._buckets.pop(scope, None)
            self._locks.pop(scope, None)
            self._inflight.pop(scope, None)
            self._max_inflight.pop(scope, None)

    def snapshot(self) -> dict[str, dict[str, Any]]:
        with self._guard:
            out: dict[str, dict[str, Any]] = {}
            for scope, buckets in self._buckets.items():
                rpm = buckets.get("rpm")
                tpm = buckets.get("tpm")
                out[scope] = {
                    "rpm_limit": int(rpm.capacity) if rpm else 0,
                    "rpm_remaining": round(rpm._state.tokens, 1) if rpm else None,
                    "tpm_limit": int(tpm.capacity) if tpm else 0,
                    "tpm_remaining": round(tpm._state.tokens, 1) if tpm else None,
                    "in_flight": self._inflight.get(scope, 0),
                    "max_inflight": self._max_inflight.get(scope, 0),
                }
            return out


rate_limiter = RateLimiter()