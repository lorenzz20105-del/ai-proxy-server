"""Request/response translation between the OpenAI wire format and the Anthropic
Messages API and Google Gemini `generateContent` API.

v2 forwarded OpenAI-shaped JSON straight at `/v1/messages` and
`/models/{m}:generateContent`, so the Anthropic and Google integrations could not have
worked even once. This module is what makes "OpenAI-compatible" true.

Everything here is pure and synchronous on purpose: translation must never be able to
fail halfway through a stream.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, AsyncIterator

# ── shared helpers ─────────────────────────────────────────────────────────
DEFAULT_MAX_TOKENS = 4096

ANTHROPIC_FINISH = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "pause_turn": "stop",
    "refusal": "content_filter",
}

GEMINI_FINISH = {
    "STOP": "stop",
    "MAX_TOKENS": "length",
    "SAFETY": "content_filter",
    "RECITATION": "content_filter",
    "BLOCKLIST": "content_filter",
    "PROHIBITED_CONTENT": "content_filter",
    "SPII": "content_filter",
    "MALFORMED_FUNCTION_CALL": "stop",
    "OTHER": "stop",
}


def new_id(prefix: str = "chatcmpl-") -> str:
    return prefix + uuid.uuid4().hex[:24]


def _now() -> int:
    return int(time.time())


def text_of(content: Any) -> str:
    """Flatten OpenAI content (string or content-part list) to plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text", "")))
        return "".join(parts)
    return str(content)


def split_system(messages: list[dict]) -> tuple[str, list[dict]]:
    """Pull system/developer messages out of an OpenAI message list."""
    system_parts: list[str] = []
    rest: list[dict] = []
    for message in messages:
        if message.get("role") in ("system", "developer"):
            text = text_of(message.get("content"))
            if text:
                system_parts.append(text)
        else:
            rest.append(message)
    return "\n\n".join(system_parts), rest


def merge_runs(messages: list[dict], allowed_roles: tuple[str, ...],
               first_role: str, content_key: str = "content") -> list[dict]:
    """Merge consecutive same-role turns; upstream APIs reject unmerged runs.

    Anthropic additionally requires the transcript to start with `user`. Gemini turns
    carry their payload under `parts` rather than `content`.
    """
    out: list[dict] = []
    for message in messages:
        role = message.get("role", "user")
        if role not in allowed_roles:
            role = allowed_roles[0]
        payload = message.get(content_key)
        if out and out[-1]["role"] == role:
            if isinstance(out[-1][content_key], list) and isinstance(payload, list):
                out[-1][content_key].extend(payload)
            else:
                out[-1][content_key] = (
                    f"{out[-1][content_key]}\n\n{text_of(payload)}"
                    if isinstance(payload, str)
                    else out[-1][content_key]
                )
        else:
            out.append({"role": role, content_key: payload})

    if allowed_roles and out and out[0]["role"] != first_role:
        filler = ([{"type": "text", "text": "(continue)"}] if content_key == "content"
                  else [{"text": "(continue)"}])
        out.insert(0, {"role": first_role, content_key: filler})
    return out


def tool_calls_to_openai(content: list[dict]) -> list[dict]:
    calls = []
    for block in content:
        if block.get("type") == "tool_use":
            calls.append({
                "id": block.get("id", f"call_{uuid.uuid4().hex[:16]}"),
                "type": "function",
                "function": {
                    "name": block.get("name", ""),
                    "arguments": json.dumps(block.get("input", {}), separators=(",", ":")),
                },
            })
    return calls


