"""Unit tests for the pure pieces: translation, cache keys, breaker, pricing, limits."""
from __future__ import annotations

import time

import pytest

from app.breaker import CLOSED, HALF_OPEN, OPEN, CircuitBreaker
from app.cache import ResponseCache, cache_key, is_deterministic
from app.pricing import Price, compute_cost, context_window, estimate_prompt_tokens, get_price
from app.ratelimit import RateLimiter
from app.translator import (
    anthropic_to_openai,
    gemini_to_openai,
    openai_to_anthropic,
    openai_to_gemini,
    split_system,
    text_of,
)


# ── translation ────────────────────────────────────────────────────────────
class TestOpenAIToAnthropic:
    def test_basic_shape(self):
        out = openai_to_anthropic(
            {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 64}, "claude-x")
        assert out["model"] == "claude-x"
        assert out["max_tokens"] == 64
        assert out["messages"] == [{"role": "user",
                                    "content": [{"type": "text", "text": "hi"}]}]

    def test_system_is_extracted(self):
        out = openai_to_anthropic(
            {"messages": [{"role": "system", "content": "be terse"},
                          {"role": "user", "content": "hi"}]}, "claude-x")
        assert out["system"] == "be terse"
        assert all(m["role"] != "system" for m in out["messages"])

    def test_max_tokens_is_required(self):
        out = openai_to_anthropic({"messages": [{"role": "user", "content": "hi"}]}, "c")
        assert "max_tokens" in out and out["max_tokens"] > 0

    def test_transcript_must_start_with_user(self):
        out = openai_to_anthropic(
            {"messages": [{"role": "assistant", "content": "prev"}]}, "c")
        assert out["messages"][0]["role"] == "user"

    def test_consecutive_roles_are_merged(self):
        out = openai_to_anthropic({"messages": [
            {"role": "user", "content": "a"},
            {"role": "user", "content": "b"},
        ]}, "c")
        assert len(out["messages"]) == 1
        assert "a" in text_of(out["messages"][0]["content"])
        assert "b" in text_of(out["messages"][0]["content"])

    def test_tools_are_converted(self):
        out = openai_to_anthropic({
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [{"type": "function", "function": {
                "name": "get_weather",
                "description": "d",
                "parameters": {"type": "object",
                               "properties": {"city": {"type": "string"}}},
            }}],
            "tool_choice": "required",
        }, "c")
        assert out["tools"][0]["name"] == "get_weather"
        assert "input_schema" in out["tools"][0]
        assert out["tool_choice"] == {"type": "any"}

    def test_tool_results_become_tool_result_blocks(self):
        out = openai_to_anthropic({"messages": [
            {"role": "user", "content": "weather?"},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": {"name": "get_weather", "arguments": '{"city":"Oslo"}'}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "12C"},
        ]}, "c")
        kinds = [b["type"] for m in out["messages"] for b in m["content"]]
        assert "tool_use" in kinds and "tool_result" in kinds

    def test_stop_sequences_capped_at_four(self):
        out = openai_to_anthropic(
            {"messages": [{"role": "user", "content": "x"}], "stop": list("abcdefg")}, "c")
        assert len(out["stop_sequences"]) == 4

    def test_base64_image(self):
        out = openai_to_anthropic({"messages": [{
            "role": "user",
            "content": [{"type": "image_url",
                         "image_url": {"url": "data:image/png;base64,AAA"}}]}]}, "c")
        block = out["messages"][0]["content"][0]
        assert block["type"] == "image"
        assert block["source"] == {"type": "base64", "media_type": "image/png", "data": "AAA"}


