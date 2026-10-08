# AI Proxy Server

Unified OpenAI-compatible API proxy that aggregates multiple AI provider accounts (OpenAI, Anthropic, Google Gemini, custom) behind a single endpoint with load balancing, cost tracking, caching, and per-account proxy routing.

## Features

- **Multi-provider**: OpenAI, Claude, Google, custom OpenAI-compatible endpoints
- **Routing strategies**: round-robin, failover, weighted, random
- **Per-account egress proxy**: route each API key through different IPs/locations to avoid provider suspension
- **Response caching**: exact-match with 5 min TTL
- **Cost tracking**: per-request cost estimates by model, account, and day
- **Budget limits**: hard spend cap
- **Rate limiting**: per-account caps
- **Circuit breakers**: automatic failover on repeated errors
- **Session pinning**: `x-session-id` header pins a conversation to one account
- **Virtual models**: alias any model name to multiple real models
- **Prometheus metrics**: `/metrics` endpoint
- **React dashboard**: Dashboard, Providers, Playground, Logs, Settings

## Quick Start

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
PROXY_MASTER_KEY=your-secret-key python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000/app/` for the dashboard.

## API

All requests require `x-api-key: YOUR_MASTER_KEY`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Chat completions (OpenAI-compatible) |
| POST | `/v1/embeddings` | Text embeddings |
| POST | `/v1/images/generations` | Image generation |
| GET | `/v1/models` | List available models |
| GET | `/admin/accounts` | List accounts |
| POST | `/admin/accounts` | Add account |
| PUT | `/admin/accounts/{name}` | Update account |
| DELETE | `/admin/accounts/{name}` | Delete account |
| GET | `/admin/stats` | Usage stats |
| GET | `/admin/logs` | Request logs |
| GET | `/admin/usage` | Cost/cache/budget/aliases |
| PUT | `/admin/strategy` | Set routing strategy |
| PUT | `/admin/budget` | Set budget limit |
| GET | `/admin/locations` | Account locations |
| GET | `/admin/cache` | Cache stats |
| DELETE | `/admin/cache` | Clear cache |
| POST | `/admin/alias` | Create model alias |
| GET | `/admin/aliases` | List aliases |
| GET | `/metrics` | Prometheus metrics |
| GET | `/health` | Server health |

### Account config

```json
{
  "name": "openai-primary",
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-...",
  "models": ["gpt-4o", "gpt-4o-mini"],
  "provider_type": "openai",
  "weight": 1,
  "enabled": true,
  "proxy_url": "http://user:pass@proxy:8080",
  "location": "US-East",
  "user_agent": "MyApp/1.0"
}
```

## Frontend

```bash
cd frontend
npm install
npm run build   # builds to dist/, served by backend at /app/
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_MASTER_KEY` | random | Master API key for all requests |
| `PROXY_ROUTING` | `round_robin` | Routing strategy |
| `OPENAI_KEY_1` | — | OpenAI API key 1 |
| `OPENAI_KEY_2` | — | OpenAI API key 2 |
| `ANTHROPIC_KEY_1` | — | Anthropic API key |
| `GOOGLE_KEY_1` | — | Google AI API key |

## License

MIT