# ── OpenAI → Anthropic ─────────────────────────────────────────────────────
def openai_to_anthropic(body: dict[str, Any], model: str) -> dict[str, Any]:
    system_text, messages = split_system(body.get("messages") or [])
    converted: list[dict[str, Any]] = []

    staged: list[dict[str, Any]] = []

    for message in messages:
        role = message.get("role", "user")

        # Anthropic returns tool results as user-role `tool_result` blocks.
        if role == "tool":
            staged.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": message.get("tool_call_id", ""),
                    "content": text_of(message.get("content")),
                }],
            })
            continue

        role = "assistant" if role == "assistant" else "user"
        blocks: list[dict[str, Any]] = []
        content = message.get("content")

        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    blocks.append({"type": "text", "text": str(part)})
                elif part.get("type") == "text":
                    blocks.append({"type": "text", "text": part.get("text", "")})
                elif part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url", "")
                    if url.startswith("data:"):
                        header, _, b64 = url.partition(",")
                        media = header.split(";")[0].removeprefix("data:") or "image/png"
                        blocks.append({
                            "type": "image",
                            "source": {"type": "base64", "media_type": media, "data": b64},
                        })
                    elif url:
                        blocks.append({"type": "image", "source": {"type": "url", "url": url}})
        elif content:
            blocks.append({"type": "text", "text": text_of(content)})

        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            try:
                arguments = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                arguments = {"__raw": function.get("arguments", "")}
            blocks.append({
                "type": "tool_use",
                "id": call.get("id", f"toolu_{uuid.uuid4().hex[:20]}"),
                "name": function.get("name", ""),
                "input": arguments,
            })

        if blocks:
            staged.append({"role": role, "content": blocks})

    converted = [
        {"role": m["role"], "content": m["content"]}
        for m in merge_runs(staged, ("user", "assistant"), "user")
    ]

    if not converted:
        converted = [{"role": "user", "content": [{"type": "text", "text": "(continue)"}]}]

    out: dict[str, Any] = {
        "model": model,
        "messages": converted,
        "max_tokens": int(
            body.get("max_tokens") or body.get("max_completion_tokens") or DEFAULT_MAX_TOKENS
        ),
    }
    if system_text:
        out["system"] = system_text
    if body.get("stream"):
        out["stream"] = True
    if body.get("temperature") is not None:
        out["temperature"] = float(body["temperature"])
    if body.get("top_p") is not None:
        out["top_p"] = float(body["top_p"])
    if body.get("stop"):
        stops = body["stop"] if isinstance(body["stop"], list) else [body["stop"]]
        out["stop_sequences"] = [str(s) for s in stops][:4]

    tools = body.get("tools") or []
    anthropic_tools = []
    for tool in tools:
        function = tool.get("function") or {}
        if not function.get("name"):
            continue
        anthropic_tools.append({
            "name": function["name"],
            "description": function.get("description", ""),
            "input_schema": function.get("parameters") or {"type": "object", "properties": {}},
        })
    if anthropic_tools:
        out["tools"] = anthropic_tools
        choice = body.get("tool_choice")
        if choice in (None, "auto"):
            out["tool_choice"] = {"type": "auto"}
        elif choice == "required":
            out["tool_choice"] = {"type": "any"}
        elif choice == "none":
            out.pop("tools")
            out.pop("tool_choice", None)
        elif isinstance(choice, dict) and choice.get("type") == "function":
            out["tool_choice"] = {"type": "tool", "name": choice["function"]["name"]}
    return out


