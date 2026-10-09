/**
 * The single gateway to the AI Proxy Server HTTP API.
 *
 * Everything the dashboard does goes through here:
 *  - the API key lives in localStorage and is sent as `x-api-key`
 *  - the base URL is same-origin (`''`) unless VITE_API_URL is set, because the
 *    backend serves this dashboard from `/app/`
 *  - `{error:{message}}` envelopes are unwrapped into a thrown `ApiError`
 */

import type {
  Account,
  AccountInput,
  AccountTestResult,
  AliasUpdateResponse,
  AliasesResponse,
  BudgetResponse,
  BudgetUpdate,
  CacheStatus,
  ChatCompletion,
  ChatChunk,
  ChatRequestBody,
  ChatUsage,
  ClearCacheResponse,
  ClearLogsResponse,
  CreatedKey,
  DeleteResponse,
  HealthCheckResponse,
  HealthResponse,
  KeysResponse,
  LogsQuery,
  LogsResponse,
  LocationsResponse,
  LogEntry,
  ModelList,
  ProbeResponse,
  ProxyResponseMeta,
  RoutingConfig,
  RoutingUpdate,
  ServerConfigResponse,
  StatusResponse,
  UsageRange,
  UsageResponse,
} from './types.ts'

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Same-origin by default — the backend mounts the dashboard at /app/. */
export const BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) || ''

const STORAGE_KEY = 'aiproxy.api_key'
const PREFS_KEY = 'aiproxy.prefs'

export type Prefs = {
  lastRange: UsageRange
  playgroundModel: string
  playgroundSystem: string
  sidebarCollapsed: boolean
}

const DEFAULT_PREFS: Prefs = {
  lastRange: '24h',
  playgroundModel: '',
  playgroundSystem: 'You are a helpful assistant.',
  sidebarCollapsed: false,
}

export function getApiKey(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export function setApiKey(key: string): void {
  try {
    if (key) window.localStorage.setItem(STORAGE_KEY, key)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode — keep going in-memory */
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly type: string
  readonly param: string | null
  readonly requestId: string | null

  constructor(
    message: string,
    status: number,
    extra: { code?: string; type?: string; param?: string | null; requestId?: string | null } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = extra.code || statusText(status)
    this.type = extra.type || 'proxy_error'
    this.param = extra.param ?? null
    this.requestId = extra.requestId ?? null
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error'
    case 401:
      return 'invalid_api_key'
    case 403:
      return 'permission_denied'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 429:
      return 'rate_limit_exceeded'
    case 500:
      return 'internal_error'
    case 502:
      return 'upstream_error'
    case 503:
      return 'no_healthy_accounts'
    default:
      return `http_${status}`
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return `${e.message} (${e.status})`
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return 'Unexpected error'
}

/* ------------------------------------------------------------------ */
/* Core request                                                        */
/* ------------------------------------------------------------------ */

export interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Send `undefined` instead of throwing when the response is not 2xx. */
  tolerate?: boolean
}

function isEnvelope(body: unknown): body is { error: Record<string, unknown> } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: unknown }).error !== null
  )
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = res.statusText || `HTTP ${res.status}`
  let code: string | undefined
  let type: string | undefined
  let param: string | null = null
  let requestId: string | null = res.headers.get('x-aiproxy-request-id')
  try {
    const text = await res.text()
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (isEnvelope(parsed)) {
          const err = parsed.error
          if (typeof err.message === 'string' && err.message) message = err.message
          if (typeof err.code === 'string') code = err.code
          if (typeof err.type === 'string') type = err.type
          if (typeof err.param === 'string' || err.param === null) param = err.param as string | null
          if (typeof err.request_id === 'string') requestId = err.request_id
        } else if (typeof parsed === 'object' && parsed !== null) {
          const detail = (parsed as Record<string, unknown>).detail
          if (typeof detail === 'string') message = detail
        }
      } catch {
        message = text.slice(0, 400)
      }
    }
  } catch {
    /* body already consumed or unreadable */
  }
  return new ApiError(message, res.status, { code, type, param, requestId })
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers || {}) }
  const key = getApiKey()
  if (key) headers['x-api-key'] = key

  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  let res: Response
  try {
    res = await fetch(BASE_URL + path, {
      method: opts.method || 'GET',
      headers,
      body,
      signal: opts.signal,
      credentials: 'same-origin',
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(
      `Cannot reach the proxy at ${BASE_URL || window.location.origin} — is the backend running?`,
      0,
      { code: 'network_error', type: 'network_error' },
    )
  }

  if (!res.ok) {
    const err = await toApiError(res)
    if (opts.tolerate) throw err
    throw err
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

/* ------------------------------------------------------------------ */
/* Server-sent events                                                  */
/* ------------------------------------------------------------------ */

export interface SseEvent {
  event: string
  data: string
  id: string | null
}

/**
 * Incremental SSE frame reader. Handles `\n\n` and `\r\n\r\n` separators,
 * multi-line `data:` fields, comment heartbeats and BOM noise.
 */
export async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  const body = res.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const drain = function* (flush: boolean): Generator<SseEvent> {
    let idx = buffer.search(/\r?\n\r?\n/)
    while (idx !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2))
      const frame = parseFrame(raw)
      if (frame) yield frame
      idx = buffer.search(/\r?\n\r?\n/)
    }
    if (flush && buffer.trim()) {
      const frame = parseFrame(buffer)
      buffer = ''
      if (frame) yield frame
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      yield* drain(false)
    }
    buffer += decoder.decode()
    yield* drain(true)
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}

function parseFrame(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/)
  let event = 'message'
  let id: string | null = null
  const data: string[] = []
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue // heartbeat comment
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  if (!data.length && event === 'message') return null
  return { event, data: data.join('\n'), id }
}

