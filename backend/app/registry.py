"""Runtime state: accounts, model aliases, routing config, budgets and API keys.

Loaded once at startup from SQLite, mutated through the admin API, and written back on
every change. Selection logic lives in `router.py`; this module owns the state itself.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Iterable

from .cache import ResponseCache
from .breaker import CircuitBreaker
from .config import settings
from .models import STRATEGIES, ProviderAccount
from .ratelimit import rate_limiter
from .security import KeyRecord, generate_key, secret_box
from .store import Store, get_store

log = logging.getLogger("aiproxy.registry")

KV_ROUTING = "routing"
KV_ALIASES = "aliases"
KV_BUDGET = "budget"
KV_KEYS = "keys"
KV_PRICING = "pricing_overrides"


# ── defaults ───────────────────────────────────────────────────────────────
def default_routing() -> dict[str, Any]:
    return {
        "strategy": settings.routing_strategy,
        "strategies": STRATEGIES,
        "retry": {
            "max_attempts": settings.max_attempts,
            "backoff_seconds": settings.retry_backoff,
            "max_backoff_seconds": settings.retry_max_backoff,
            "jitter": settings.retry_jitter,
            "retry_status_codes": list(settings.retry_status_codes),
        },
        "circuit_breaker": {
            "failure_threshold": settings.circuit_failure_threshold,
            "success_threshold": settings.circuit_success_threshold,
            "cooldown_seconds": settings.circuit_cooldown,
            "half_open_max_concurrency": settings.circuit_half_open_concurrency,
        },
        "session_affinity": {
            "enabled": settings.session_affinity,
            "ttl_seconds": settings.session_affinity_ttl,
            "header": settings.session_header,
        },
        "cache": {
            "enabled": settings.cache_enabled,
            "ttl_seconds": settings.cache_ttl,
            "max_entries": settings.cache_max_entries,
            "deterministic_only": settings.cache_deterministic_only,
            "forward_client_caching_headers": True,
        },
        "model_matching": settings.model_matching,
    }


def default_budget() -> dict[str, Any]:
    return {
        "daily_usd": settings.daily_budget_usd,
        "monthly_usd": settings.monthly_budget_usd,
        "hard_stop": settings.budget_hard_stop,
        "alerts": [80, 95],
    }


class Registry:
    def __init__(self) -> None:
        self.store: Store = get_store()
        self.accounts: dict[str, ProviderAccount] = {}
        self.aliases: dict[str, dict[str, Any]] = {}
        self.keys: dict[str, KeyRecord] = {}
        self.routing: dict[str, Any] = default_routing()
        self.budget: dict[str, Any] = default_budget()
        self.breaker = CircuitBreaker()
        self.cache = ResponseCache()
        self._lock = asyncio.Lock()
        self._started = False

    # ── lifecycle ─────────────────────────────────────────────────────────
    async def start(self) -> None:
        async with self._lock:
            if self._started:
                return
            self.store.connect()

            for raw in await self.store.load_accounts():
                try:
                    account = ProviderAccount(**raw)
                    account.api_key = secret_box.decrypt(account.api_key)
                    account.proxy.url = secret_box.decrypt(account.proxy.url)
                    self.accounts[account.name] = account
                except Exception as exc:
                    log.error("skipping broken account record: %s", exc)

            if not self.accounts:
                await self._seed_from_env()

            self.routing = await self.store.kv_get(KV_ROUTING, default_routing())
            self.aliases = await self.store.kv_get(KV_ALIASES, {})
            self.budget = await self.store.kv_get(KV_BUDGET, default_budget())
            self._apply_routing()
            self._load_keys(await self.store.kv_get(KV_KEYS, []))
            self._started = True

        log.info("registry ready: %d account(s), %d alias(es), %d key(s)",
                 len(self.accounts), len(self.aliases), len(self.keys))

    async def _seed_from_env(self) -> None:
        """First run: build accounts from the documented PROXY_SEED_ACCOUNTS / OPENAI_KEY_*."""
        import json as _json

        seeds: list[dict[str, Any]] = []
        raw_seed = os.environ.get("PROXY_SEED_ACCOUNTS", "").strip()
        if raw_seed.startswith("[") or raw_seed.startswith("{"):
            try:
                parsed = _json.loads(raw_seed)
                seeds = parsed if isinstance(parsed, list) else [parsed]
            except json.JSONDecodeError as exc:
                log.error("PROXY_SEED_ACCOUNTS is not valid JSON: %s", exc)
        for name, provider, key_env, base in (
            ("openai-primary", "openai", "OPENAI_KEY_1", "https://api.openai.com/v1"),
            ("openai-secondary", "openai", "OPENAI_KEY_2", "https://api.openai.com/v1"),
            ("anthropic", "anthropic", "ANTHROPIC_KEY_1", "https://api.anthropic.com/v1"),
            ("google", "google", "GOOGLE_KEY_1",
             "https://generativelanguage.googleapis.com/v1beta"),
        ):
            api_key = os.environ.get(key_env, "")
            if api_key:
                seeds.append({"name": name, "provider_type": provider,
                              "base_url": base, "api_key": api_key})

        if not seeds:
            log.warning(
                "no accounts configured — add one in the dashboard or set "
                "OPENAI_KEY_1 / ANTHROPIC_KEY_1 / GOOGLE_KEY_1"
            )
            return

        for seed in seeds:
            from .models import AccountCreate

            try:
                account = AccountCreate(**seed).to_account()
            except Exception as exc:
                log.error("bad seed account %r: %s", seed.get("name"), exc)
                continue
            self.accounts[account.name] = account
            await self._persist(account)
        log.info("seeded %d account(s) from the environment", len(self.accounts))

    async def shutdown(self) -> None:
        self.store.close()

    def _apply_routing(self) -> None:
        cb = self.routing.get("circuit_breaker", {})
        self.breaker.configure(
            failure_threshold=int(cb.get("failure_threshold", 5)),
            success_threshold=int(cb.get("success_threshold", 2)),
            cooldown=float(cb.get("cooldown_seconds", 45.0)),
            half_open_max_concurrency=int(cb.get("half_open_max_concurrency", 1)),
        )
        cache = self.routing.get("cache", {})
        self.cache.configure(
            ttl=float(cache.get("ttl_seconds", 300.0)),
            max_entries=int(cache.get("max_entries", 2000)),
        )
        for account in self.accounts.values():
            self._apply_limits(account)

    def _apply_limits(self, account: ProviderAccount) -> None:
        limits = account.rate_limit
        rate_limiter.configure(
            f"account:{account.name}",
            rpm=limits.rpm if limits.enabled else 0,
            tpm=limits.tpm,
            burst=limits.burst,
            concurrency=limits.concurrency,
        )

    # ── accounts ──────────────────────────────────────────────────────────
    async def _persist(self, account: ProviderAccount) -> None:
        data = account.model_dump()
        data["api_key"] = secret_box.encrypt(account.api_key)
        data["proxy"]["url"] = secret_box.encrypt(account.proxy.url)
        await self.store.save_account(account.name, data)

    async def upsert_account(self, account: ProviderAccount) -> ProviderAccount:
        async with self._lock:
            existing = self.accounts.get(account.name)
            if existing is not None:
                account.created_ts = existing.created_ts
            account.updated_ts = time.time()
            self.accounts[account.name] = account
            self._apply_limits(account)
            await self._persist(account)
            return account

    async def rename_account(self, old: str, new: ProviderAccount) -> ProviderAccount:
        async with self._lock:
            if old in self.accounts:
                new.created_ts = self.accounts[old].created_ts
                await self.store.delete_account(old)
                self.accounts.pop(old, None)
                rate_limiter.forget(f"account:{old}")
            new.updated_ts = time.time()
            self.accounts[new.name] = new
            self._apply_limits(new)
            await self._persist(new)
            return new

    async def delete_account(self, name: str) -> bool:
        async with self._lock:
            removed = self.accounts.pop(name, None) is not None
            if removed:
                await self.store.delete_account(name)
                self.breaker.reset(name)
                rate_limiter.forget(f"account:{name}")
            return removed

    def get(self, name: str) -> ProviderAccount | None:
        return self.accounts.get(name)

    def enabled_accounts(self) -> list[ProviderAccount]:
        return [a for a in self.accounts.values() if a.enabled]

    # ── aliases ───────────────────────────────────────────────────────────
    def resolve_alias(self, model: str) -> tuple[str, list[str]]:
        """Returns (requested_model, ordered list of concrete models to try)."""
        entry = self.aliases.get(model)
        if entry and entry.get("targets"):
            return model, list(entry["targets"])
        return model, [model]

    def resolve_chain(self, model: str) -> list[str]:
        """Flatten alias chains so `smart → fast → gpt-4o` terminates."""
        seen: set[str] = set()
        chain: list[str] = []

        def walk(current: str) -> None:
            if current in seen or len(chain) > 8:
                return
            seen.add(current)
            entry = self.aliases.get(current)
            if entry and entry.get("targets"):
                for target in entry["targets"]:
                    walk(target)
            else:
                chain.append(current)

        walk(model)
        return chain or [model]

    async def set_alias(self, alias: str, targets: list[str],
                        strategy: str = "first_available") -> dict[str, Any]:
        async with self._lock:
            entry = {"targets": targets, "strategy": strategy, "created_ts": time.time()}
            self.aliases[alias] = entry
            await self.store.kv_set(KV_ALIASES, self.aliases)
            return entry

    async def delete_alias(self, alias: str) -> bool:
        async with self._lock:
            if alias in self.aliases:
                self.aliases.pop(alias)
                await self.store.kv_set(KV_ALIASES, self.aliases)
                return True
            return False

    # ── routing config ────────────────────────────────────────────────────
    async def update_routing(self, patch: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            for key, value in patch.items():
                if isinstance(value, dict) and isinstance(self.routing.get(key), dict):
                    self.routing[key] = {**self.routing[key], **value}
                else:
                    self.routing[key] = value
            strategy = self.routing.get("strategy")
            if strategy in STRATEGIES:
                self.routing["strategy"] = strategy
            elif strategy is not None:
                raise ValueError(f"unknown strategy '{strategy}'")
            self._apply_routing()
            await self.store.kv_set(KV_ROUTING, self.routing)
            return self.routing

    # ── budget ────────────────────────────────────────────────────────────
    async def update_budget(self, patch: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            self.budget.update({k: v for k, v in patch.items() if v is not None})
            await self.store.kv_set(KV_BUDGET, self.budget)
            return self.budget

    async def spend(self, cost_usd: float) -> None:
        """Accumulate spend against the global, per-key and per-account budgets."""
        from .usage import usage

        await usage.spend(cost_usd, self.budget)

    # ── API keys ──────────────────────────────────────────────────────────
    def _load_keys(self, raw: Iterable[dict[str, Any]]) -> None:
        self.keys = {}
        for item in raw or []:
            try:
                record = KeyRecord(**item)
                self.keys[record.key] = record
            except Exception as exc:
                log.error("skipping broken key record: %s", exc)

    async def create_key(self, name: str, **options: Any) -> KeyRecord:
        async with self._lock:
            record = KeyRecord(name=name, key=generate_key(), **options)
            self.keys[record.key] = record
            await self.store.kv_set(KV_KEYS, [k.model_dump() for k in self.keys.values()])
            return record

    async def delete_key(self, key: str) -> bool:
        async with self._lock:
            if key in self.keys:
                self.keys.pop(key)
                await self.store.kv_set(KV_KEYS, [k.model_dump() for k in self.keys.values()])
                return True
            return False

    async def update_key(self, key: str, **options: Any) -> KeyRecord | None:
        async with self._lock:
            record = self.keys.get(key)
            if record is None:
                return None
            for name, value in options.items():
                if value is not None and hasattr(record, name):
                    setattr(record, name, value)
            await self.store.kv_set(KV_KEYS, [k.model_dump() for k in self.keys.values()])
            return record

    # ── misc ──────────────────────────────────────────────────────────────
    def all_models(self) -> list[dict[str, Any]]:
        """Union of enabled accounts' models plus every alias."""
        from .pricing import context_window

        models: dict[str, set[str]] = {}
        for account in self.enabled_accounts():
            for model in account.models:
                models.setdefault(model, set()).add(account.name)
        for alias, entry in self.aliases.items():
            models.setdefault(alias, set()).add("alias")

        return [
            {
                "id": model,
                "object": "model",
                "owned_by": "aiproxy",
                "proxy": {
                    "accounts": sorted(owners),
                    "alias": "alias" in owners,
                    "context_window": context_window(model),
                },
            }
            for model, owners in sorted(models.items())
        ]

    def health_summary(self) -> dict[str, Any]:
        total = len(self.accounts)
        enabled = [a for a in self.accounts.values() if a.enabled]
        healthy = [a for a in enabled if self.breaker.available(a.name)]
        return {
            "total": total,
            "enabled": len(enabled),
            "healthy": len(healthy),
            "degraded": bool(enabled) and not healthy,
        }


registry = Registry()