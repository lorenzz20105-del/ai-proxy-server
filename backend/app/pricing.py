"""Model pricing and cost accounting.

Rates are USD per **1M** tokens. `cached` is the discounted input rate for provider
prompt caching. Costs are estimated when an upstream omits `usage` — the estimator is
deliberately marked as an estimate so the dashboard can show it.
"""
from __future__ import annotations

import fnmatch
import re
import threading
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Price:
    input: float
    output: float
    cached_input: float | None = None   # defaults to `input` when None
    reasoning: float | None = None      # reasoning tokens, defaults to `output`

    def as_dict(self) -> dict[str, float | None]:
        return {
            "input_per_1m": self.input,
            "output_per_1m": self.output,
            "cached_input_per_1m": self.cached_input if self.cached_input is not None else self.input,
        }


# ── the table ──────────────────────────────────────────────────────────────
PRICES: dict[str, Price] = {
    # OpenAI
    "gpt-4o":               Price(2.50, 10.00, 1.25),
    "gpt-4o-2024-08-06":    Price(2.50, 10.00, 1.25),
    "gpt-4o-mini":          Price(0.15, 0.60, 0.075),
    "gpt-4.1":              Price(2.00, 8.00, 0.50),
    "gpt-4.1-mini":         Price(0.40, 1.60, 0.10),
    "gpt-4.1-nano":         Price(0.10, 0.40, 0.025),
    "gpt-4-turbo":          Price(10.00, 30.00),
    "gpt-4":                Price(30.00, 60.00),
    "gpt-3.5-turbo":        Price(0.50, 1.50),
    "o1":                   Price(15.00, 60.00, 7.50, 60.00),
    "o1-mini":              Price(1.10, 4.40, 0.55, 4.40),
    "o1-preview":           Price(15.00, 60.00, 7.50, 60.00),
    "o3-mini":              Price(1.10, 4.40, 0.55),
    "o3":                   Price(2.00, 8.00, 0.50),
    "o4-mini":              Price(1.10, 4.40, 0.275),
    "gpt-5":                Price(1.25, 10.00, 0.125),
    "gpt-5-mini":           Price(0.25, 2.00, 0.025),
    "gpt-5-nano":           Price(0.05, 0.40, 0.005),
    "text-embedding-3-small": Price(0.02, 0.0),
    "text-embedding-3-large": Price(0.13, 0.0),
    "text-embedding-ada-002": Price(0.10, 0.0),
    "dall-e-3":             Price(0.0, 0.0),   # billed per image, not per token

    # Anthropic
    "claude-3-haiku-20240307":    Price(0.25, 1.25, 0.03),
    "claude-3-5-haiku-latest":    Price(0.80, 4.00, 0.08),
    "claude-3-5-sonnet-latest":   Price(3.00, 15.00, 0.30),
    "claude-3-5-sonnet-20241022": Price(3.00, 15.00, 0.30),
    "claude-3-7-sonnet-latest":   Price(3.00, 15.00, 0.30),
    "claude-sonnet-4-20250514":   Price(3.00, 15.00, 0.30),
    "claude-sonnet-4-5":          Price(3.00, 15.00, 0.30),
    "claude-opus-4-20250514":     Price(15.00, 75.00, 1.50),
    "claude-opus-4-1":            Price(15.00, 75.00, 1.50),
    "claude-opus-4-5":            Price(5.00, 25.00, 0.50),

    # Google
    "gemini-1.5-flash":       Price(0.075, 0.30, 0.0187),
    "gemini-1.5-pro":         Price(1.25, 5.00),
    "gemini-2.0-flash":       Price(0.10, 0.40, 0.025),
    "gemini-2.0-flash-lite":  Price(0.075, 0.30),
    "gemini-2.5-flash":       Price(0.30, 2.50, 0.075),
    "gemini-2.5-flash-lite":  Price(0.10, 0.40, 0.025),
    "gemini-2.5-pro":         Price(1.25, 10.00, 0.31),

    # Common OpenAI-compatible providers
    "deepseek-chat":          Price(0.27, 1.10, 0.07),
    "deepseek-reasoner":      Price(0.55, 2.19, 0.14, 2.19),
    "llama-3.3-70b-versatile": Price(0.59, 0.79),
    "llama-3.1-8b-instant":   Price(0.05, 0.08),
    "mistral-large-latest":   Price(2.00, 6.00),
    "mistral-small-latest":   Price(0.20, 0.60),
    "command-r-plus":         Price(2.50, 10.00),
    "qwen-max":               Price(1.60, 6.40),
}

# Providers that serve open models for free — never charge for these.
FREE_PREFIXES = ("ollama/", "lmstudio/", "local/", "vllm/", "free:")

# Fallbacks applied when the model is not in the table.
BEDROCK_VENDORS = {"anthropic", "amazon", "meta", "mistral", "cohere", "ai21",
                   "deepseek", "writer", "luma"}

FALLBACK_PRICE = Price(1.00, 3.00)
CHEAP_PRICE = Price(0.10, 0.40)

# Context windows (tokens) for /v1/models metadata.
CONTEXT_WINDOWS: list[tuple[str, int]] = [
    ("gpt-5", 400_000), ("o3", 200_000), ("o4-mini", 200_000), ("o1", 200_000),
    ("gpt-4.1", 1_047_576), ("gpt-4o", 128_000), ("gpt-4-turbo", 128_000),
    ("gpt-4", 8_192), ("gpt-3.5-turbo", 16_385),
    ("claude-opus-4", 200_000), ("claude-sonnet-4", 200_000),
    ("claude-3-7-sonnet", 200_000), ("claude-3-5-sonnet", 200_000), ("claude-3", 200_000),
    ("gemini-2.5", 1_048_576), ("gemini-2.0", 1_048_576), ("gemini-1.5", 2_097_152),
    ("deepseek", 65_536), ("qwen", 32_768), ("llama-3", 128_000),
]


