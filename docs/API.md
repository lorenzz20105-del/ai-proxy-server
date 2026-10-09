# AI Proxy Server v3 — HTTP API contract

Authoritative contract for the backend and the dashboard. Both are implemented against
this document. The base URL is `http://<host>:<port>` (default `8000`).

## Authentication

Every `/v1/*`, `/admin/*` endpoint requires an API key. Accepted in any of:

| Where | Example |
|---|---|
| `Authorization` | `Authorization: Bearer sk-xxx` |
| `x-api-key` | `x-api-key: sk-xxx` |
| query (proxy use only) | `?api_key=sk-xxx` |

Keys are compared with `hmac.compare_digest` (constant time). Invalid key → `401`
with body `{"error":{"message":"...","type":"invalid_api_key","code":"invalid_api_key"}}`.

On startup the server prints/creates a **master key**. The master key has full admin
rights. Additional keys can be minted via `/admin/keys` and may carry `rpm`, `tpm`,
`daily_budget_usd`, and model allow/deny lists.

## Error envelope

Every error response uses:

```json
{"error": {"message": "human readable", "type": "invalid_request_error",
           "code": "invalid_api_key", "param": null,
           "request_id": "3f9c1a2b7d10"}}
```

Status codes used: `400 invalid_request_error`, `401 invalid_api_key`,
`403 permission_denied`, `404 not_found`, `409 conflict`, `429 rate_limit_exceeded`,
`500 internal_error`, `502 upstream_error`, `503 no_healthy_accounts`.

## Response headers (added by the proxy)

| Header | Meaning |
|---|---|
| `x-aiproxy-request-id` | per-request id, also in the body error envelope and logs |
| `x-aiproxy-account` | account that produced the response |
| `x-aiproxy-attempts` | how many accounts were tried |
| `x-aiproxy-latency-ms` | total proxy-side latency |
| `x-aiproxy-cache` | `HIT` \| `MISS` \| `BYPASS` (only on chat completions) |
| `x-aiproxy-upstream-status` | HTTP status the upstream returned |

---

## System

### `GET /health`
```json
{"status":"ok","version":"3.0.0","uptime_s":1832.4,
 "accounts":{"total":4,"enabled":4,"healthy":3,"degraded":false},
 "db":{"ok":true,"latency_ms":0.4},"cache":{"entries":12,"hits":88,"misses":9}}
```

### `GET /ready`
`200` when at least one enabled, non-open-circuit account exists, else `503`.

### `GET /metrics`
Prometheus text exposition (`aiproxy_*` namespace). Includes counters for
requests/errors/cache, histograms for latency, gauges for account/circuit state.

---

## OpenAI-compatible

### `GET /v1/models`
```json
{"object":"list","data":[
  {"id":"gpt-4o","object":"model","owned_by":"openai","proxy":{
     "accounts":["openai-primary","openai-secondary"],"alias":false,"context_window":128000}}]}
```
The list is the **union** of every enabled account's model list plus all configured
aliases. Unknown-but-allowed models are still routed (pass-through) unless
`strict_models` is enabled.

### `GET /v1/models/{model_id}`
Single model object, `404` if unknown.

### `POST /v1/chat/completions`
Fully OpenAI-compatible. Supports `stream`, `tools`, `tool_choice`, `response_format`,
`seed`, `logprobs`, `stop`, `n`, `logit_bias`, `user`, `stream_options.include_usage`.

Request headers:
* `x-session-id: <opaque>` — pins the conversation to one account for cache TTL
  (`session_affinity_ttl`, default 1800s). Falls back to `x-conversation-id`.
* `x-aiproxy-no-cache: true` — bypass the response cache for this call.

Behaviour: cache lookup → routing → upstream call with retry/failover → usage and cost
accounting → cache store. Non-OpenAI providers (Anthropic, Google) are transparently
translated, including **streaming**, so the wire format is always OpenAI SSE
(`data: {"id":...,"object":"chat.completion.chunk",...}` terminated by
`data: [DONE]`).

Stream chunks:
```json
{"id":"chatcmpl-x","object":"chat.completion.chunk","created":1712345678,
 "model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"He"},
 "finish_reason":null}]}
```
Final chunk with `finish_reason:"stop"`; if `stream_options.include_usage` is set, a
final chunk with `"usage":{...}` and empty `choices` is emitted before `[DONE]`.

### `POST /v1/embeddings`
OpenAI-compatible. Translates to Google `embedContent` when routed to a Gemini
account (returns OpenAI-shaped `data[].embedding` with `base64` `encoding`).