def anthropic_to_openai(data: dict[str, Any], requested_model: str) -> dict[str, Any]:
    content = data.get("content") or []
    text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
    tool_calls = tool_calls_to_openai(content)
    finish = ANTHROPIC_FINISH.get(data.get("stop_reason") or "", "stop")
    if tool_calls and finish == "stop":
        finish = "tool_calls"

    usage = data.get("usage") or {}
    prompt_tokens = int(usage.get("input_tokens") or 0)
    completion = int(usage.get("output_tokens") or 0)
    cached = int(usage.get("cache_read_input_tokens") or 0)

    message: dict[str, Any] = {"role": "assistant", "content": text or None}
    if tool_calls:
        message["tool_calls"] = tool_calls

    return {
        "id": "chatcmpl-" + str(data.get("id", uuid.uuid4().hex[:20])).removeprefix("msg_"),
        "object": "chat.completion",
        "created": _now(),
        "model": data.get("model") or requested_model,
        "choices": [{
            "index": 0,
            "message": message,
            "logprobs": None,
            "finish_reason": finish,
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion,
            "total_tokens": prompt_tokens + completion,
            "prompt_tokens_details": {"cached_tokens": cached},
            "completion_tokens_details": {
                "reasoning_tokens": int(usage.get("reasoning_tokens") or 0)
            },
        },
    }


async def anthropic_sse_to_openai(events: AsyncIterator[dict[str, Any]], model: str,
                               include_usage: bool = False) -> AsyncIterator[dict[str, Any]]:
    """Translate Anthropic's SSE events into OpenAI `chat.completion.chunk` dicts."""
    request_id = "chatcmpl-" + uuid.uuid4().hex[:24]
    created = _now()
    prompt_tokens = 0
    completion_tokens = 0
    tool_index = -1
    tool_id = ""
    tool_name = ""
    started = False
    finish_reason = "stop"
    closed = False

    def chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish}],
        }

    async for event in events:
        kind = event.get("type")

        if kind == "message_start":
            message = event.get("message") or {}
            request_id = "chatcmpl-" + str(message.get("id", "")).removeprefix("msg_") \
                or request_id
            usage = message.get("usage") or {}
            prompt_tokens = int(usage.get("input_tokens") or 0)
            completion_tokens = int(usage.get("output_tokens") or 0)
            if not started:
                started = True
                yield chunk({"role": "assistant", "content": ""})

        elif kind == "content_block_start":
            block = event.get("content_block") or {}
            if block.get("type") == "tool_use":
                tool_index += 1
                tool_id = block.get("id", f"call_{uuid.uuid4().hex[:16]}")
                tool_name = block.get("name", "")
                yield chunk({
                    "tool_calls": [{
                        "index": tool_index,
                        "id": tool_id,
                        "type": "function",
                        "function": {"name": tool_name, "arguments": ""},
                    }]
                })

        elif kind == "content_block_delta":
            delta = event.get("delta") or {}
            delta_type = delta.get("type")
            if delta_type == "text_delta":
                text = delta.get("text", "")
                if text:
                    started = True
                    yield chunk({"content": text})
            elif delta_type == "input_json_delta":
                partial = delta.get("partial_json", "")
                if partial:
                    yield chunk({
                        "tool_calls": [{
                            "index": tool_index,
                            "function": {"arguments": partial},
                        }]
                    })
            elif delta_type == "thinking_delta":
                text = delta.get("thinking", "")
                if text:
                    started = True
                    yield chunk({"reasoning_content": text})

        elif kind == "message_delta":
            delta = event.get("delta") or {}
            finish_reason = ANTHROPIC_FINISH.get(delta.get("stop_reason") or "", "stop")
            usage = event.get("usage") or {}
            completion_tokens = int(usage.get("output_tokens") or completion_tokens)

        elif kind == "message_stop":
            if not started:
                started = True
                yield chunk({"role": "assistant", "content": ""})
            yield chunk({}, finish_reason)
            if include_usage:
                yield {
                    "id": request_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [],
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": prompt_tokens + completion_tokens,
                    },
                }
            closed = True

        elif kind == "error":
            error = event.get("error") or {}
            raise RuntimeError(error.get("message") or "anthropic stream error")

    if not closed:
        if not started:
            yield chunk({"role": "assistant", "content": ""})
        yield chunk({}, finish_reason)


