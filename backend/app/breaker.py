"""Per-account circuit breaker.

    closed ──(N consecutive failures)──▶ open ──(cooldown)──▶ half_open
      ▲                                                          │
      └──────(M consecutive successes in half_open)──────────────┘

Unlike v2 — which blindly reset every account to "healthy" on a timer, undoing the
breaker entirely — the cooldown is a *probe gate*: after it elapses the account accepts
at most `half_open_max_concurrency` trial requests, and re-opens on the first failure.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

CLOSED = "closed"
OPEN = "open"
HALF_OPEN = "half_open"


@dataclass
class CircuitState:
    consecutive_failures: int = 0
    half_open_successes: int = 0
    opened_at: float = 0.0
    retry_at: float = 0.0
    probes_in_flight: int = 0
    total_trips: int = 0
    last_error: str | None = None
    last_error_ts: float = 0.0
    last_success_ts: float = 0.0
    disabled_until: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "consecutive_failures": self.consecutive_failures,
            "half_open_successes": self.half_open_successes,
            "total_trips": self.total_trips,
            "last_error": self.last_error,
            "last_error_ts": self.last_error_ts or None,
            "last_success_ts": self.last_success_ts or None,
            "retry_at": self.retry_at or None,
        }


class CircuitBreaker:
    def __init__(
        self,
        failure_threshold: int = 5,
        success_threshold: int = 2,
        cooldown: float = 45.0,
        half_open_max_concurrency: int = 1,
    ) -> None:
        self.failure_threshold = max(1, failure_threshold)
        self.success_threshold = max(1, success_threshold)
        self.cooldown = max(0.0, cooldown)
        self.half_open_max_concurrency = max(1, half_open_max_concurrency)
        self._states: dict[str, CircuitState] = {}
        self._lock = threading.Lock()

    def configure(self, *, failure_threshold: int | None = None, success_threshold: int | None = None,
                  cooldown: float | None = None, half_open_max_concurrency: int | None = None) -> None:
        with self._lock:
            if failure_threshold is not None:
                self.failure_threshold = max(1, failure_threshold)
            if success_threshold is not None:
                self.success_threshold = max(1, success_threshold)
            if cooldown is not None:
                self.cooldown = max(0.0, cooldown)
            if half_open_max_concurrency is not None:
                self.half_open_max_concurrency = max(1, half_open_max_concurrency)

    # ── state ─────────────────────────────────────────────────────────────
    def _state(self, account: str) -> CircuitState:
        return self._states.setdefault(account, CircuitState())

    def status(self, account: str) -> str:
        with self._lock:
            state = self._state(account)
            if state.disabled_until > time.time():
                return OPEN
            if state.retry_at == 0.0:
                return CLOSED
            if time.time() < state.retry_at:
                return OPEN
            return HALF_OPEN

    def available(self, account: str) -> bool:
        return self.status(account) != OPEN

    def try_acquire(self, account: str) -> bool:
        """Reserve a slot to call this account. False ⇒ skip it."""
        with self._lock:
            state = self._state(account)
            now = time.time()
            if state.disabled_until > now:
                return False
            if state.retry_at == 0.0:
                return True  # closed
            if now < state.retry_at:
                return False  # cooling down
            # half-open: allow a limited number of probes
            if state.probes_in_flight >= self.half_open_max_concurrency:
                return False
            state.probes_in_flight += 1
            return True

    def release(self, account: str) -> None:
        with self._lock:
            state = self._state(account)
            if state.probes_in_flight > 0:
                state.probes_in_flight -= 1

    # ── transitions ───────────────────────────────────────────────────────
    def on_success(self, account: str) -> None:
        with self._lock:
            state = self._state(account)
            state.last_success_ts = time.time()
            state.last_error = None
            if state.retry_at > 0.0:
                state.half_open_successes += 1
                if state.half_open_successes >= self.success_threshold:
                    self._close_locked(state)
            else:
                state.consecutive_failures = 0
            if state.probes_in_flight > 0:
                state.probes_in_flight -= 1

    def on_failure(self, account: str, error: str = "") -> None:
        with self._lock:
            state = self._state(account)
            state.last_error = error[:500] if error else None
            state.last_error_ts = time.time()
            if state.retry_at > 0.0:
                # A failed probe sends us straight back to open with a fresh cooldown.
                self._open_locked(state)
                return
            state.consecutive_failures += 1
            if state.consecutive_failures >= self.failure_threshold:
                self._open_locked(state)
            elif state.probes_in_flight > 0:
                state.probes_in_flight -= 1

    def _open_locked(self, state: CircuitState) -> None:
        state.retry_at = time.time() + self.cooldown
        state.opened_at = time.time()
        state.consecutive_failures = self.failure_threshold
        state.half_open_successes = 0
        state.total_trips += 1
        state.probes_in_flight = 0

    def _close_locked(self, state: CircuitState) -> None:
        state.retry_at = 0.0
        state.consecutive_failures = 0
        state.half_open_successes = 0
        state.probes_in_flight = 0

    # ── manual control ────────────────────────────────────────────────────
    def reset(self, account: str) -> None:
        with self._lock:
            self._states[account] = CircuitState()

    def disable(self, account: str, seconds: float) -> None:
        with self._lock:
            state = self._state(account)
            state.disabled_until = time.time() + seconds
            self._open_locked(state)

    def enable(self, account: str) -> None:
        with self._lock:
            state = self._state(account)
            state.disabled_until = 0.0
            self._close_locked(state)

    def snapshot(self, account: str) -> dict[str, Any]:
        with self._lock:
            state = self._state(account)
            now = time.time()
            circuit = CLOSED
            if state.disabled_until > now:
                circuit = OPEN
            elif state.retry_at > now:
                circuit = OPEN
            elif state.retry_at > 0:
                circuit = HALF_OPEN
            data = state.as_dict()
            data.update({
                "circuit": circuit,
                "probes_in_flight": state.probes_in_flight,
                "cooldown_remaining": max(0.0, round(state.retry_at - now, 2)) if circuit == OPEN else 0.0,
            })
            return data

    def all_statuses(self) -> dict[str, str]:
        with self._lock:
            now = time.time()
            out = {}
            for name, state in self._states.items():
                if state.disabled_until > now:
                    out[name] = OPEN
                elif state.retry_at == 0.0:
                    out[name] = CLOSED
                elif now < state.retry_at:
                    out[name] = OPEN
                else:
                    out[name] = HALF_OPEN
            return out