### `POST /v1/images/generations`
OpenAI-compatible, routed only to accounts that declare image models.

### `POST /v1/responses`
OpenAI Responses API passthrough. Only accounts whose provider type is
OpenAI-compatible support it; otherwise `501`. Body is forwarded verbatim.

### `POST /v1/completions`
Legacy text-completions passthrough (OpenAI-compatible accounts only).

---

## Admin API

All admin endpoints return JSON objects. Mutating endpoints also append an entry to
the audit log retrievable at `/admin/logs?kind=audit`.

### Accounts

#### `GET /admin/accounts`
```json
{"accounts":[{
  "name":"openai-primary","provider_type":"openai","base_url":"https://api.openai.com/v1",
  "api_key_masked":"sk-proj-…4f2a","models":["gpt-4o","gpt-4o-mini"],
  "weight":2,"priority":10,"enabled":true,
  "models_exact":true,
  "rate_limit":{"rpm":60,"tpm":90000,"burst":10,"enabled":true},
  "budget":{"daily_usd":5.0,"monthly_usd":null,"spent_today_usd":0.42},
  "routing":{"strategy":null,"cost_multiplier":1.0},
  "proxy":{"enabled":true,"url_masked":"http://user:…@proxy:8080"},
  "location":"US-East","user_agent":"MyApp/1.0",
  "extra_headers":{},
  "health":{"circuit":"closed","consecutive_failures":0,"last_error":null,
            "last_success_ts":1712345000.2,"avg_latency_ms":812.4,"success_rate":0.994,
            "in_flight":0,"disabled_until":null},
  "counters":{"requests":1842,"errors":11,"tokens_in":91002,"tokens_out":120433,"cost_usd":18.42}
}]}
```
**API keys and proxy URLs are never returned in full** — only masked.

#### `POST /admin/accounts`
Accepts the same object; `api_key` and `proxy_url` may be sent as full secrets and are
stored encrypted at rest when `PROXY_ENCRYPTION_KEY` is configured.
`409` if the name exists.

#### `PUT /admin/accounts/{name}`
Partial update. Omit `api_key` to keep the existing one. Omit fields to leave them
unchanged. Changing `name` renames the account. `404` if missing.

#### `DELETE /admin/accounts/{name}` → `{"deleted":"openai-primary"}`

#### `POST /admin/accounts/{name}/test`
Live connectivity + auth check. `{"name":..., "ok":true, "status":200, "latency_ms":412,
"models_sampled":2,"error":null}` or `ok:false` with a short error. Runs in parallel
across all accounts.

#### `POST /admin/accounts/{name}/reset`
Clears circuit state, consecutive failures and the in-memory rolling stats for the
account. `{"status":"ok"}`.

### Routing

#### `GET /admin/routing`
```json
{"strategy":"round_robin",
 "strategies":["round_robin","failover","weighted","random","least_latency","least_cost","least_requests","priority"],
 "retry":{"max_attempts":3,"backoff_seconds":0.35,"max_backoff_seconds":4.0,"jitter":true,
          "retry_status_codes":[408,429,500,502,503,504,529]},
 "circuit_breaker":{"failure_threshold":5,"success_threshold":2,"cooldown_seconds":45,
                    "half_open_max_concurrency":1},
 "session_affinity":{"enabled":true,"ttl_seconds":1800,"header":"x-session-id"},
 "cache":{"enabled":true,"ttl_seconds":300,"max_entries":2000,
          "deterministic_only":true,"forward_client_caching_headers":true},
 "model_matching":"exact"}
```

#### `PUT /admin/routing`
Partial update of any subset of the above. `model_matching` is `"exact" | "prefix"`.

### Model aliases / fallback chains

An alias maps a virtual model name to an **ordered** fallback chain. The router tries
targets in order until one succeeds.

#### `GET /admin/aliases`
```json
{"aliases":{"fast":{"targets":["gpt-4o-mini","claude-sonnet-4-20250514","gemini-2.0-flash"],
                    "strategy":"first_available","created_ts":1712345000.0}}}
```

#### `PUT /admin/aliases/{alias}` → `{"alias":"fast","targets":[...]}`
#### `DELETE /admin/aliases/{alias}`

### Budgets

#### `GET /admin/budget`
```json
{"global":{"daily_usd":10.0,"monthly_usd":null,"spent_today_usd":3.21,
           "spent_month_usd":48.7,"remaining_today_usd":6.79,"hard_stop":true,
           "window_utc":"2025-04-05"},
 "alerts":[{"threshold_pct":80,"fired":false}],
 "keys":[{"key":"sk-dash-1a2b…","name":"laptop","daily_usd":1.0,"spent_today_usd":0.1,
          "rpm":30,"tpm":60000,"models_allow":null,"models_deny":null}]}
```
#### `PUT /admin/budget`
`{"daily_usd":10, "monthly_usd":null, "hard_stop":true, "alerts":[80,95]}`