class TestAnthropicToOpenAI:
    def test_text_and_usage(self):
        out = anthropic_to_openai({
            "id": "msg_1", "model": "claude-x", "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "hey"}],
            "usage": {"input_tokens": 12, "output_tokens": 3, "cache_read_input_tokens": 4},
        }, "claude-x")
        assert out["choices"][0]["message"]["content"] == "hey"
        assert out["choices"][0]["finish_reason"] == "stop"
        assert out["usage"]["prompt_tokens"] == 12
        assert out["usage"]["total_tokens"] == 15
        assert out["usage"]["prompt_tokens_details"]["cached_tokens"] == 4

    def test_tool_use_maps_to_tool_calls(self):
        out = anthropic_to_openai({
            "id": "msg_2", "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": "toolu_1", "name": "f", "input": {"a": 1}}],
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }, "c")
        call = out["choices"][0]["message"]["tool_calls"][0]
        assert call["function"]["name"] == "f"
        assert call["function"]["arguments"] == '{"a":1}'
        assert out["choices"][0]["finish_reason"] == "tool_calls"

    @pytest.mark.parametrize("reason,expected", [
        ("end_turn", "stop"), ("max_tokens", "length"),
        ("tool_use", "tool_calls"), ("refusal", "content_filter"),
    ])
    def test_stop_reason_mapping(self, reason, expected):
        out = anthropic_to_openai(
            {"id": "m", "stop_reason": reason, "content": [], "usage": {}}, "c")
        assert out["choices"][0]["finish_reason"] == expected


