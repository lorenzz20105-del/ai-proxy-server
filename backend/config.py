"""Configuration for the AI proxy server."""
import os
import secrets
from pydantic import BaseModel
from typing import Literal, Optional

MASTER_API_KEY = os.environ.get("PROXY_MASTER_KEY", secrets.token_urlsafe(32))
ROUTING_STRATEGY: Literal["round_robin", "failover", "weighted", "random"] = \
    os.environ.get("PROXY_ROUTING", "round_robin")

ProviderType = Literal["openai", "claude", "google", "custom"]

class ProviderAccount(BaseModel):
    name: str
    base_url: str
    api_key: str
    models: list[str] = []
    provider_type: ProviderType = "openai"
    weight: int = 1
    enabled: bool = True
    healthy: bool = True
    request_count: int = 0
    error_count: int = 0
    last_used: float = 0.0
    # ── Proxy / location settings ──
    proxy_url: Optional[str] = None        # e.g. "http://user:pass@proxy:8080" or "socks5://proxy:1080"
    location: Optional[str] = None         # human label like "US-East", "EU-West"
    user_agent: Optional[str] = None       # custom UA to avoid fingerprinting

ACCOUNTS: list[ProviderAccount] = [
    ProviderAccount(
        name="openai-primary",
        base_url="https://api.openai.com/v1",
        api_key=os.environ.get("OPENAI_KEY_1", "sk-placeholder-1"),
        models=["gpt-4o", "gpt-4o-mini", "o1-preview"],
        provider_type="openai",
        location="US-East",
    ),
    ProviderAccount(
        name="openai-secondary",
        base_url="https://api.openai.com/v1",
        api_key=os.environ.get("OPENAI_KEY_2", "sk-placeholder-2"),
        models=["gpt-4o", "gpt-4o-mini"],
        provider_type="openai",
        location="EU-West",
    ),
    ProviderAccount(
        name="anthropic",
        base_url="https://api.anthropic.com/v1",
        api_key=os.environ.get("ANTHROPIC_KEY_1", "sk-ant-placeholder-1"),
        models=["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
        provider_type="claude",
        location="US-West",
    ),
    ProviderAccount(
        name="google",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        api_key=os.environ.get("GOOGLE_KEY_1", "goog-placeholder-1"),
        models=["gemini-2.0-flash", "gemini-2.5-pro"],
        provider_type="google",
        location="Asia-Pacific",
    ),
]

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "proxy_config.json")
LOGS_FILE = os.path.join(os.path.dirname(__file__), "proxy_logs.json")
