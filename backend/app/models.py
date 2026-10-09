"""Pydantic schemas — the wire contract for /admin and the persisted shape of accounts."""
from __future__ import annotations

import time
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

ProviderType = Literal[
    "openai",       # OpenAI + every OpenAI-compatible endpoint
    "anthropic",    # Anthropic Messages API
    "google",       # Google Gemini generateContent
    "azure",        # Azure OpenAI (api-version query param)
    "bedrock",      # AWS Bedrock (native + Anthropic models)
]

Strategy = Literal[
    "round_robin",
    "failover",
    "weighted",
    "random",
    "least_latency",
    "least_cost",
    "least_requests",
    "priority",
]

STRATEGIES: list[str] = [
    "round_robin", "failover", "weighted", "random",
    "least_latency", "least_cost", "least_requests", "priority",
]


class RateLimitConfig(BaseModel):
    enabled: bool = True
    rpm: int = Field(default=60, ge=0, description="Requests per minute; 0 = unlimited")
    tpm: int = Field(default=0, ge=0, description="Tokens per minute; 0 = unlimited")
    burst: int = Field(default=10, ge=0, description="Burst capacity multiplier")
    concurrency: int = Field(default=0, ge=0, description="Max in-flight; 0 = unlimited")


class BudgetConfig(BaseModel):
    daily_usd: float = Field(default=0.0, ge=0, description="0 = unlimited")
    monthly_usd: float = Field(default=0.0, ge=0)
    hard_stop: bool = True


class ProxyConfig(BaseModel):
    enabled: bool = False
    url: str = ""

    @property
    def active_url(self) -> str:
        return self.url if (self.enabled and self.url) else ""


class RoutingConfig(BaseModel):
    """Per-account overrides on top of the global strategy."""

    strategy: Strategy | None = None
    cost_multiplier: float = Field(default=1.0, ge=0.0)


class ProviderAccount(BaseModel):
    """A single upstream credential/route."""

    model_config = ConfigDict(validate_assignment=False)

    name: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._\-]+$")
    provider_type: ProviderType = "openai"
    base_url: str = Field(default="https://api.openai.com/v1")
    api_key: str = ""

    models: list[str] = Field(default_factory=list)
    models_exact: bool = True
    models_deny: list[str] = Field(default_factory=list)

    weight: int = Field(default=1, ge=1, le=100)
    priority: int = Field(default=100, ge=0, le=1000, description="Lower wins")
    enabled: bool = True

    rate_limit: RateLimitConfig = Field(default_factory=RateLimitConfig)
    budget: BudgetConfig = Field(default_factory=BudgetConfig)
    routing: RoutingConfig = Field(default_factory=RoutingConfig)
    proxy: ProxyConfig = Field(default_factory=ProxyConfig)

    location: str = ""
    user_agent: str = ""
    extra_headers: dict[str, str] = Field(default_factory=dict)
    azure_api_version: str = "2024-10-21"
    aws_region: str = ""
    notes: str = ""

    # ── counters (persisted, never client-controlled) ─────────────────────
    created_ts: float = Field(default_factory=time.time)
    updated_ts: float = Field(default_factory=time.time)
    request_count: int = 0
    error_count: int = 0
    last_used: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0

    @field_validator("base_url")
    @classmethod
    def _strip_base_url(cls, value: str) -> str:
        return value.rstrip("/")

    def supports_model(self, model: str, matching: str = "exact") -> bool:
        if model in self.models_deny:
            return False
        if not self.models:
            return True  # unconstrained = wildcard
        if not self.models_exact:
            return True
        if matching == "prefix":
            return any(model.startswith(m) or m.startswith(model) for m in self.models)
        return model in self.models

    # ── secret handling ───────────────────────────────────────────────────
    def public(self) -> dict[str, Any]:
        """Account as exposed by the admin API: secrets masked."""
        data = self.model_dump()
        data["api_key"] = mask_secret(self.api_key)
        data["proxy"]["url"] = mask_secret(self.proxy.url) if self.proxy.url else ""
        data["api_key_masked"] = data["api_key"]
        data["proxy"]["url_masked"] = data["proxy"]["url"]
        return data


class AccountCreate(BaseModel):
    """Same fields; secrets may arrive in full and are stored encrypted."""

    name: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._\-]+$")
    provider_type: ProviderType = "openai"
    base_url: str = ""
    api_key: str = ""
    models: list[str] = Field(default_factory=list)
    models_exact: bool = True
    models_deny: list[str] = Field(default_factory=list)
    weight: int = Field(default=1, ge=1, le=100)
    priority: int = Field(default=100, ge=0, le=1000)
    enabled: bool = True
    rate_limit: RateLimitConfig = Field(default_factory=RateLimitConfig)
    budget: BudgetConfig = Field(default_factory=BudgetConfig)
    routing: RoutingConfig = Field(default_factory=RoutingConfig)
    proxy: ProxyConfig = Field(default_factory=ProxyConfig)
    location: str = ""
    user_agent: str = ""
    extra_headers: dict[str, str] = Field(default_factory=dict)
    azure_api_version: str = "2024-10-21"
    aws_region: str = ""
    notes: str = ""

    def to_account(self) -> ProviderAccount:
        base_url = self.base_url.strip() or default_base_url(self.provider_type)
        return ProviderAccount(
            name=self.name, provider_type=self.provider_type, base_url=base_url,
            api_key=self.api_key, models=self.models, models_exact=self.models_exact,
            models_deny=self.models_deny, weight=self.weight, priority=self.priority,
            enabled=self.enabled, rate_limit=self.rate_limit, budget=self.budget,
            routing=self.routing, proxy=self.proxy, location=self.location,
            user_agent=self.user_agent, extra_headers=self.extra_headers,
            azure_api_version=self.azure_api_version, aws_region=self.aws_region,
            notes=self.notes,
        )


class AccountPatch(BaseModel):
    """Partial update. Omitted fields keep their current value."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=64,
                                 pattern=r"^[A-Za-z0-9._\-]+$")
    provider_type: Optional[ProviderType] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    models: Optional[list[str]] = None
    models_exact: Optional[bool] = None
    models_deny: Optional[list[str]] = None
    weight: Optional[int] = Field(default=None, ge=1, le=100)
    priority: Optional[int] = Field(default=None, ge=0, le=1000)
    enabled: Optional[bool] = None
    rate_limit: Optional[RateLimitConfig] = None
    budget: Optional[BudgetConfig] = None
    routing: Optional[RoutingConfig] = None
    proxy: Optional[ProxyConfig] = None
    location: Optional[str] = None
    user_agent: Optional[str] = None
    extra_headers: Optional[dict[str, str]] = None
    azure_api_version: Optional[str] = None
    aws_region: Optional[str] = None
    notes: Optional[str] = None


def default_base_url(provider_type: str) -> str:
    return {
        "openai": "https://api.openai.com/v1",
        "anthropic": "https://api.anthropic.com/v1",
        "google": "https://generativelanguage.googleapis.com/v1beta",
        "azure": "",
        "bedrock": "https://bedrock-runtime.us-east-1.amazonaws.com",
    }.get(provider_type, "https://api.openai.com/v1")


def mask_secret(value: str) -> str:
    """`sk-proj-abcdef…4f2a` — enough to identify, never enough to use."""
    if not value:
        return ""
    if len(value) <= 12:
        return value[:3] + "…" + value[-2:]
    return f"{value[:8]}…{value[-4:]}"