# ── OpenAI → Gemini ────────────────────────────────────────────────────────
def openai_to_gemini(body: dict[str, Any], model: str) -> dict[str, Any]:
    system_text, messages = split_system(body.get("messages") or [])
    contents: list[dict[str, Any]] = []

    call_names: dict[str, str] = {}
    for message in messages:
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            call_names[call.get("id", "")] = function.get("name", "")

    staged: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role", "user")

        # Gemini returns tool output as `functionResponse` parts on a user turn.
        if role == "tool":
            try:
                payload = json.loads(message.get("content") or "{}")
            except (json.JSONDecodeError, TypeError):
                payload = {"result": text_of(message.get("content"))}
            staged.append({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": call_names.get(message.get("tool_call_id", ""), "tool"),
                        "response": payload if isinstance(payload, dict) else {"result": payload},
                    }
                }],
            })
            continue

        parts: list[dict[str, Any]] = []
        content = message.get("content")

        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    parts.append({"text": str(part)})
                elif part.get("type") == "text":
                    parts.append({"text": part.get("text", "")})
                elif part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url", "")
                    if url.startswith("data:"):
                        header, _, b64 = url.partition(",")
                        mime = header.split(";")[0].removeprefix("data:") or "image/png"
                        parts.append({"inline_data": {"mime_type": mime, "data": b64}})
                    elif url:
                        parts.append({"file_data": {"file_uri": url}})
        elif content:
            parts.append({"text": text_of(content)})

        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            try:
                args = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            parts.append({"functionCall": {"name": function.get("name", ""), "args": args}})

        if parts:
            staged.append({"role": "model" if role == "assistant" else "user", "parts": parts})

    contents = [
        {"role": m["role"], "parts": m["parts"]}
        for m in merge_runs(staged, ("user", "model"), "user", content_key="parts")
    ]

    if not contents:
        contents = [{"role": "user", "parts": [{"text": "(continue)"}]}]

    generation: dict[str, Any] = {}
    if body.get("temperature") is not None:
        generation["temperature"] = float(body["temperature"])
    if body.get("top_p") is not None:
        generation["topP"] = float(body["top_p"])
    if body.get("top_k") is not None:
        generation["topK"] = int(body["top_k"])
    if body.get("max_tokens") or body.get("max_completion_tokens"):
        generation["maxOutputTokens"] = int(
            body.get("max_tokens") or body["max_completion_tokens"]
        )
    if body.get("stop"):
        stops = body["stop"] if isinstance(body["stop"], list) else [body["stop"]]
        generation["stopSequences"] = [str(s) for s in stops]

    response_format = body.get("response_format") or {}
    if response_format.get("type") == "json_object":
        generation["responseMimeType"] = "application/json"
        schema = (response_format.get("json_schema") or {}).get("schema")
        if schema:
            generation["responseSchema"] = schema

    if body.get("seed") is not None:
        generation["seed"] = int(body["seed"])
    if body.get("n"):
        generation["candidateCount"] = int(body["n"])
    if body.get("presence_penalty") is not None:
        generation["presencePenalty"] = float(body["presence_penalty"])
    if body.get("frequency_penalty") is not None:
        generation["frequencyPenalty"] = float(body["frequency_penalty"])

    out: dict[str, Any] = {"contents": contents}
    if generation:
        out["generationConfig"] = generation
    if system_text:
        out["systemInstruction"] = {"parts": [{"text": system_text}]}

    declarations = []
    for tool in body.get("tools") or []:
        function = tool.get("function") or {}
        if not function.get("name"):
            continue
        declarations.append({
            "name": function["name"],
            "description": function.get("description", ""),
            "parameters": function.get("parameters") or {"type": "object", "properties": {}},
        })
    if declarations:
        out["tools"] = [{"functionDeclarations": declarations}]
        choice = body.get("tool_choice")
        mode = "AUTO"
        allowed = None
        if choice == "required":
            mode = "ANY"
        elif choice == "none":
            mode = "NONE"
        elif isinstance(choice, dict) and choice.get("type") == "function":
            mode, allowed = "ANY", [choice["function"]["name"]]
        config: dict[str, Any] = {"mode": mode}
        if allowed:
            config["allowedFunctionNames"] = allowed
        out["toolConfig"] = {"functionCallingConfig": config}

    return out


