# AI Proxy Server v3 — admin console

React + TypeScript dashboard for the proxy. It is served by the backend from
`/app/` in production and runs on `:5173` in development, proxying every backend
route to `http://127.0.0.1:8000`.

Every screen is implemented against [`../docs/API.md`](../docs/API.md) — that file
is the contract; no endpoint, field name or shape is invented here.

## Run it

```bash
npm install
npm run dev       # http://localhost:5173/app/  (proxies /, /admin, /v1 → :8000)
npm run build     # tsc -b --noEmit && vite build → dist/
npm run preview   # serve dist/ locally
npm run typecheck # tsc -b --noEmit
npm run lint      # oxlint
```

Paste the proxy master key (or any dashboard key) into the gate screen. It is
kept in `localStorage` under `aiproxy.api_key` and sent as `x-api-key`.

Override the backend with `AIPROXY_BACKEND=http://host:port npm run dev`, or
point the built bundle at a different origin with `VITE_API_URL`.

## Layout

```
src/
  main.tsx                  entry
  App.tsx                   hash router + shell + key verification
  app/
    LiveContext.tsx         health/accounts polling + /admin/logs/stream + pause
    Sidebar.tsx  TopBar.tsx nav, global search, status pill, live ticker
    KeyGate.tsx             API-key gate
    nav.ts                  route table
  lib/
    api.ts                  THE only module that talks to the backend
    types.ts                1:1 types from docs/API.md
    hooks.ts                useAsync, hash router, measure, focus trap, …
    format.ts               number / latency / cost / status formatting
  components/
    charts/                 hand-rolled SVG: AreaChart, BarList, Sparkline, Donut
    ui/                     Button, Fields, DataTable, Drawer/Modal/Toasts, states
    AccountDrawer.tsx       create/edit form for the full account object
  pages/                    Overview, Providers, Routing, Playground, Usage,
                            Traffic, Settings
  styles/                   design tokens (index.css) + components (app.css)
```

## Notes

* **No runtime dependencies beyond React.** Charts, routing, toasts, dialogs,
  drawers, tables and the SSE client are all hand-rolled; the only added
  devDependency is `typescript`.
* **One network boundary.** Everything goes through `src/lib/api.ts`, which owns
  the key, the base URL (`import.meta.env.VITE_API_URL || ''`), the `ApiError`
  unwrapping of `{error:{message}}`, CSV/JSON export helpers and the SSE reader.
* **SSE with headers.** `EventSource` cannot send `x-api-key`, so the log stream
  and the playground use `fetch` + a manual `text/event-stream` parser
  (`readSse`) with automatic reconnect and `?after=` resume.
* **Secrets are write-only.** `api_key` and `proxy.url` are sent only when typed;
  the console only ever displays the masked values returned by the API.
* Empty, partial and error payloads are all handled — every screen has an empty
  state, a loading skeleton and an error state with retry.