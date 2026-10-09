import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { DataTable } from '../components/ui/DataTable.tsx'
import type { Column } from '../components/ui/DataTable.tsx'
import { Badge, Button, Card, PageHeader } from '../components/ui/Primitives.tsx'
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/States.tsx'
import { Icon } from '../components/ui/Icon.tsx'
import { useToast } from '../components/ui/Overlays.tsx'
import { useLive } from '../app/LiveContext.tsx'
import { api, downloadText, errorMessage, fetchExport, toCsv } from '../lib/api.ts'
import type { LogEntry, LogsQuery, LogsResponse } from '../lib/types.ts'
import { useAsync, useDebounced, useInterval } from '../lib/hooks.ts'
import {
  ago,
  clock,
  compact,
  levelTone,
  ms,
  num,
  shortDateTime,
  statusClass,
  statusTone,
  toneColor,
  truncate,
  usd,
} from '../lib/format.ts'

const PAGE = 200
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx']
const LEVELS = ['debug', 'info', 'warn', 'error']
const KINDS = ['request', 'audit', 'probe']
const SINCE = [
  { value: '5m', label: 'last 5m', ms: 5 * 60_000 },
  { value: '15m', label: 'last 15m', ms: 15 * 60_000 },
  { value: '1h', label: 'last hour', ms: 3_600_000 },
  { value: '6h', label: 'last 6h', ms: 6 * 3_600_000 },
  { value: '24h', label: 'last 24h', ms: 24 * 3_600_000 },
  { value: 'all', label: 'all time', ms: 0 },
]

