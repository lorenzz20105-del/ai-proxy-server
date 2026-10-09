"""Runtime configuration.

Everything is env-overridable with a `.env` file next to the backend, so the same
build runs on a VPS, in Docker and on a phone without code changes.
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

VERSION = "3.0.0"

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env reader — avoids a dependency for 20 lines of code."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


_load_dotenv(REPO_DIR / ".env")


def env_str(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, "") or default)
    except ValueError:
        return default


def env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, "") or default)
    except ValueError:
        return default


def env_bool(key: str, default: bool = False) -> bool:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "y"}


def env_list(key: str, default: list[str] | None = None) -> list[str]:
    raw = os.environ.get(key)
    if not raw:
        return list(default or [])
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass
class Settings:
    # ── server ────────────────────────────────────────────────────────────
    host: str = env_str("PROXY_HOST", "0.0.0.0")
    port: int = env_int("PROXY_PORT", 8000)
    data_dir: str = env_str("PROXY_DATA_DIR", str(BACKEND_DIR / "data"))
    request_timeout: float = env_float("PROXY_REQUEST_TIMEOUT", 120.0)
    stream_timeout: float = env_float("PROXY_STREAM_TIMEOUT", 900.0)
    connect_timeout: float = env_float("PROXY_CONNECT_TIMEOUT", 15.0)
    max_body_bytes: int = env_int("PROXY_MAX_BODY_BYTES", 10 * 1024 * 1024)
    max_concurrency: int = env_int("PROXY_MAX_CONCURRENCY", 0)  # 0 = unlimited
    cors_origins: list[str] = field(default_factory=lambda: env_list("PROXY_CORS_ORIGINS", ["*"]))
    trust_forwarded: bool = env_bool("PROXY_TRUST_FORWARDED", True)

    # ── auth ──────────────────────────────────────────────────────────────
    master_key: str = env_str("PROXY_MASTER_KEY", "") or "sk-proxy-" + secrets.token_urlsafe(32)
    generate_master_key: bool = env_bool("PROXY_GENERATE_MASTER_KEY", False)
    encryption_key: str = env_str("PROXY_ENCRYPTION_KEY", "")

    # ── routing defaults (persisted overrides live in the DB) ──────────────
    routing_strategy: str = env_str("PROXY_ROUTING", "round_robin")
    max_attempts: int = env_int("PROXY_MAX_ATTEMPTS", 3)
    retry_backoff: float = env_float("PROXY_RETRY_BACKOFF", 0.35)
    retry_max_backoff: float = env_float("PROXY_RETRY_MAX_BACKOFF", 4.0)
    retry_jitter: bool = env_bool("PROXY_RETRY_JITTER", True)
    retry_status_codes: list[int] = field(
        default_factory=lambda: env_list(
            "PROXY_RETRY_STATUS_CODES", ["408", "409", "425", "429", "500", "502", "503", "504", "529"]
        )
    )

    circuit_failure_threshold: int = env_int("PROXY_CB_FAILURE_THRESHOLD", 5)
    circuit_success_threshold: int = env_int("PROXY_CB_SUCCESS_THRESHOLD", 2)
    circuit_cooldown: float = env_float("PROXY_CB_COOLDOWN", 45.0)
    circuit_half_open_concurrency: int = env_int("PROXY_CB_HALF_OPEN_CONCURRENCY", 1)

    session_affinity: bool = env_bool("PROXY_SESSION_AFFINITY", True)
    session_affinity_ttl: float = env_float("PROXY_SESSION_AFFINITY_TTL", 1800.0)
    session_header: str = env_str("PROXY_SESSION_HEADER", "x-session-id")

    model_matching: str = env_str("PROXY_MODEL_MATCHING", "exact")

    # ── cache ─────────────────────────────────────────────────────────────
    cache_enabled: bool = env_bool("PROXY_CACHE_ENABLED", True)
    cache_ttl: float = env_float("PROXY_CACHE_TTL", 300.0)
    cache_max_entries: int = env_int("PROXY_CACHE_MAX_ENTRIES", 2000)
    cache_deterministic_only: bool = env_bool("PROXY_CACHE_DETERMINISTIC_ONLY", True)

    # ── budget ────────────────────────────────────────────────────────────
    daily_budget_usd: float = env_float("PROXY_DAILY_BUDGET_USD", 0.0)  # 0 = unlimited
    monthly_budget_usd: float = env_float("PROXY_MONTHLY_BUDGET_USD", 0.0)
    budget_hard_stop: bool = env_bool("PROXY_BUDGET_HARD_STOP", True)

    # ── observability ─────────────────────────────────────────────────────
    log_level: str = env_str("PROXY_LOG_LEVEL", "INFO").upper()
    log_retention_days: int = env_int("PROXY_LOG_RETENTION_DAYS", 14)
    log_json: bool = env_bool("PROXY_LOG_JSON", True)
    active_probe: bool = env_bool("PROXY_ACTIVE_PROBE", True)
    active_probe_interval: float = env_float("PROXY_ACTIVE_PROBE_INTERVAL", 120.0)
    usage_accounting: bool = env_bool("PROXY_USAGE_ACCOUNTING", True)

    # ── features ──────────────────────────────────────────────────────────
    strict_models: bool = env_bool("PROXY_STRICT_MODELS", False)
    seed_from_env: list[str] = field(
        default_factory=lambda: env_list("PROXY_SEED_ACCOOUNTS", [])
    )

    def __post_init__(self) -> None:
        # env vars arrive as strings; the router compares against ints.
        self.retry_status_codes = sorted(
            {int(code) for code in self.retry_status_codes if str(code).strip().isdigit()}
        )

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["data_dir"] = self.data_path_str()
        return data

    def data_path_str(self) -> str:
        return str(Path(self.data_dir).expanduser().resolve())

    def ensure_data_dir(self) -> Path:
        path = Path(self.data_dir).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path.resolve()

    @property
    def db_path(self) -> Path:
        return Path(self.data_path_str()) / "proxy.db"


settings = Settings()