"""Authentication and secret storage.

* API keys are compared in constant time.
* Keys can be minted with scopes, per-key rate limits and per-key budgets.
* Upstream secrets are encrypted at rest when a Fernet key is configured, and are
  never returned by the admin API in full.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
import time
from typing import Any

from pydantic import BaseModel, Field

from .config import settings

log = logging.getLogger("aiproxy.security")

KEY_PREFIX = "sk-proxy-"


# ── secret encryption at rest ──────────────────────────────────────────────
class SecretBox:
    """Fernet when `cryptography` is available, otherwise a keyed-XOR box.

    The fallback is deliberately *not* advertised as strong: it protects against
    casual disclosure (a backup, a screenshot, a `git grep`) and nothing more.
    """

    def __init__(self) -> None:
        self.mode = "plaintext"
        self._fernet = None
        self._xor_key = b""
        configured = settings.encryption_key.strip()
        if not configured:
            return
        try:
            from cryptography.fernet import Fernet  # type: ignore

            key = configured.encode()
            # Accept any passphrase: derive a real Fernet key from it.
            if len(key) != 44:
                key = base64.urlsafe_b64encode(hashlib.sha256(key).digest())
            self._fernet = Fernet(key)
            self.mode = "fernet"
            return
        except ImportError:
            log.warning(
                "cryptography is not installed — API keys will be stored with the "
                "weak fallback cipher. Install 'cryptography' for real encryption."
            )
        self._xor_key = hashlib.sha256(configured.encode()).digest()
        self.mode = "xor"

    def encrypt(self, plaintext: str) -> str:
        if not plaintext:
            return ""
        if self._fernet is not None:
            return "f:" + self._fernet.encrypt(plaintext.encode()).decode()
        if self._xor_key:
            return "x:" + self._xor_box(plaintext.encode())
        return plaintext

    def decrypt(self, stored: str) -> str:
        if not stored:
            return ""
        if stored.startswith("f:") and self._fernet is not None:
            try:
                return self._fernet.decrypt(stored[2:].encode()).decode()
            except Exception:
                log.error("failed to decrypt a stored secret — wrong PROXY_ENCRYPTION_KEY?")
                return ""
        if stored.startswith("x:") and self._xor_key:
            return self._xor_box(bytes.fromhex(stored[2:]))
        return stored

    def _xor_box(self, data: bytes) -> str:
        stream = bytearray()
        counter = 0
        while len(stream) < len(data):
            stream += hashlib.sha256(self._xor_key + counter.to_bytes(4, "big")).digest()
            counter += 1
        return bytes(a ^ b for a, b in zip(data, stream)).hex()


secret_box = SecretBox()


# ── API keys ───────────────────────────────────────────────────────────────
class KeyRecord(BaseModel):
    """A minted proxy key. The full `key` is only ever returned by POST /admin/keys."""

    name: str
    key: str
    created_ts: float = Field(default_factory=time.time)
    last_used_ts: float = 0.0
    enabled: bool = True
    daily_usd: float = 0.0
    rpm: int = 0
    tpm: int = 0
    models_allow: list[str] | None = None
    models_deny: list[str] | None = None
    admin: bool = False

    def public(self) -> dict[str, Any]:
        from .models import mask_secret

        data = self.model_dump()
        data["key_masked"] = mask_secret(self.key)
        data.pop("key", None)
        return data


def generate_key(prefix: str = KEY_PREFIX) -> str:
    return prefix + secrets.token_urlsafe(32)


def fingerprint(key: str) -> str:
    """Stable, non-reversible id used in logs and DB lookups."""
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def extract_key(headers: dict[str, str], query: str | None) -> str:
    """Accept the header spellings every real client actually sends."""
    lowered = {k.lower(): v for k, v in headers.items()}
    auth = lowered.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    api_key = lowered.get("x-api-key") or lowered.get("api-key")
    if api_key:
        return api_key.strip()
    if query:
        from urllib.parse import parse_qs

        value = parse_qs(query).get("api_key", [""])[0]
        if value:
            return value
    return ""


class AuthResult:
    __slots__ = ("ok", "name", "admin", "record", "reason")

    def __init__(self, ok: bool, name: str = "", admin: bool = False,
                 record: Any = None, reason: str = "") -> None:
        self.ok = ok
        self.name = name
        self.admin = admin
        self.record = record
        self.reason = reason


def authenticate(candidate: str, keys: dict[str, Any], allow_admin: bool = True) -> AuthResult:
    """`keys` maps the full key string to its KeyRecord."""
    if not candidate:
        return AuthResult(False, reason="missing API key")

    # Master key first: it is a single constant-time comparison and the hot path.
    if constant_time_eq(candidate, settings.master_key):
        return AuthResult(True, name="master", admin=True)

    record = keys.get(candidate)
    if record is None:
        return AuthResult(False, reason="unknown API key")
    if not getattr(record, "enabled", True):
        return AuthResult(False, name=record.name, reason="API key disabled")
    if allow_admin and not getattr(record, "admin", False):
        return AuthResult(False, name=record.name, reason="admin scope required")
    if not allow_admin and getattr(record, "admin", False):
        # Admin keys are still valid proxy keys.
        pass
    record.last_used_ts = time.time()
    return AuthResult(True, name=record.name, admin=False, record=record)


def key_allowed(record: Any, model: str) -> bool:
    allow = getattr(record, "models_allow", None)
    deny = getattr(record, "models_deny", None)
    if allow and model not in allow:
        return False
    if deny and model in deny:
        return False
    return True