### Usage & logs

#### `GET /admin/usage?range=24h`
```json
{"range":"24h","totals":{"requests":12840,"errors":214,"success_rate":0.9833,
  "tokens_in":9123002,"tokens_out":8127330,"cost_usd":142.19,"cached_requests":3321,
  "cache_hit_rate":0.2587,"avg_latency_ms":943.2,"p95_latency_ms":2210},
 "timeline":[{"bucket":"2025-04-05T14:00:00Z","requests":410,"errors":6,"cost_usd":4.21,
              "tokens_in":301221,"tokens_out":290118}],
 "by_account":[{"name":"openai-primary","requests":7001,"errors":90,"cost_usd":92.4,
   "tokens_in":4_000_000,"tokens_out":3_900_000,"success_rate":0.9871,"avg_latency_ms":812.0,
   "circuit":"closed"}],
 "by_model":[{"model":"gpt-4o","requests":6000,"cost_usd":80.2,"tokens_in":4000000,
              "tokens_out":3800000}],
 "by_key":[{"name":"laptop","requests":3000,"cost_usd":12.3}]}
```
`range` accepts `1h`, `24h`, `7d`, `30d`, `all`. Timeline buckets auto-size.

#### `GET /admin/logs?limit=200&account=&model=&status=&kind=&since=&level=`
```json
{"logs":[{"id":"3f9c1a2b7d10","ts":1712345678.12,"kind":"request","level":"info",
  "method":"POST","path":"/v1/chat/completions","model":"gpt-4o","requested_model":"smart",
  "account":"openai-primary","key_name":"laptop","session_id":"abc",
  "status":200,"attempts":1,"latency_ms":812.4,"ttft_ms":214.0,
  "stream":false,"cached":false,"prompt_tokens":1200,"completion_tokens":430,
  "cost_usd":0.0071,"error":null,"location":"US-East"}],
 "total":12840}
```

#### `GET /admin/logs/stream?after=<id>`
Server-sent events. Each event: `event: log` + `data: {log object}`. Heartbeat comment
every 20s. Supports `?level=warn` to only stream warnings and above.

#### `DELETE /admin/logs` → `{"deleted":12840}`
#### `GET /admin/export.csv` / `GET /admin/export.json` — full log dump.

### Keys

#### `GET /admin/keys`
```json
{"keys":[{"name":"laptop","key_masked":"sk-dash-1a2b…","created_ts":1712345000.0,
          "last_used_ts":1712345600.0,"daily_usd":1.0,"rpm":30,"tpm":60000,
          "models_allow":null,"models_deny":["o1"],"enabled":true}]}
```
The **full key is returned exactly once**, in the response to `POST /admin/keys`.

#### `POST /admin/keys` → `{"name":"laptop","key":"sk-dash-<43 chars>","...}` (201)

### Config

#### `GET /admin/config`
```json
{"version":"3.0.0","data_dir":"/data/…/ai-proxy-server/data","db":"sqlite",
 "encryption":"fernet"|"plaintext","master_key_masked":"sk-…",
 "server":{"host":"0.0.0.0","port":8000,"request_timeout_s":120,"stream_timeout_s":900},
 "limits":{"max_body_bytes":10485760,"max_concurrency":0},
 "cors":{"origins":["*"]},
 "features":{"cache":true,"retry":true,"circuit_breaker":true,"budget":true,
             "active_probe":true,"usage_accounting":true}}
```

#### `PUT /admin/config` — partial update of the writable keys above.

### Misc

* `GET /admin/locations` → `{"locations":{"US-East":["openai-primary"],"EU-West":["openai-secondary"]}}`
* `GET /admin/cache` → `{"enabled":true,"entries":12,"max_entries":2000,"ttl_seconds":300,
  "hits":88,"misses":9,"hit_rate":0.907,"bytes":184320,"evictions":0}`
* `DELETE /admin/cache` → `{"cleared":12}`
* `POST /admin/health-check` → `{"results":[{"name":...,"ok":true,"latency_ms":412,"status":200}]}`
* `POST /admin/probe` → force an immediate active probe sweep.

---

## Dashboard

The React dashboard is served from `/app/` when `frontend/dist` exists (dev: Vite on
`5173` proxying to `8000`). It reads only the endpoints above.