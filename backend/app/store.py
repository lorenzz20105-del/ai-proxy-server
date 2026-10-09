"""SQLite persistence.

All state that matters survives a restart: accounts, routing config, aliases, budgets,
API keys, request logs and usage rollups. Writes go through a worker thread so the
event loop never blocks on disk I/O.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger("aiproxy.store")

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS accounts (
    name        TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    created_ts  REAL NOT NULL,
    updated_ts  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
    k   TEXT PRIMARY KEY,
    v   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
    id        TEXT PRIMARY KEY,
    ts        REAL NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'request',
    level     TEXT NOT NULL DEFAULT 'info',
    account   TEXT,
    model     TEXT,
    status    INTEGER,
    cost_usd  REAL DEFAULT 0,
    data      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_ts      ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_account ON logs(account, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_model   ON logs(model, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_status  ON logs(status, ts DESC);

CREATE TABLE IF NOT EXISTS usage_hourly (
    bucket      TEXT NOT NULL,
    account     TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    key_name    TEXT NOT NULL DEFAULT '',
    requests    INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0,
    cached      INTEGER NOT NULL DEFAULT 0,
    tokens_in   INTEGER NOT NULL DEFAULT 0,
    tokens_out  INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL    NOT NULL DEFAULT 0,
    latency_sum REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, account, model, key_name)
);
CREATE INDEX IF NOT EXISTS idx_usage_bucket ON usage_hourly(bucket);

CREATE TABLE IF NOT EXISTS usage_daily (
    day         TEXT NOT NULL,
    account     TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    key_name    TEXT NOT NULL DEFAULT '',
    requests    INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0,
    cached      INTEGER NOT NULL DEFAULT 0,
    tokens_in   INTEGER NOT NULL DEFAULT 0,
    tokens_out  INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL NOT NULL DEFAULT 0,
    latency_sum REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, account, model, key_name)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON usage_daily(day);
"""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()
        self._write_lock = asyncio.Lock()

    # ── lifecycle ─────────────────────────────────────────────────────────
    def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30.0)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        if self._conn is not None:
            with self._lock:
                try:
                    self._conn.commit()
                except sqlite3.Error:
                    pass
                self._conn.close()
            self._conn = None

    def _require(self) -> sqlite3.Connection:
        if self._conn is None:
            self.connect()
        assert self._conn is not None
        return self._conn

    async def _run(self, fn, *args, **kwargs):
        return await asyncio.to_thread(self._call, fn, *args, **kwargs)

    def _call(self, fn, *args, **kwargs):
        with self._lock:
            conn = self._require()
            try:
                return fn(conn, *args, **kwargs)
            finally:
                conn.commit()

    # ── kv ────────────────────────────────────────────────────────────────
    async def kv_get(self, key: str, default: Any = None) -> Any:
        row = await self._run(lambda c: c.execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone())
        return json.loads(row["v"]) if row else default

    async def kv_set(self, key: str, value: Any) -> None:
        await self._run(lambda c: c.execute(
            "INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (key, json.dumps(value, default=str)),
        ))

    async def kv_delete(self, key: str) -> None:
        await self._run(lambda c: c.execute("DELETE FROM kv WHERE k=?", (key,)))

    # ── accounts ──────────────────────────────────────────────────────────
    async def load_accounts(self) -> list[dict[str, Any]]:
        rows = await self._run(
            lambda c: c.execute("SELECT data FROM accounts ORDER BY created_ts").fetchall()
        )
        return [json.loads(r["data"]) for r in rows]

    async def save_account(self, name: str, data: dict[str, Any]) -> None:
        now = time.time()
        await self._run(lambda c: c.execute(
            "INSERT INTO accounts(name,data,created_ts,updated_ts) VALUES(?,?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_ts=excluded.updated_ts",
            (name, json.dumps(data, default=str), now, now),
        ))

    async def delete_account(self, name: str) -> None:
        await self._run(lambda c: c.execute("DELETE FROM accounts WHERE name=?", (name,)))

    # ── logs ──────────────────────────────────────────────────────────────
    async def add_logs(self, entries: Iterable[dict[str, Any]]) -> None:
        rows = [
            (
                e.get("id") or f"{int(e.get('ts', time.time()) * 1000):x}",
                e.get("ts", time.time()),
                e.get("kind", "request"),
                e.get("level", "info"),
                e.get("account", "") or "",
                e.get("model", "") or "",
                e.get("status"),
                float(e.get("cost_usd", 0) or 0),
                json.dumps(e, default=str),
            )
            for e in entries
        ]
        if not rows:
            return

        def _write(conn: sqlite3.Connection) -> None:
            conn.executemany(
                "INSERT OR REPLACE INTO logs(id,ts,kind,level,account,model,status,cost_usd,data) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                rows,
            )

        await self._run(_write)

    async def query_logs(
        self,
        limit: int = 200,
        account: str = "",
        model: str = "",
        status: str = "",
        kind: str = "",
        level: str = "",
        since: float = 0.0,
        search: str = "",
    ) -> list[dict[str, Any]]:
        where = ["1=1"]
        params: list[Any] = []
        if account:
            where.append("account = ?")
            params.append(account)
        if model:
            where.append("model = ?")
            params.append(model)
        if kind:
            where.append("kind = ?")
            params.append(kind)
        if level:
            where.append("level = ?")
            params.append(level)
        if since:
            where.append("ts >= ?")
            params.append(since)
        if status:
            try:
                code = int(status)
            except ValueError:
                where.append("CAST(IFNULL(status,0)/100 AS INTEGER) = ?")
                params.append(int(status) // 100)
            else:
                where.append("status = ?")
                params.append(code)
        clause = " AND ".join(where)
        if search:
            clause += " AND data LIKE ?"
            params.append(f"%{search}%")

        def _read(conn: sqlite3.Connection):
            rows = conn.execute(
                f"SELECT data FROM logs WHERE {clause} ORDER BY ts DESC LIMIT ?",
                (*params, max(1, min(limit, 5000))),
            ).fetchall()
            count = conn.execute(f"SELECT COUNT(*) AS n FROM logs WHERE {clause}", params).fetchone()
            return [json.loads(r["data"]) for r in rows], int(count["n"])

        return await self._run(_read)

    async def count_logs(self) -> int:
        row = await self._run(lambda c: c.execute("SELECT COUNT(*) AS n FROM logs").fetchone())
        return int(row["n"])

    async def clear_logs(self) -> int:
        def _write(conn: sqlite3.Connection) -> int:
            n = conn.execute("SELECT COUNT(*) AS n FROM logs").fetchone()["n"]
            conn.execute("DELETE FROM logs")
            return n

        return await self._run(_write)

    async def iter_all_logs(self) -> list[dict[str, Any]]:
        def _read(conn: sqlite3.Connection):
            return [json.loads(r["data"]) for r in conn.execute("SELECT data FROM logs ORDER BY ts")]

        return await self._run(_read)

    async def prune_logs(self, older_than: float) -> int:
        def _write(conn: sqlite3.Connection) -> int:
            cur = conn.execute("DELETE FROM logs WHERE ts < ?", (older_than,))
            return cur.rowcount

        return await self._run(_write)

    # ── usage rollups ─────────────────────────────────────────────────────
    async def bump_usage(
        self,
        bucket: str,
        day: str,
        account: str,
        model: str,
        key_name: str,
        requests: int = 1,
        errors: int = 0,
        cached: int = 0,
        tokens_in: int = 0,
        tokens_out: int = 0,
        cost_usd: float = 0.0,
        latency: float = 0.0,
    ) -> None:
        def _write(conn: sqlite3.Connection) -> None:
            # The two rollup tables differ only in their leading column name.
            for table, column, value in (("usage_hourly", "bucket", bucket),
                                         ("usage_daily", "day", day)):
                conn.execute(
                    f"INSERT INTO {table}"
                    f"({column},account,model,key_name,requests,errors,cached,"
                    "tokens_in,tokens_out,cost_usd,latency_sum) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
                    f"ON CONFLICT({column},account,model,key_name) DO UPDATE SET "
                    "requests=requests+excluded.requests, "
                    "errors=errors+excluded.errors, "
                    "cached=cached+excluded.cached, "
                    "tokens_in=tokens_in+excluded.tokens_in, "
                    "tokens_out=tokens_out+excluded.tokens_out, "
                    "cost_usd=cost_usd+excluded.cost_usd, "
                    "latency_sum=latency_sum+excluded.latency_sum",
                    (value, account, model, key_name, requests, errors, cached,
                     tokens_in, tokens_out, cost_usd, latency),
                )

        await self._run(_write)

    async def usage_rollups(
        self, since_bucket: str, since_day: str
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        def _read(conn: sqlite3.Connection):
            hourly = conn.execute(
                "SELECT * FROM usage_hourly WHERE bucket >= ? ORDER BY bucket", (since_bucket,)
            ).fetchall()
            daily = conn.execute(
                "SELECT * FROM usage_daily WHERE day >= ? ORDER BY day", (since_day,)
            ).fetchall()
            return [dict(r) for r in hourly], [dict(r) for r in daily]

        hourly, daily = await self._run(_read)
        return hourly, daily

    async def daily_cost_since(self, day: str) -> tuple[float, float]:
        """(spent since `day`, spent since the 1st of that month)"""
        def _read(conn: sqlite3.Connection):
            total = conn.execute(
                "SELECT COALESCE(SUM(cost_usd),0) AS c FROM usage_daily WHERE day >= ?", (day,)
            ).fetchone()["c"]
            month = conn.execute(
                "SELECT COALESCE(SUM(cost_usd),0) AS c FROM usage_daily "
                "WHERE day >= ? AND substr(day,1,7) = ?",
                (day, day[:7]),
            ).fetchone()["c"]
            return float(total), float(month)

        return await self._run(_read)

    async def daily_cost_by_key(self, day: str) -> dict[str, float]:
        def _read(conn: sqlite3.Connection):
            rows = conn.execute(
                "SELECT key_name, COALESCE(SUM(cost_usd),0) AS c FROM usage_daily "
                "WHERE day = ? GROUP BY key_name", (day,)
            ).fetchall()
            return {r["key_name"] or "master": float(r["c"]) for r in rows}

        return await self._run(_read)

    async def account_totals_since(self, day: str) -> dict[str, dict[str, Any]]:
        def _read(conn: sqlite3.Connection):
            rows = conn.execute(
                "SELECT account, SUM(requests) AS r, SUM(errors) AS e, SUM(cached) AS c, "
                "SUM(tokens_in) AS ti, SUM(tokens_out) AS to_, SUM(cost_usd) AS cost "
                "FROM usage_daily WHERE day >= ? GROUP BY account", (day,)
            ).fetchall()
            return {
                r["account"] or "unknown": {
                    "requests": int(r["r"] or 0), "errors": int(r["e"] or 0),
                    "cached": int(r["c"] or 0), "tokens_in": int(r["ti"] or 0),
                    "tokens_out": int(r["to_"] or 0), "cost_usd": float(r["cost"] or 0),
                }
                for r in rows
            }

        return await self._run(_read)

    async def purge_older_than(self, day: str) -> None:
        def _write(conn: sqlite3.Connection) -> None:
            conn.execute("DELETE FROM usage_hourly WHERE bucket < ?", (day[:8] + "01T00",))
            conn.execute("DELETE FROM usage_daily WHERE day < ?", (day,))

        await self._run(_write)


_store: Store | None = None


def get_store() -> Store:
    """Process-wide store, rebuilt if the configured data directory moves."""
    global _store
    from .config import settings

    path = settings.db_path
    if _store is None or _store.path != path:
        if _store is not None:
            try:
                _store.close()
            except Exception:
                pass
        _store = Store(path)
    return _store