def _normalise(model: str) -> str:
    """`openai/gpt-4o`, `gpt-4o-2024-08-06`, `anthropic.claude-...` → a lookup key."""
    name = model.strip().lower()
    if "/" in name:
        name = name.rsplit("/", 1)[-1]
    # Bedrock style: anthropic.claude-3-5-sonnet-20241022-v2:0 — only strip a
    # *vendor* prefix, otherwise "gemini-2.5-pro" loses its "gemini-2".
    head, sep, tail = name.partition(".")
    if sep and tail and (head in BEDROCK_VENDORS or head.startswith(("us", "eu", "ap", "sa"))):
        name = tail
    if ":" in name:
        name = name.split(":", 1)[0]
    return name


def get_price(model: str) -> Price:
    raw = model.strip().lower()
    if raw.startswith(FREE_PREFIXES):
        return Price(0.0, 0.0)

    name = _normalise(model)
    if name in PRICES:
        return PRICES[name]

    # Longest-prefix match: gpt-4o-mini-2024-07-18 → gpt-4o-mini
    best: tuple[int, Price] | None = None
    for key, price in PRICES.items():
        if name.startswith(key) and (best is None or len(key) > best[0]):
            best = (len(key), price)
    if best:
        return best[1]

    # Date-stamped / family variants: gemini-2.0-flash-exp → gemini-2.0-flash
    for key, price in PRICES.items():
        if fnmatch.fnmatch(name, key + "*"):
            return price

    # Heuristic families — cheap local models must never be billed at $15/M.
    if re.search(r"(mini|nano|flash|haiku|small|tiny|lite|8b|7b|3b|1b)", name):
        return CHEAP_PRICE
    if re.search(r"(opus|ultra|max|pro|large|70b|405b)", name):
        return Price(3.00, 15.00)
    return FALLBACK_PRICE


def context_window(model: str) -> int:
    name = _normalise(model)
    for prefix, window in CONTEXT_WINDOWS:
        if name.startswith(prefix):
            return window
    return 8_192


@dataclass
class CostBreakdown:
    cost_usd: float
    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int = 0
    reasoning_tokens: int = 0
    estimated: bool = False
    price: Price | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "cost_usd": round(self.cost_usd, 8),
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cached_tokens": self.cached_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "estimated": self.estimated,
        }


def compute_cost(
    model: str,
    usage: dict[str, Any] | None,
    multiplier: float = 1.0,
) -> CostBreakdown:
    """Cost for one request. `usage` is an OpenAI-shaped usage dict."""
    usage = usage or {}
    prompt = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    completion = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    cached = int(
        usage.get("prompt_tokens_details", {}).get("cached_tokens")
        or usage.get("cache_read_input_tokens")
        or usage.get("cached_tokens")
        or 0
    )
    reasoning = int(
        (usage.get("completion_tokens_details", {}) or {}).get("reasoning_tokens")
        or usage.get("reasoning_tokens")
        or 0
    )

    price = get_price(model)
    billable_input = max(0, prompt - cached)
    cached_rate = price.cached_input if price.cached_input is not None else price.input
    output_rate = price.reasoning if (reasoning and price.reasoning is not None) else price.output

    cost = (
        billable_input * price.input
        + cached * cached_rate
        + completion * output_rate
    ) / 1_000_000
    cost *= max(0.0, multiplier)

    return CostBreakdown(
        cost_usd=cost,
        prompt_tokens=prompt,
        completion_tokens=completion,
        cached_tokens=cached,
        reasoning_tokens=reasoning,
        estimated=False,
        price=price,
    )


# ── token estimation ───────────────────────────────────────────────────────
# ~3.6 chars/token for English prose; good enough to keep cost tracking honest when
# an upstream streams without `stream_options.include_usage`.
_CHARS_PER_TOKEN = 3.6


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(text) / _CHARS_PER_TOKEN))


def estimate_prompt_tokens(body: dict[str, Any]) -> int:
    total = 0
    for message in body.get("messages") or []:
        content = message.get("content")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    if part.get("type") == "text":
                        total += estimate_tokens(str(part.get("text", "")))
                    elif part.get("type") == "image_url":
                        total += 765  # flat-rate low-detail image estimate
        total += 4  # per-message role/framing overhead
    for tool in body.get("tools") or []:
        total += estimate_tokens(str(tool))
    return total


def estimate_completion_tokens(text: str) -> int:
    return estimate_tokens(text)


# ── runtime overrides ──────────────────────────────────────────────────────
class PriceOverrides:
    """Per-model price overrides set through the admin API."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._overrides: dict[str, Price] = {}

    def set(self, model: str, price: Price) -> None:
        with self._lock:
            self._overrides[_normalise(model)] = price

    def remove(self, model: str) -> None:
        with self._lock:
            self._overrides.pop(_normalise(model), None)

    def clear(self) -> None:
        with self._lock:
            self._overrides.clear()

    def get(self, model: str) -> Price:
        with self._lock:
            override = self._overrides.get(_normalise(model))
        return override if override is not None else get_price(model)

    def as_dict(self) -> dict[str, dict[str, float | None]]:
        with self._lock:
            return {k: v.as_dict() for k, v in self._overrides.items()}


price_overrides = PriceOverrides()


def get_pricing_table() -> dict[str, dict[str, float | None]]:
    table = {name: price.as_dict() for name, price in sorted(PRICES.items())}
    table.update(price_overrides.as_dict())
    return table