export function Traffic(): ReactElement {
  const toast = useToast()
  const { logs: liveLogs } = useLive()

  const [account, setAccount] = useState('')
  const [model, setModel] = useState('')
  const [status, setStatus] = useState('')
  const [level, setLevel] = useState('')
  const [kind, setKind] = useState('')
  const [since, setSince] = useState('1h')
  const [text, setText] = useState('')
  const debouncedText = useDebounced(text, 250)

  const [limit, setLimit] = useState(PAGE)
  const [autoLoad, setAutoLoad] = useState(true)
  const sentinel = useRef<HTMLDivElement | null>(null)

  // a ticking clock keeps the window relative without impure render maths
  const [now, setNow] = useState<number>(() => Date.now())
  useInterval(() => setNow(Date.now()), 30_000)

  const sinceParam = useMemo(() => {
    const entry = SINCE.find((s) => s.value === since)
    if (!entry || !entry.ms) return undefined
    return new Date(now - entry.ms).toISOString().replace(/\.\d+Z$/, 'Z')
  }, [since, now])

  const query = useMemo<LogsQuery>(
    () => ({
      limit,
      account: account || undefined,
      model: model || undefined,
      status: status || undefined,
      kind: kind || undefined,
      level: level || undefined,
      since: sinceParam,
    }),
    [limit, account, model, status, kind, level, sinceParam],
  )

  const state = useAsync<LogsResponse>((signal) => api.logs(query, signal), [query])

  // reset the page size whenever the facets change
  useEffect(() => {
    setLimit(PAGE)
  }, [account, model, status, kind, level, since])

  const serverRows = useMemo(() => state.data?.logs ?? [], [state.data])

  const rows = useMemo<LogEntry[]>(() => {
    const merged = new Map<string, LogEntry>()
    // live stream entries first so the head of the table stays current
    for (const l of liveLogs) merged.set(l.id, l)
    for (const l of serverRows) merged.set(l.id, l)
    const entry = SINCE.find((s) => s.value === since)
    const cutoff = entry?.ms ? now / 1000 - entry.ms / 1000 : null

    const list = [...merged.values()].filter((l) => {
      // the facets are applied here as well as server-side so that streamed
      // entries (which bypass /admin/logs) obey the same rules
      if (cutoff !== null && (l.ts ?? 0) < cutoff) return false
      if (account && l.account !== account) return false
      if (model && l.model !== model && l.requested_model !== model) return false
      if (status && statusClass(l.status) !== status) return false
      if (kind && (l.kind || 'request') !== kind) return false
      if (level && !sameLevel(l.level, level)) return false
      return true
    })
    list.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    return list
  }, [liveLogs, serverRows, since, now, account, model, status, kind, level])

  /** free-text search is client-side: the contract has no `q` parameter */
  const filtered = useMemo(() => {
    const q = debouncedText.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((l) =>
      [l.id, l.path, l.model, l.requested_model, l.account, l.key_name, l.session_id, l.error, l.kind, l.level, String(l.status)]
        .filter((v) => v !== null && v !== undefined && v !== '')
        .some((v) => String(v).toLowerCase().includes(q)),
    )
  }, [rows, debouncedText])

  const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit])
  const canLoadMore = filtered.length > visible.length

  const loadMore = useCallback(() => {
    if (!canLoadMore) return
    setLimit((l) => Math.min(l + PAGE, 5000))
  }, [canLoadMore])

  // infinite scroll
  useEffect(() => {
    if (!autoLoad) return
    const node = sentinel.current
    if (!node) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore()
      },
      { rootMargin: '400px' },
    )
    io.observe(node)
    return () => io.disconnect()
  }, [autoLoad, loadMore, visible.length])

  const facets = useMemo(() => {
    const accounts = new Set<string>()
    const models = new Set<string>()
    for (const l of serverRows) {
      if (l.account) accounts.add(l.account)
      if (l.model) models.add(l.model)
      if (l.requested_model) models.add(l.requested_model)
    }
    return { accounts: [...accounts].sort(), models: [...models].sort() }
  }, [serverRows])

  const clearAll = (): void => {
    setAccount('')
    setModel('')
    setStatus('')
    setLevel('')
    setKind('')
    setSince('1h')
    setText('')
    setLimit(PAGE)
  }

  const exportLogs = async (kind: 'csv' | 'json'): Promise<void> => {
    try {
      const body = await fetchExport(kind)
      downloadText(`aiproxy-logs.${kind}`, body, kind === 'csv' ? 'text/csv' : 'application/json')
      toast.success(`Exported ${kind.toUpperCase()} (${body.length.toLocaleString()} bytes)`)
    } catch (e) {
      toast.error('Export failed', errorMessage(e))
    }
  }

  const exportSelection = (): void => {
    const flat = filtered.map((l) => ({
      id: l.id,
      ts: new Date((l.ts ?? 0) * 1000).toISOString(),
      kind: l.kind,
      level: l.level,
      method: l.method,
      path: l.path,
      status: l.status,
      model: l.model,
      requested_model: l.requested_model,
      account: l.account,
      key_name: l.key_name,
      session_id: l.session_id,
      attempts: l.attempts,
      latency_ms: l.latency_ms,
      ttft_ms: l.ttft_ms,
      stream: l.stream,
      cached: l.cached,
      prompt_tokens: l.prompt_tokens,
      completion_tokens: l.completion_tokens,
      cost_usd: l.cost_usd,
      location: l.location,
      error: l.error,
    }))
    downloadText(`aiproxy-logs-filtered.csv`, toCsv(flat), 'text/csv')
    toast.success(`Exported ${flat.length} filtered rows`)
  }

  const activeFilters =
    (account ? 1 : 0) + (model ? 1 : 0) + (status ? 1 : 0) + (level ? 1 : 0) + (kind ? 1 : 0) + (text ? 1 : 0) + (since !== '1h' ? 1 : 0)

  const columns = useMemo<Column<LogEntry>[]>(
    () => [
      {
        key: 'ts',
        header: 'Time',
        label: 'Time',
        width: '92px',
        sortValue: (l) => l.ts ?? 0,
        cell: (l) => <span className="nums tiny">{clock(l.ts)}</span>,
      },
      {
        key: 'status',
        header: 'Status',
        label: 'Status',
        width: '78px',
        sortValue: (l) => l.status ?? 0,
        cell: (l) => (
          <span className="row" style={{ gap: 6 }}>
            <span className={`dot dot--${statusTone(l.status) === 'muted' ? 'warn' : statusTone(l.status)}`} />
            <span className="nums" style={{ color: toneColor(statusTone(l.status)) }}>
              {l.status ?? '—'}
            </span>
            <span className="tiny faint">{statusClass(l.status)}</span>
          </span>
        ),
      },
      {
        key: 'level',
        header: 'Level',
        label: 'Level',
        width: '72px',
        sortValue: (l) => l.level ?? '',
        cell: (l) => (
          <Badge tone={levelTone(l.level)} title={l.kind}>
            {l.level || l.kind}
          </Badge>
        ),
      },
      {
        key: 'path',
        header: 'Request',
        label: 'Request',
        cell: (l) => (
          <div className="col" style={{ gap: 1, minWidth: 0 }}>
            <span className="mono truncate">
              {l.method ? `${l.method} ` : ''}
              {l.path || '—'}
            </span>
            <span className="tiny faint truncate">
              {l.model ? `${l.model}` : ''}
              {l.requested_model && l.requested_model !== l.model ? ` ← ${l.requested_model}` : ''}
              {l.session_id ? ` · ${l.session_id}` : ''}
            </span>
          </div>
        ),
      },
      {
        key: 'account',
        header: 'Account',
        label: 'Account',
        width: '150px',
        sortValue: (l) => l.account ?? '',
        cell: (l) => <span className="mono tiny truncate">{l.account || '—'}</span>,
      },
      {
        key: 'key_name',
        header: 'Key',
        label: 'Key',
        width: '110px',
        sortValue: (l) => l.key_name ?? '',
        cell: (l) => <span className="tiny truncate">{l.key_name || '—'}</span>,
      },
      {
        key: 'latency',
        header: 'Latency',
        label: 'Latency',
        align: 'right',
        sortValue: (l) => l.latency_ms ?? -1,
        cell: (l) => (
          <div className="col" style={{ gap: 0, alignItems: 'flex-end' }}>
            <span className="nums">{ms(l.latency_ms)}</span>
            {l.ttft_ms ? <span className="tiny faint">ttft {ms(l.ttft_ms)}</span> : null}
          </div>
        ),
      },
      {
        key: 'tokens',
        header: 'Tokens',
        label: 'Tokens',
        align: 'right',
        sortValue: (l) => (l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0),
        cell: (l) => (
          <span className="nums tiny">
            {compact((l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0))}
          </span>
        ),
      },
      {
        key: 'cost',
        header: 'Cost',
        label: 'Cost',
        align: 'right',
        sortValue: (l) => l.cost_usd ?? 0,
        cell: (l) => <span className="nums tiny">{usd(l.cost_usd, 4)}</span>,
      },
      {
        key: 'error',
        header: 'Error',
        label: 'Error',
        cell: (l) =>
          l.error ? (
            <span className="tiny truncate" style={{ color: 'var(--danger)', maxWidth: 260 }} title={l.error}>
              {truncate(l.error, 60)}
            </span>
          ) : (
            <span className="tiny faint">—</span>
          ),
      },
    ],
    [],
  )

  return (
    <div className="page">
      <PageHeader
        title="Traffic"
        subtitle={`GET /admin/logs · ${num(state.data?.total ?? filtered.length)} matching entries${state.data ? ` of ${num(state.data.total)}` : ''}`}
        actions={
          <>
            <Button icon="download" onClick={() => void exportSelection()} disabled={!filtered.length}>
              Export filtered
            </Button>
            <Button icon="download" onClick={() => void exportLogs('csv')}>
              CSV
            </Button>
            <Button icon="download" onClick={() => void exportLogs('json')}>
              JSON
            </Button>
            <Button icon="refresh" onClick={state.reload} loading={state.loading}>
              Refresh
            </Button>
          </>
        }
      />

      <Card
        title="Filters"
        hint={activeFilters ? `${activeFilters} active` : 'no filters'}
        actions={
          <>
            <label className="switch" title="Keep loading older rows automatically">
              <input type="checkbox" checked={autoLoad} onChange={(e) => setAutoLoad(e.target.checked)} aria-label="Infinite scroll" />
              <span className="switch__track" />
              <span className="switch__label">infinite scroll</span>
            </label>
            {activeFilters ? (
              <Button size="sm" icon="x" onClick={clearAll}>
                Clear
              </Button>
            ) : null}
          </>
        }
      >
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <Facet label="Search">
            <input
              className="input"
              value={text}
              placeholder="id, error, session…"
              aria-label="Text search"
              onChange={(e) => setText(e.target.value)}
            />
          </Facet>
          <Facet label="Account">
            <select className="select" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Filter by account">
              <option value="">any</option>
              {facets.accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Facet>
          <Facet label="Model">
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Filter by model">
              <option value="">any</option>
              {facets.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Facet>
          <Facet label="Status">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status class">
              <option value="">any</option>
              {STATUS_CLASSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Facet>
          <Facet label="Level">
            <select className="select" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Filter by level">
              <option value="">any</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Facet>
          <Facet label="Kind">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
              <option value="">any</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Facet>
          <Facet label="Time range">
            <select className="select" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Time range">
              {SINCE.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Facet>
        </div>
      </Card>

      <Card
        title="Log stream"
        hint={`showing ${num(visible.length)} of ${num(filtered.length)} loaded${state.data?.total ? ` · ${num(state.data.total)} total` : ''}`}
        flush
      >
        {state.error && !state.data ? (
          <div style={{ padding: 14 }}>
            <ErrorState error={state.error} onRetry={state.reload} />
          </div>
        ) : state.initial && state.loading ? (
          <div style={{ padding: 14 }}>
            <SkeletonRows rows={8} height={34} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="list"
            title="No log entries match"
            text={activeFilters ? 'Widen the time range or clear a facet.' : 'Nothing has been logged in this window.'}
            action={
              activeFilters ? (
                <Button icon="x" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            <DataTable columns={columns} rows={visible} rowKey={(l) => l.id} renderExpanded={(l) => <LogDetail log={l} />} />
            <div ref={sentinel} style={{ height: 1 }} />
            <div className="card__foot">
              <span className="tiny faint">
                {canLoadMore ? `${num(filtered.length - visible.length)} more rows loaded` : 'end of loaded history'}
              </span>
              {canLoadMore ? (
                <Button size="sm" icon="chevronDown" onClick={loadMore}>
                  Load more
                </Button>
              ) : null}
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

/** `warn` in the contract also arrives as `warning` depending on the sink. */
function sameLevel(level: string | null | undefined, wanted: string): boolean {
  const a = (level || '').toLowerCase()
  const b = wanted.toLowerCase()
  if (a === b) return true
  return (a === 'warn' && b === 'warning') || (a === 'warning' && b === 'warn')
}

function Facet({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

function LogDetail({ log }: { log: LogEntry }): ReactElement {
  return (
    <div className="col" style={{ gap: 10 }}>
      {log.error ? (
        <div className="alert alert--danger">
          <span className="alert__icon">
            <Icon name="alert" size={14} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="mono" style={{ wordBreak: 'break-word' }}>
              {log.error}
            </div>
          </div>
        </div>
      ) : null}

      <div className="kv">
        <div className="kv__k">request id</div>
        <div className="kv__v">{log.id}</div>
        <div className="kv__k">timestamp</div>
        <div className="kv__v">
          {shortDateTime(log.ts)} ({ago(log.ts)})
        </div>
        <div className="kv__k">kind / level</div>
        <div className="kv__v">
          {log.kind} / {log.level}
        </div>
        <div className="kv__k">method / path</div>
        <div className="kv__v">
          {log.method ?? '—'} {log.path ?? '—'}
        </div>
        <div className="kv__k">status</div>
        <div className="kv__v">
          {log.status ?? '—'} ({statusClass(log.status)})
        </div>
        <div className="kv__k">attempts</div>
        <div className="kv__v">{log.attempts ?? '—'}</div>
        <div className="kv__k">model</div>
        <div className="kv__v">
          {log.model ?? '—'}
          {log.requested_model && log.requested_model !== log.model ? ` (requested ${log.requested_model})` : ''}
        </div>
        <div className="kv__k">account</div>
        <div className="kv__v">{log.account ?? '—'}</div>
        <div className="kv__k">location</div>
        <div className="kv__v">{log.location ?? '—'}</div>
        <div className="kv__k">api key</div>
        <div className="kv__v">{log.key_name ?? '—'}</div>
        <div className="kv__k">session</div>
        <div className="kv__v">{log.session_id ?? '—'}</div>
        <div className="kv__k">latency / ttft</div>
        <div className="kv__v">
          {ms(log.latency_ms)} / {ms(log.ttft_ms)}
        </div>
        <div className="kv__k">stream / cached</div>
        <div className="kv__v">
          {log.stream ? 'stream' : 'non-stream'} · {log.cached ? 'cache HIT' : 'cache MISS'}
        </div>
        <div className="kv__k">tokens</div>
        <div className="kv__v">
          {num(log.prompt_tokens ?? 0)} prompt · {num(log.completion_tokens ?? 0)} completion
        </div>
        <div className="kv__k">cost</div>
        <div className="kv__v">{usd(log.cost_usd, 5)}</div>
      </div>

      <details>
        <summary className="tiny muted" style={{ cursor: 'pointer' }}>
          raw log object
        </summary>
        <pre className="code-block" style={{ marginTop: 8 }}>
          {JSON.stringify(log, null, 2)}
        </pre>
      </details>
    </div>
  )
}