def gemini_to_openai(data: dict[str, Any], requested_model: str) -> dict[str, Any]:
    candidates = data.get("candidates") or []
    candidate = candidates[0] if candidates else {}
    parts = (candidate.get("content") or {}).get("parts") or []

    text = "".join(p.get("text", "") for p in parts if "text" in p)
    tool_calls = []
    for part in parts:
        call = part.get("functionCall")
        if call:
            tool_calls.append({
                "id": f"call_{uuid.uuid4().hex[:16]}",
                "type": "function",
                "function": {
                    "name": call.get("name", ""),
                    "arguments": json.dumps(call.get("args") or {}, separators=(",", ":")),
                },
            })

    finish = GEMINI_FINISH.get(candidate.get("finishReason") or "STOP", "stop")
    if tool_calls and finish == "stop":
        finish = "tool_calls"

    message: dict[str, Any] = {"role": "assistant", "content": text or None}
    if tool_calls:
        message["tool_calls"] = tool_calls

    usage = data.get("usageMetadata") or {}
    prompt_tokens = int(usage.get("promptTokenCount") or 0)
    completion_tokens = int(usage.get("candidatesTokenCount") or 0)
    cached = int(usage.get("cachedContentTokenCount") or 0)

    return {
        "id": new_id(),
        "object": "chat.completion",
        "created": _now(),
        "model": data.get("modelVersion") or requested_model,
        "choices": [{
            "index": 0,
            "message": message,
            "logprobs": None,
            "finish_reason": finish,
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": int(usage.get("totalTokenCount") or prompt_tokens + completion_tokens),
            "prompt_tokens_details": {"cached_tokens": cached},
        },
    }


async def gemini_sse_to_openai(chunks: AsyncIterator[dict[str, Any]], model: str,
                            include_usage: bool = False) -> AsyncIterator[dict[str, Any]]:
    request_id = new_id()
    created = _now()
    tool_index = -1
    finish_reason = "stop"
    emitted = False
    usage_payload: dict[str, Any] | None = None

    def chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish}],
        }

    async for data in chunks:
        candidates = data.get("candidates") or []
        candidate = candidates[0] if candidates else {}
        for part in (candidate.get("content") or {}).get("parts") or []:
            if part.get("text"):
                emitted = True
                yield chunk({"content": part["text"]})
            call = part.get("functionCall")
            if call:
                tool_index += 1
                emitted = True
                yield chunk({
                    "tool_calls": [{
                        "index": tool_index,
                        "id": f"call_{uuid.uuid4().hex[:16]}",
                        "type": "function",
                        "function": {
                            "name": call.get("name", ""),
                            "arguments": json.dumps(call.get("args") or {}, separators=(",", ":")),
                        },
                    }]
                })
        if candidate.get("finishReason"):
            finish_reason = GEMINI_FINISH.get(candidate["finishReason"], "stop")
        if data.get("usageMetadata"):
            usage_payload = data["usageMetadata"]

    if tool_index >= 0 and finish_reason == "stop":
        finish_reason = "tool_calls"
    if not emitted:
        yield chunk({"role": "assistant", "content": ""})
    yield chunk({}, finish_reason)

    if include_usage and usage_payload:
        prompt_tokens = int(usage_payload.get("promptTokenCount") or 0)
        completion_tokens = int(usage_payload.get("candidatesTokenCount") or 0)
        yield {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": int(
                    usage_payload.get("totalTokenCount") or prompt_tokens + completion_tokens
                ),
            },
        }


# ── embeddings ─────────────────────────────────────────────────────────────
def openai_embedding_to_gemini(body: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Returns (batch?, payload) for :embedContent or :batchEmbedContents."""
    model = body.get("model") or "text-embedding-004"
    inputs = body.get("input")
    if isinstance(inputs, str):
        items = [inputs]
        single = True
    elif isinstance(inputs, list):
        items = [i if isinstance(i, str) else text_of(i) for i in inputs]
        single = False
    else:
        items = []
        single = False

    if single or len(items) == 1:
        return False, {"model": f"models/{model}", "content": {"parts": [{"text": items[0] if items else ""}]}}

    return True, {
        "requests": [{"model": f"models/{model}", "content": {"parts": [{"text": text}]}}
                     for text in items]
    }


def gemini_embeddings_to_openai(
    data: dict[str, Any], model: str, encoding_format: str = "float"
) -> dict[str, Any]:
    import base64

    vectors = []
    if "embeddings" in data:
        vectors = [e.get("values", []) for e in data.get("embeddings") or []]
    elif "embedding" in data:
        vectors = [data["embedding"].get("values", [])]

    def encode(values: list[float]) -> Any:
        if encoding_format == "base64":
            raw = b"".join(struct_pack(v) for v in values)
            return base64.b64encode(raw).decode()
        return values

    return {
        "object": "list",
        "data": [
            {"object": "embedding", "index": i, "embedding": encode(v)}
            for i, v in enumerate(vectors)
        ],
        "model": model,
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }


def struct_pack(value: float) -> bytes:
    import struct

    return struct.pack("<f", value)