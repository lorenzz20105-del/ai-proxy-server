# AI Proxy Server

A **multi-account AI provider proxy**: one OpenAI-compatible endpoint in front of many
provider accounts, with routing, cost accounting, caching, and account protection built in.

Point any OpenAI SDK at it once and the proxy decides which account, which provider and
which exit address serves each request.

```
client  ──►  POST /v1/chat/completions  ──►  router  ──►  OpenAI / Anthropic / Google / …
                         ▲                     │
                         └── response, cost,   └── circuit breaker · rate limit · quota
                             usage and logs         parking · pacing · egress pool
```

---

## Features

### Core
- **Multi-provider translation** — OpenAI ⇄ Anthropic Messages ⇄ Google Gemini `generateContent`,
  for buffered *and* streamed responses, including SSE event-name mapping and usage extraction.
- **8 routing strategies** — `round_robin`, `failover`, `weighted`, `random`, `least_latency`,
  `least_cost`, `least_requests`, `priority`.
- **Circuit breakers** — closed → open → half_open with configurable thresholds and cooldown.
- **Token-bucket rate limiting** — per-account RPM/TPM with burst.
- **Response cache** — TTL cache for deterministic requests (temperature ≤ 1, no seed); sampled
  requests deliberately bypass it. Reportable via `x-aiproxy-cache: HIT|MISS`.
- **Cost accounting** — per-token pricing for OpenAI, Anthropic and Google, rolled into hourly
  and daily tables and readable per account, per model and per key.
- **Session affinity** — `x-session-id` pins a conversation to the account that started it.
- **Virtual models** — alias any name to an ordered fallback list of real models.
- **Prometheus metrics** — `/metrics`.
- **SSE log fan-out** — `GET /admin/logs/stream` for live traffic.

### Account protection
- **Quota-aware failover** — when a key returns `insufficient_quota`, a billing error or a
  quota 429, it is *parked* until the provider's own reset window rather than punished by the
  breaker, and the request immediately moves to the next key on the same provider. If no key is
  left, the caller gets a `429` with `Retry-After` and a typed `quota_exhausted` envelope.
  Parking escalates on repeat so a chronically exhausted key stops burning attempts.
- **Anti-ban pacing** — a minimum interval per account with jitter (no metronome cadence), a
  hard concurrency ceiling, and `Retry-After` obeyed rather than stormed.
- **Egress pool** — several accounts on one provider are assigned *distinct* exits
  (HTTP or SOCKS5, sticky per account) so they never share an address. `/admin/egress`
  reports the spread and flags any group where two accounts still collide; proxy passwords
  never appear in a response.
- **Desktop identity** — every account is pinned to one coherent desktop profile (OS, Chrome
  build, `sec-ch-ua` triple, accept-language, timezone, origin) and presents it consistently
  upstream. Profiles are chosen per account, so five keys never look like one machine.
- **Free-models-only routing** — `models.free_only` restricts routing to models that cost
  nothing (OpenRouter `:free`, provider free tiers); paid models are refused with a typed
  `402 not_a_free_model` instead of silently spending money.

### Key identification
`POST /admin/identify` returns, for any key, which provider issued it, that provider's display
name, colour and inline SVG logo, a confidence level, and what the shape implies about the
owning account (which console to check). The catalogue is offline — regular expressions and
embedded brand marks, no network call.

---

## Quick start

### Backend + dashboard

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
PROXY_MASTER_KEY=sk-your-master-key python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/app/` for the dashboard.

### Dashboard

```bash
cd frontend
npm install
npm run build          # dist/ is what the backend serves from /app/
```

The main **Overview** page opens with the two things a client needs first: the **base URL
endpoint** (with copyable `curl` / Python / Node snippets) and **one-click API key creation**,
which reveals the full key exactly once before storing only its mask.

### Docker

```bash
docker compose up --build
```

---

## Android app

The same proxy and dashboard ship as a self-contained APK — **open the icon and it is already
working**: no Termux, no companion process, no configuration.

`android/` is a hand-built, Gradle-free build (aapt → javac → d8 → zipalign → apksigner):

```bash
cd android && ./build-apk.sh     # → dist/AIProxy.apk
```

What it does:

| Piece | What it is |
|---|---|
| `java/com/aiproxy/mobile/Http.java` | hand-rolled HTTP/1.1 server, 24-thread pool, SSE |
| `Store.java` | `SQLiteOpenHelper`, WAL, master key autogen |
| `Server.java` | every `/v1/*`, `/admin/*`, `/health`, `/metrics` route + bundled dashboard |
| `Router.java` | candidate selection, 8 strategies, alias chains, free-only filter |
| `Proxy.java` | provider translation, per-account proxy, desktop identity |
| `Breaker.java` · `Stealth.java` · `Egress.java` | circuit breaker, pacing, exit assignment |
| `Providers.java` · `Fingerprint.java` · `Pricing.java` | key detection, identity, costing |

At launch `MainActivity` starts the server on an **OS-assigned loopback port** (`127.0.0.1`,
never exposed off-device), seeds the bundled console's key store with the master key, and loads
`http://127.0.0.1:<port>/app/` in a `WebView` behind a boot overlay. The base URL the dashboard
prints is therefore always correct, because it is derived from its own origin.

Constraints worth knowing: **`android.*` framework APIs only** — no AndroidX, Material or OkHttp
— and compile SDK pinned to API 32 because aapt v1 cannot parse API 33+ resource tables.

---

## Testing

### Python backend — 91 tests

```bash
cd backend && PROXY_LOG_JSON=0 .venv/bin/python -m pytest tests/ -q
```

50 unit + 41 integration. `PROXY_LOG_JSON=0` keeps tracebacks readable.

### Java engine — 155 assertions

```bash
android/harness/run.sh
```

Compiles the *shipping* engine against thin Android stubs (SQLite via sqlite-jdbc) and drives
the real HTTP server end to end: auth, admin CRUD, all three provider translations, streaming,
caching, quota failover, egress assignment, desktop identity. No emulator required.

### Dashboard — browser checks

```bash
node android/harness/verify-dashboard.mjs   # against a running instance
```

Covers key creation from the Overview, base-URL rendering, snippet tabs, and that a revealed key
is masked out of the page once dismissed. `layout.mjs`-style checks verify desktop and phone
viewports for overflow and clipped text.

---

## API

`docs/API.md` is the authoritative 35-route contract — auth, `/v1/*`, admin CRUD, usage, logs
(the dashboard uses `fetch` + a hand-rolled SSE parser, never `EventSource`), metrics.

Conventions: authenticate with `x-api-key` or `Authorization: Bearer`; admin secrets are
returned **masked** after creation (a key is shown in full exactly once); account `proxy` is
`{enabled, url}`; a blank `api_key` or `proxy.url` in a patch means *keep the existing value*.

---

## Layout

```
backend/            FastAPI + SQLite proxy (app/, tests/, 91 green)
frontend/           React + TypeScript dashboard (hash router, /app/ base, hand-rolled charts)
docs/API.md         HTTP contract
android/            APK: java sources, res, build-apk.sh, harness/, assets/dashboard
Dockerfile          2-stage node → python, non-root
docker-compose.yml
```

## Licence

See the repository for licence details.
