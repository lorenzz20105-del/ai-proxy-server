"""HTTP client pool.

v2 built a brand-new `httpx.AsyncClient` per request — a fresh TCP connection and a
fresh TLS handshake every time, with no keep-alive reuse. Clients are now pooled per
(account, base_url, proxy) tuple and torn down when any of those change.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from .config import settings
from .models import ProviderAccount

log = logging.getLogger("aiproxy.pool")


class ClientPool:
    def __init__(self, connect_timeout: float | None = None,
                 request_timeout: float | None = None) -> None:
        self.connect_timeout = connect_timeout or settings.connect_timeout
        self.request_timeout = request_timeout or settings.request_timeout
        self._clients: dict[tuple, httpx.AsyncClient] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def key(account: ProviderAccount) -> tuple:
        return (
            account.name,
            account.base_url,
            account.proxy.active_url,
            bool(account.proxy.enabled),
        )

    async def get(self, account: ProviderAccount) -> httpx.AsyncClient:
        cache_key = self.key(account)
        client = self._clients.get(cache_key)
        if client is not None and not client.is_closed:
            return client

        async with self._lock:
            client = self._clients.get(cache_key)
            if client is not None and not client.is_closed:
                return client

            limits = httpx.Limits(
                max_connections=64,
                max_keepalive_connections=16,
                keepalive_expiry=90.0,
            )
            kwargs: dict[str, Any] = {
                "timeout": httpx.Timeout(
                    connect=self.connect_timeout,
                    read=self.request_timeout,
                    write=self.request_timeout,
                    pool=self.connect_timeout,
                ),
                "limits": limits,
                "follow_redirects": True,
                "http2": False,
            }
            proxy = account.proxy.active_url
            if proxy:
                kwargs["proxy"] = proxy

            client = httpx.AsyncClient(**kwargs)
            self._clients[cache_key] = client
            return client

    async def stream_client(self, account: ProviderAccount) -> httpx.AsyncClient:
        """Like `get`, but with the long read timeout a stream needs."""
        cache_key = self.key(account) + ("stream",)
        client = self._clients.get(cache_key)
        if client is not None and not client.is_closed:
            return client

        async with self._lock:
            client = self._clients.get(cache_key)
            if client is not None and not client.is_closed:
                return client
            kwargs: dict[str, Any] = {
                "timeout": httpx.Timeout(
                    connect=self.connect_timeout,
                    read=settings.stream_timeout,
                    write=self.request_timeout,
                    pool=self.connect_timeout,
                ),
                "limits": httpx.Limits(max_connections=32, max_keepalive_connections=8),
                "follow_redirects": True,
            }
            proxy = account.proxy.active_url
            if proxy:
                kwargs["proxy"] = proxy
            client = httpx.AsyncClient(**kwargs)
            self._clients[cache_key] = client
            return client

    async def invalidate(self, account: ProviderAccount) -> None:
        async with self._lock:
            for cache_key in [k for k in self._clients if k[0] == account.name]:
                client = self._clients.pop(cache_key)
                try:
                    await client.aclose()
                except Exception:
                    pass

    async def close(self) -> None:
        async with self._lock:
            clients = list(self._clients.values())
            self._clients.clear()
        for client in clients:
            try:
                await client.aclose()
            except Exception:
                pass


client_pool = ClientPool()