class TestGemini:
    def test_request_shape(self):
        out = openai_to_gemini({
            "messages": [{"role": "system", "content": "s"},
                         {"role": "user", "content": "hi"},
                         {"role": "assistant", "content": "yo"},
                         {"role": "user", "content": "more"}],
            "temperature": 0.5, "max_tokens": 100,
        }, "gemini-2.5-pro")
        assert out["systemInstruction"]["parts"][0]["text"] == "s"
        assert [c["role"] for c in out["contents"]] == ["user", "model", "user"]
        assert out["generationConfig"]["maxOutputTokens"] == 100
        assert out["generationConfig"]["temperature"] == 0.5

    def test_response_shape(self):
        out = gemini_to_openai({
            "candidates": [{"content": {"parts": [{"text": "hi there"}]},
                            "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2,
                              "totalTokenCount": 7},
        }, "gemini-2.5-pro")
        assert out["choices"][0]["message"]["content"] == "hi there"
        assert out["usage"]["prompt_tokens"] == 5
        assert out["choices"][0]["finish_reason"] == "stop"

    def test_function_calls(self):
        out = gemini_to_openai({
            "candidates": [{"content": {"parts": [
                {"functionCall": {"name": "f", "args": {"x": 1}}}]},
                "finishReason": "STOP"}],
            "usageMetadata": {},
        }, "g")
        call = out["choices"][0]["message"]["tool_calls"][0]
        assert call["function"]["name"] == "f"
        assert out["choices"][0]["finish_reason"] == "tool_calls"

    def test_safety_maps_to_content_filter(self):
        out = gemini_to_openai(
            {"candidates": [{"content": {"parts": []}, "finishReason": "SAFETY"}]}, "g")
        assert out["choices"][0]["finish_reason"] == "content_filter"


def test_split_system_and_text_of():
    system, rest = split_system([
        {"role": "system", "content": "a"},
        {"role": "developer", "content": "b"},
        {"role": "user", "content": "c"},
    ])
    assert system == "a\n\nb"
    assert len(rest) == 1
    assert text_of([{"type": "text", "text": "x"}, {"type": "text", "text": "y"}]) == "xy"


# ── cache ──────────────────────────────────────────────────────────────────
class TestCache:
    def test_key_covers_sampling_parameters(self):
        base = {"messages": [{"role": "user", "content": "hi"}], "model": "m"}
        hot = {**base, "temperature": 0}
        cold = {**base, "temperature": 1}
        assert cache_key(base, "m") != cache_key(hot, "m")
        assert cache_key(hot, "m") != cache_key(cold, "m")

    def test_key_ignores_irrelevant_fields(self):
        base = {"messages": [{"role": "user", "content": "hi"}], "model": "m", "temperature": 0}
        with_user = {**base, "user": "alice"}
        assert cache_key(base, "m") == cache_key(with_user, "m")

    def test_key_differs_by_model(self):
        body = {"messages": [{"role": "user", "content": "hi"}]}
        assert cache_key(body, "a") != cache_key(body, "b")

    def test_determinism_rules(self):
        assert is_deterministic({"temperature": 0})
        assert is_deterministic({"seed": 42})
        assert not is_deterministic({"temperature": 0.7})
        assert not is_deterministic({})

    def test_ttl_expiry(self):
        cache = ResponseCache(ttl=0.05, max_entries=10)
        cache.set("k", {"a": 1})
        assert cache.get("k") == {"a": 1}
        time.sleep(0.08)
        assert cache.get("k") is None

    def test_lru_eviction(self):
        cache = ResponseCache(ttl=60, max_entries=2)
        cache.set("a", {"v": 1})
        cache.set("b", {"v": 2})
        cache.get("a")            # 'a' becomes most-recently-used
        cache.set("c", {"v": 3})
        assert cache.get("b") is None
        assert cache.get("a") == {"v": 1}

    def test_stats(self):
        cache = ResponseCache(ttl=60, max_entries=10)
        cache.set("k", {"a": 1})
        cache.get("k")
        cache.get("missing")
        stats = cache.stats()
        assert stats["entries"] == 1 and stats["hits"] == 1 and stats["misses"] == 1
        assert 0 < stats["hit_rate"] < 1


# ── circuit breaker ────────────────────────────────────────────────────────
class TestCircuitBreaker:
    def test_opens_after_threshold(self):
        cb = CircuitBreaker(failure_threshold=3, success_threshold=1, cooldown=30)
        for _ in range(2):
            cb.on_failure("a", "boom")
            assert cb.status("a") == CLOSED
        cb.on_failure("a", "boom")
        assert cb.status("a") == OPEN

    def test_cooldown_opens_half_open_and_probe_gate(self):
        cb = CircuitBreaker(failure_threshold=1, success_threshold=1, cooldown=0.2,
                            half_open_max_concurrency=1)
        cb.on_failure("a")
        assert cb.try_acquire("a") is False        # still cooling down
        time.sleep(0.25)
        assert cb.status("a") == HALF_OPEN
        assert cb.try_acquire("a") is True         # one probe
        assert cb.try_acquire("a") is False        # gate holds

    def test_half_open_success_closes(self):
        cb = CircuitBreaker(failure_threshold=1, success_threshold=2, cooldown=0.1)
        cb.on_failure("a")
        time.sleep(0.15)
        cb.try_acquire("a")
        cb.on_success("a")
        assert cb.status("a") == HALF_OPEN
        cb.try_acquire("a")
        cb.on_success("a")
        assert cb.status("a") == CLOSED

    def test_failed_probe_reopens_immediately(self):
        # threshold 1 so the circuit is genuinely open before the probe
        cb = CircuitBreaker(failure_threshold=1, success_threshold=2, cooldown=0.1)
        cb.on_failure("a")
        assert cb.status("a") == OPEN
        time.sleep(0.15)
        assert cb.status("a") == HALF_OPEN
        cb.try_acquire("a")
        cb.on_failure("a", "still broken")
        assert cb.status("a") == OPEN

    def test_success_resets_streak(self):
        cb = CircuitBreaker(failure_threshold=3)
        cb.on_failure("a")
        cb.on_failure("a")
        cb.on_success("a")
        cb.on_failure("a")
        assert cb.status("a") == CLOSED

    def test_manual_disable_and_reset(self):
        cb = CircuitBreaker()
        cb.disable("a", 30)
        assert cb.status("a") == OPEN
        assert cb.try_acquire("a") is False
        cb.enable("a")
        assert cb.status("a") == CLOSED


# ── rate limiting ──────────────────────────────────────────────────────────
class TestRateLimiter:
    def test_rpm_limit(self):
        rl = RateLimiter()
        rl.configure("s", rpm=2, tpm=0, burst=1, concurrency=0)
        assert rl.check("s").allowed
        assert rl.check("s").allowed
        denied = rl.check("s")
        assert not denied.allowed and denied.scope == "rpm" and denied.retry_after > 0

    def test_refills_over_time(self):
        rl = RateLimiter()
        rl.configure("s", rpm=60, tpm=0, burst=1, concurrency=0)
        for _ in range(60):
            rl.check("s")
        assert not rl.check("s").allowed
        time.sleep(1.1)
        assert rl.check("s").allowed

    def test_tpm_refunds_request_token(self):
        rl = RateLimiter()
        rl.configure("s", rpm=10, tpm=100, burst=1, concurrency=0)
        assert rl.check("s", tokens=10).allowed
        denied = rl.check("s", tokens=500)
        assert not denied.allowed and denied.scope == "tpm"
        # the rpm token must not have been consumed by the rejected call
        assert rl.check("s", tokens=0).allowed

    def test_concurrency_cap(self):
        rl = RateLimiter()
        rl.configure("s", rpm=0, tpm=0, burst=1, concurrency=2)
        rl.acquire("s")
        rl.acquire("s")
        assert not rl.check("s").allowed
        rl.release("s")
        assert rl.check("s").allowed

    def test_unlimited_when_zero(self):
        rl = RateLimiter()
        rl.configure("s", rpm=0, tpm=0, burst=1, concurrency=0)
        for _ in range(500):
            assert rl.check("s").allowed


# ── pricing ────────────────────────────────────────────────────────────────
class TestPricing:
    def test_known_models(self):
        assert get_price("gpt-4o").input == 2.50
        assert get_price("claude-sonnet-4-20250514").output == 15.00
        assert get_price("gemini-2.5-flash").input == 0.30

    def test_vendor_prefixed_names(self):
        assert get_price("openai/gpt-4o").input == 2.50
        assert get_price("anthropic.claude-3-5-sonnet-20241022-v2:0").input == 3.00

    def test_dated_variants(self):
        assert get_price("gpt-4o-2024-08-06").input == 2.50

    def test_local_models_are_free(self):
        assert get_price("ollama/llama3").input == 0.0
        assert get_price("lmstudio/qwen").output == 0.0

    def test_unknown_cheap_family_does_not_bill_like_a_flagship(self):
        assert get_price("some-unknown-nano-model").input < 1.0

    def test_cost_computation(self):
        breakdown = compute_cost("gpt-4o", {"prompt_tokens": 1_000_000,
                                            "completion_tokens": 1_000_000})
        assert breakdown.cost_usd == pytest.approx(12.50)

    def test_cached_tokens_use_the_discount_rate(self):
        breakdown = compute_cost("gpt-4o", {
            "prompt_tokens": 1_000_000, "completion_tokens": 0,
            "prompt_tokens_details": {"cached_tokens": 1_000_000}})
        assert breakdown.cost_usd == pytest.approx(1.25)

    def test_multiplier(self):
        assert compute_cost("gpt-4o", {"prompt_tokens": 1_000_000}, 2.0).cost_usd == \
            pytest.approx(5.00)

    def test_missing_usage_is_zero_not_a_crash(self):
        assert compute_cost("gpt-4o", None).cost_usd == 0.0

    def test_context_window(self):
        assert context_window("gpt-4o") == 128_000
        assert context_window("claude-sonnet-4-20250514") == 200_000
        assert context_window("gemini-2.5-pro") == 1_048_576

    def test_prompt_estimation_grows_with_content(self):
        small = estimate_prompt_tokens({"messages": [{"role": "user", "content": "hi"}]})
        big = estimate_prompt_tokens({"messages": [{"role": "user", "content": "hi" * 500}]})
        assert big > small * 50

    def test_overrides(self):
        from app.pricing import price_overrides

        price_overrides.set("my-model", Price(1.0, 2.0))
        assert get_price("my-model").input == 1.0
        price_overrides.remove("my-model")