/* ------------------------------------------------------------------ */
/* Log stream (GET /admin/logs/stream)                                */
/* ------------------------------------------------------------------ */

export interface LogStreamOptions {
  signal: AbortSignal
  level?: string | undefined
  onLog: (log: LogEntry) => void
  onOpen?: () => void
  onStatus?: (status: 'connecting' | 'live' | 'reconnecting' | 'offline', detail?: string) => void
  /** Resumable cursor: evaluated on every (re)connect so nothing is missed. */
  after?: () => string | null | undefined
  /** Cap on automatic reconnects; the caller restarts the stream. */
  maxAttempts?: number
}

export async function streamLogs(opts: LogStreamOptions): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 60
  let attempt = 0

  while (!opts.signal.aborted && attempt < maxAttempts) {
    attempt += 1
    opts.onStatus?.(attempt === 1 ? 'connecting' : 'reconnecting')
    const cursor = opts.after?.() ?? null
    const qs = new URLSearchParams()
    if (cursor) qs.set('after', cursor)
    if (opts.level) qs.set('level', opts.level)
    const url = `${BASE_URL}/admin/logs/stream${qs.toString() ? `?${qs}` : ''}`
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    const key = getApiKey()
    if (key) headers['x-api-key'] = key

    try {
      const res = await fetch(url, {
        headers,
        signal: opts.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (!res.ok) throw await toApiError(res)
      opts.onStatus?.('live')
      opts.onOpen?.()
      attempt = 1 // a successful connection resets the backoff
      for await (const ev of readSse(res)) {
        if (ev.data === '[DONE]') break
        if (!ev.data) continue
        try {
          const parsed: unknown = JSON.parse(ev.data)
          const log = (parsed && typeof parsed === 'object' && 'log' in parsed
            ? (parsed as { log: LogEntry }).log
            : parsed) as LogEntry
          if (log && typeof log === 'object') {
            if (cursor && log.id && log.id <= cursor) continue
            opts.onLog(log)
          }
        } catch {
          /* ignore malformed frames */
        }
      }
    } catch (e) {
      if (opts.signal.aborted) break
      const msg = errorMessage(e)
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        opts.onStatus?.('offline', 'invalid API key')
        throw e
      }
      opts.onStatus?.('reconnecting', msg)
    }

    if (opts.signal.aborted) break
    await delay(Math.min(1000 * attempt, 10_000), opts.signal)
  }
  opts.onStatus?.('offline')
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = window.setTimeout(done, ms)
    function done() {
      window.clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/* ------------------------------------------------------------------ */
/* Chat completions                                                    */
/* ------------------------------------------------------------------ */

export interface ChatCallOptions {
  body: ChatRequestBody
  signal?: AbortSignal
  sessionId?: string
  noCache?: boolean
  onOpen?: (meta: ProxyResponseMeta) => void
  onFirstToken?: () => void
  onChunk?: (chunk: ChatChunk) => void
}

export interface ChatCallResult {
  content: string
  completion: ChatCompletion | null
  usage: ChatUsage | null
  meta: ProxyResponseMeta
  /** Exact bytes of the response body (or the raw SSE stream). */
  raw: string
  ttftMs: number | null
  latencyMs: number
}

function readMeta(res: Response): ProxyResponseMeta {
  const num = (v: string | null): number | null => {
    if (v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const cache = res.headers.get('x-aiproxy-cache')
  return {
    requestId: res.headers.get('x-aiproxy-request-id'),
    account: res.headers.get('x-aiproxy-account'),
    attempts: num(res.headers.get('x-aiproxy-attempts')),
    latencyMs: num(res.headers.get('x-aiproxy-latency-ms')),
    cache: cache === 'HIT' || cache === 'MISS' || cache === 'BYPASS' ? cache : null,
    upstreamStatus: num(res.headers.get('x-aiproxy-upstream-status')),
  }
}

export async function chatCompletion(opts: ChatCallOptions): Promise<ChatCallResult> {
  const started = performance.now()
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const key = getApiKey()
  if (key) headers['x-api-key'] = key
  if (opts.sessionId) headers['x-session-id'] = opts.sessionId
  if (opts.noCache) headers['x-aiproxy-no-cache'] = 'true'

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
    signal: opts.signal,
    credentials: 'same-origin',
  })

  const meta = readMeta(res)
  opts.onOpen?.(meta)

  if (!res.ok) throw await toApiError(res)

  let ttftMs: number | null = null
  let content = ''
  let completion: ChatCompletion | null = null
  let usage: ChatUsage | null = null
  const rawParts: string[] = []
  let first = true

  if (opts.body.stream) {
    for await (const ev of readSse(res)) {
      rawParts.push(ev.data)
      if (!ev.data || ev.data === '[DONE]') continue
      let chunk: ChatChunk
      try {
        chunk = JSON.parse(ev.data) as ChatChunk
      } catch {
        continue
      }
      if (first) {
        first = false
        ttftMs = performance.now() - started
        opts.onFirstToken?.()
      }
      for (const choice of chunk.choices || []) {
        const piece = choice.delta?.content
        if (typeof piece === 'string') content += piece
      }
      if (chunk.usage) usage = chunk.usage
      if (chunk.choices && chunk.choices.length && chunk.choices[0].finish_reason) {
        completion = {
          id: chunk.id,
          object: 'chat.completion',
          created: chunk.created,
          model: chunk.model,
          choices: [],
          usage: chunk.usage ?? null,
        }
      }
      opts.onChunk?.(chunk)
    }
  } else {
    const text = await res.text()
    rawParts.push(text)
    try {
      completion = JSON.parse(text) as ChatCompletion
      content = completion.choices?.[0]?.message?.content ?? ''
      usage = completion.usage ?? null
      ttftMs = performance.now() - started
      opts.onFirstToken?.()
    } catch {
      throw new ApiError('Upstream returned a non-JSON body', res.status, { code: 'bad_response' })
    }
  }

  return {
    content,
    completion,
    usage,
    meta,
    raw: rawParts.join('\n'),
    ttftMs,
    latencyMs: performance.now() - started,
  }
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const api = {
  /* system */
  health: (signal?: AbortSignal) => request<HealthResponse>('/health', { signal }),
  ready: (signal?: AbortSignal) => request<unknown>('/ready', { signal }),
  metrics: (signal?: AbortSignal) => request<string>('/metrics', { signal }),

  /** Cheap authenticated round-trip: 200 => the key works. */
  verifyKey: (signal?: AbortSignal) => request<KeysResponse>('/admin/keys', { signal }),

  /* models */
  models: (signal?: AbortSignal) => request<ModelList>('/v1/models', { signal }),

  /* accounts */
  accounts: (signal?: AbortSignal) => request<{ accounts: Account[] }>('/admin/accounts', { signal }),
  createAccount: (body: AccountInput) => request<Account>('/admin/accounts', { method: 'POST', body }),
  updateAccount: (name: string, body: AccountInput) =>
    request<Account>(`/admin/accounts/${encodeURIComponent(name)}`, { method: 'PUT', body }),
  deleteAccount: (name: string) =>
    request<DeleteResponse>(`/admin/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  testAccount: (name: string, signal?: AbortSignal) =>
    request<AccountTestResult>(`/admin/accounts/${encodeURIComponent(name)}/test`, { method: 'POST', signal }),
  resetAccount: (name: string) =>
    request<StatusResponse>(`/admin/accounts/${encodeURIComponent(name)}/reset`, { method: 'POST' }),
  healthCheck: () => request<HealthCheckResponse>('/admin/health-check', { method: 'POST' }),

  /* routing */
  routing: (signal?: AbortSignal) => request<RoutingConfig>('/admin/routing', { signal }),
  updateRouting: (body: RoutingUpdate) => request<RoutingConfig>('/admin/routing', { method: 'PUT', body }),

  /* aliases */
  aliases: (signal?: AbortSignal) => request<AliasesResponse>('/admin/aliases', { signal }),
  putAlias: (alias: string, targets: string[]) =>
    request<AliasUpdateResponse>(`/admin/aliases/${encodeURIComponent(alias)}`, {
      method: 'PUT',
      body: { alias, targets },
    }),
  deleteAlias: (alias: string) =>
    request<{ deleted?: string }>(`/admin/aliases/${encodeURIComponent(alias)}`, { method: 'DELETE' }),

  /* budget */
  budget: (signal?: AbortSignal) => request<BudgetResponse>('/admin/budget', { signal }),
  updateBudget: (body: BudgetUpdate) => request<BudgetResponse>('/admin/budget', { method: 'PUT', body }),

  /* usage + logs */
  usage: (range: UsageRange, signal?: AbortSignal) =>
    request<UsageResponse>(`/admin/usage${qs({ range })}`, { signal }),
  logs: (query: LogsQuery, signal?: AbortSignal) => request<LogsResponse>(`/admin/logs${qs({ ...query })}`, { signal }),
  clearLogs: () => request<ClearLogsResponse>('/admin/logs', { method: 'DELETE' }),

  /* keys */
  keys: (signal?: AbortSignal) => request<KeysResponse>('/admin/keys', { signal }),
  createKey: (body: {
    name: string
    daily_usd?: number | null
    rpm?: number | null
    tpm?: number | null
    models_allow?: string[] | null
    models_deny?: string[] | null
  }) => request<CreatedKey>('/admin/keys', { method: 'POST', body }),

  /* config */
  config: (signal?: AbortSignal) => request<ServerConfigResponse>('/admin/config', { signal }),
  updateConfig: (body: Record<string, unknown>) =>
    request<ServerConfigResponse>('/admin/config', { method: 'PUT', body }),

  /* misc */
  locations: (signal?: AbortSignal) => request<LocationsResponse>('/admin/locations', { signal }),
  cache: (signal?: AbortSignal) => request<CacheStatus>('/admin/cache', { signal }),
  clearCache: () => request<ClearCacheResponse>('/admin/cache', { method: 'DELETE' }),
  probe: () => request<ProbeResponse>('/admin/probe', { method: 'POST' }),
}

/* ------------------------------------------------------------------ */
/* Export helpers (need the API key, so a plain <a href> will not do)  */
/* ------------------------------------------------------------------ */

export async function fetchExport(kind: 'csv' | 'json', signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = { Accept: kind === 'csv' ? 'text/csv' : 'application/json' }
  const key = getApiKey()
  if (key) headers['x-api-key'] = key
  const res = await fetch(`${BASE_URL}/admin/export.${kind}`, { headers, signal, credentials: 'same-origin' })
  if (!res.ok) throw await toApiError(res)
  return res.text()
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/**
 * RFC4180-ish CSV serialisation of an array of flat objects.
 * Keys are unioned across rows so sparse objects still line up.
 */
export function toCsv(rows: readonly unknown[], columns?: string[]): string {
  if (!rows.length) return ''
  const objects = rows.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
  const cols = columns ?? [...new Set(objects.flatMap((r) => Object.keys(r)))]
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...objects.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')
}