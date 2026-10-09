"""Response cache.

The v2 cache keyed on `(messages, model)` alone, which meant a `temperature=0` request
would happily be served a cached answer to an unrelated `temperature=1` prompt. Here the
key covers **every** parameter that can change the output, and — unless the caller
explicitly asks for broader caching — only deterministic requests are stored at all.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import OrderedDict
from typing import Any

# Parameters that change the completion and therefore must be part of the key.
KEY_FIELDS = (
    "model", "messages", "temperature", "top_p", "n", "seed", "stop",
    "presence_penalty", "frequency_penalty", "logit_bias", "logprobs",
    "top_logprobs", "response_format", "tools", "tool_choice", "parallel_tool_calls",
    "reasoning_effort", "max_completion_tokens",
)


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def cache_key(body: dict[str, Any], model: str) -> str:
    payload = {field: body.get(field) for field in KEY_FIELDS}
    payload["model"] = model
    return hashlib.sha256(_canonical(payload).encode()).hexdigest()


def is_deterministic(body: dict[str, Any]) -> bool:
    """A completion is reproducible only if temperature is 0 or a seed is pinned."""
    if body.get("seed") is not None:
        return True
    temperature = body.get("temperature")
    return temperature is not None and float(temperature) == 0.0


class ResponseCache:
    def __init__(self, ttl: float = 300.0, max_entries: int = 2000) -> None:
        self.ttl = ttl
        self.max_entries = max_entries
        self._data: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.bytes = 0

    def configure(self, *, ttl: float | None = None, max_entries: int | None = None) -> None:
        with self._lock:
            if ttl is not None:
                self.ttl = ttl
            if max_entries is not None:
                self.max_entries = max_entries
                self._evict_locked()

    def get(self, key: str) -> dict[str, Any] | None:
        now = time.time()
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                self.misses += 1
                return None
            if now - entry["ts"] >= self.ttl:
                self._remove_locked(key)
                self.misses += 1
                return None
            self._data.move_to_end(key)
            self.hits += 1
            return entry["response"]

    def set(self, key: str, response: dict[str, Any]) -> None:
        raw = _canonical(response).encode()
        with self._lock:
            if key in self._data:
                self._remove_locked(key)
            self._data[key] = {
                "response": response,
                "ts": time.time(),
                "size": len(raw),
            }
            self.bytes += len(raw)
            self._evict_locked()

    def _remove_locked(self, key: str) -> None:
        entry = self._data.pop(key, None)
        if entry:
            self.bytes -= entry["size"]

    def _evict_locked(self) -> None:
        # Expired first, then oldest-inserted (LRU order after move_to_end).
        now = time.time()
        for key in [k for k, v in self._data.items() if now - v["ts"] >= self.ttl]:
            self._remove_locked(key)
        while len(self._data) > self.max_entries:
            self._remove_locked(next(iter(self._data)))
            self.evictions += 1

    def clear(self) -> int:
        with self._lock:
            count = len(self._data)
            self._data.clear()
            self.bytes = 0
            return count

    def stats(self) -> dict[str, Any]:
        with self._lock:
            total = self.hits + self.misses
            return {
                "enabled": True,
                "entries": len(self._data),
                "max_entries": self.max_entries,
                "ttl_seconds": self.ttl,
                "hits": self.hits,
                "misses": self.misses,
                "hit_rate": round(self.hits / total, 4) if total else 0.0,
                "bytes": self.bytes,
                "evictions": self.evictions,
            }

    def reset_stats(self) -> None:
        with self._lock:
            self.hits = 0
            self.misses = 0
            self.evictions = 0