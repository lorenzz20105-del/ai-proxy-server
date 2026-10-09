import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { AreaChart } from '../components/charts/AreaChart.tsx'
import { Donut } from '../components/charts/Donut.tsx'
import { BarCell, DataTable, useSortedRows } from '../components/ui/DataTable.tsx'
import type { Column } from '../components/ui/DataTable.tsx'
import { Badge, Button, Card, PageHeader } from '../components/ui/Primitives.tsx'
import { Kpi } from '../components/ui/Kpi.tsx'
import { AsyncGate, EmptyState, ErrorState, Skeleton, SkeletonTiles } from '../components/ui/States.tsx'
import { useToast } from '../components/ui/Overlays.tsx'
import { api, downloadText, toCsv } from '../lib/api.ts'
import type { UsageByAccount, UsageByKey, UsageByModel, UsageRange, UsageResponse } from '../lib/types.ts'
import { useAsync } from '../lib/hooks.ts'
import { bucketLabel, compact, ms, num, pct, usd } from '../lib/format.ts'

const RANGES: UsageRange[] = ['1h', '24h', '7d', '30d', 'all']
type Metric = 'requests' | 'cost' | 'tokens' | 'errors'

export function Usage(): ReactElement {
  const toast = useToast()
  const [range, setRange] = useState<UsageRange>(rangeFromHash())
  const [metric, setMetric] = useState<Metric>('requests')

  useEffect(() => {
    const base = window.location.hash.replace(/^#/, '').split('?')[0] || '/usage'
    window.history.replaceState(null, '', `#${base}?range=${range}`)
  }, [range])

  const usage = useAsync<UsageResponse>((signal) => api.usage(range, signal), [range])

  const labels = useMemo(() => (usage.data?.timeline ?? []).map((b) => bucketLabel(b.bucket)), [usage.data])

  const exportReport = async (): Promise<void> => {
    try {
      const text = JSON.stringify(usage.data, null, 2)
      downloadText(`aiproxy-usage-${range}.json`, text, 'application/json')
      toast.success('Usage report exported')
    } catch (e) {
      toast.error('Export failed', e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Usage & Cost"
        subtitle="GET /admin/usage — totals, timeline and per-account / per-model / per-key breakdowns"
        actions={
          <>
            <div className="segmented" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
                  {r}
                </button>
              ))}
            </div>
            <Button icon="download" onClick={() => void exportReport()} disabled={!usage.data}>
              Export JSON
            </Button>
            <Button icon="refresh" onClick={usage.reload} loading={usage.loading}>
              Refresh
            </Button>
          </>
        }
      />

      {usage.error && !usage.data ? <ErrorState error={usage.error} onRetry={usage.reload} title="Usage report unavailable" /> : null}

      <AsyncGate
        state={usage}
        skeleton={
          <div className="col" style={{ gap: 14 }}>
            <SkeletonTiles count={6} />
            <Skeleton height={260} radius={10} />
          </div>
        }
      >
        {(data) => {
          const t = data.totals
          const buckets = data.timeline ?? []
          return (
            <>
              <div className="kpis">
                <Kpi label="Requests" value={compact(t.requests)} tone="info" meta={num(t.requests)} spark={buckets.map((b) => b.requests)} sparkColor="var(--info)" />
                <Kpi
                  label="Errors"
                  value={compact(t.errors)}
                  tone={t.errors ? 'danger' : 'ok'}
                  meta={pct(t.requests ? t.errors / t.requests : 0, 2)}
                  spark={buckets.map((b) => b.errors)}
                  sparkColor="var(--danger)"
                />
                <Kpi label="Success rate" value={pct(t.success_rate, 2)} tone={t.success_rate > 0.99 ? 'ok' : 'warn'} meta="1 − errors/requests" />
                <Kpi
                  label="Cost"
                  value={usd(t.cost_usd)}
                  tone="accent"
                  meta={`${usd(t.requests ? t.cost_usd / t.requests : 0, 4)} / request`}
                  spark={buckets.map((b) => b.cost_usd)}
                  sparkColor="var(--accent-2)"
                />
                <Kpi
                  label="Tokens"
                  value={compact(t.tokens_in + t.tokens_out)}
                  meta={`↓${compact(t.tokens_in)} · ↑${compact(t.tokens_out)}`}
                  spark={buckets.map((b) => b.tokens_in + b.tokens_out)}
                />
                <Kpi label="Cache hit rate" value={pct(t.cache_hit_rate, 1)} meta={`${num(t.cached_requests)} cached`} />
                <Kpi label="Avg latency" value={ms(t.avg_latency_ms)} meta="mean" />
                <Kpi label="p95 latency" value={ms(t.p95_latency_ms)} meta="tail" />
              </div>

              <Card
                title="Timeline"
                hint={`${buckets.length} buckets · ${data.range}`}
                actions={
                  <div className="segmented" role="group" aria-label="Metric">
                    {(['requests', 'cost', 'tokens', 'errors'] as Metric[]).map((m) => (
                      <button key={m} type="button" aria-pressed={m === metric} onClick={() => setMetric(m)}>
                        {m}
                      </button>
                    ))}
                  </div>
                }
              >
                <AreaChart
                  labels={labels}
                  height={270}
                  stacked={metric === 'cost' || metric === 'tokens'}
                  emptyMessage="No timeline buckets in this range"
                  series={
                    metric === 'requests'
                      ? [
                          { key: 'ok', label: 'ok', color: 'var(--c2)', values: buckets.map((b) => Math.max(0, b.requests - b.errors)) },
                          { key: 'errors', label: 'errors', color: 'var(--c5)', values: buckets.map((b) => b.errors) },
                        ]
                      : metric === 'errors'
                        ? [{ key: 'errors', label: 'errors', color: 'var(--c5)', values: buckets.map((b) => b.errors) }]
                        : metric === 'cost'
                          ? [{ key: 'cost', label: 'cost usd', color: 'var(--c1)', values: buckets.map((b) => b.cost_usd) }]
                          : [
                              { key: 'in', label: 'tokens in', color: 'var(--c3)', values: buckets.map((b) => b.tokens_in) },
                              { key: 'out', label: 'tokens out', color: 'var(--c6)', values: buckets.map((b) => b.tokens_out) },
                            ]
                  }
                  formatValue={(v) => (metric === 'cost' ? usd(v, 2) : compact(v))}
                  formatLabel={(label) => label}
                />
              </Card>

              <Card title="Spend split" hint={`${usd(t.cost_usd)} across ${data.by_account.length} accounts`}>
                {data.by_account.length ? (
                  <Donut
                    segments={data.by_account.map((a) => ({ label: a.name, value: a.cost_usd }))}
                    centerLabel="total spend"
                    formatValue={(v) => usd(v)}
                    size={168}
                  />
                ) : (
                  <EmptyState title="No account spend in this range" />
                )}
              </Card>

              <ByAccountTable data={data} onExport={() => exportCsv('by-account', data.by_account)} />
              <ByModelTable data={data} onExport={() => exportCsv('by-model', data.by_model)} />
              <ByKeyTable data={data} onExport={() => exportCsv('by-key', data.by_key)} />
            </>
          )
        }}
      </AsyncGate>
    </div>
  )

  async function exportCsv(kind: string, rows: readonly unknown[]): Promise<void> {
    try {
      downloadText(`aiproxy-${kind}-${range}.csv`, toCsv(rows), 'text/csv')
      toast.success(`Exported ${kind}`)
    } catch (e) {
      toast.error('Export failed', e instanceof Error ? e.message : String(e))
    }
  }
}

function rangeFromHash(): UsageRange {
  const m = /range=(1h|24h|7d|30d|all)/.exec(window.location.hash)
  return (m?.[1] as UsageRange) || '24h'
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function ByAccountTable({ data, onExport }: { data: UsageResponse; onExport: () => void }): ReactElement {
  const columns = useMemo<Column<UsageByAccount>[]>(
    () => [
      { key: 'name', header: 'Account', label: 'Account', sortValue: (r) => r.name, cell: (r) => <span className="mono truncate">{r.name}</span> },
      {
        key: 'requests',
        header: 'Requests',
        label: 'Requests',
        align: 'right',
        sortValue: (r) => r.requests,
        cell: (r) => <span className="nums">{num(r.requests)}</span>,
      },
      {
        key: 'cost',
        header: 'Cost',
        label: 'Cost',
        align: 'right',
        sortValue: (r) => r.cost_usd,
        cell: (r) => (
          <div className="bar-cell" style={{ justifyContent: 'flex-end' }}>
            <div className="bar" style={{ width: 70 }}>
              <div className="bar__fill" style={{ width: `${ratio(r.cost_usd, data.totals.cost_usd) * 100}%` }} />
            </div>
            <span className="bar-cell__value">{usd(r.cost_usd)}</span>
          </div>
        ),
      },
      {
        key: 'errors',
        header: 'Errors',
        label: 'Errors',
        align: 'right',
        sortValue: (r) => r.errors,
        cell: (r) => <span className="nums">{num(r.errors)}</span>,
      },
      {
        key: 'success',
        header: 'Success',
        label: 'Success',
        align: 'right',
        sortValue: (r) => r.success_rate,
        cell: (r) => <Badge tone={r.success_rate > 0.99 ? 'ok' : r.success_rate > 0.95 ? 'warn' : 'danger'}>{pct(r.success_rate, 2)}</Badge>,
      },
      { key: 'latency', header: 'Avg latency', label: 'Latency', align: 'right', sortValue: (r) => r.avg_latency_ms, cell: (r) => <span className="nums">{ms(r.avg_latency_ms)}</span> },
      {
        key: 'tokens',
        header: 'Tokens',
        label: 'Tokens',
        align: 'right',
        sortValue: (r) => r.tokens_in + r.tokens_out,
        cell: (r) => (
          <span className="nums">
            {compact(r.tokens_in)}↓ {compact(r.tokens_out)}↑
          </span>
        ),
      },
      {
        key: 'circuit',
        header: 'Circuit',
        label: 'Circuit',
        align: 'right',
        cell: (r) => <Badge tone={r.circuit === 'closed' ? 'ok' : r.circuit === 'half_open' ? 'warn' : 'danger'}>{r.circuit}</Badge>,
      },
    ],
    [data.totals.cost_usd],
  )
  const [rows, sort, setSort] = useSortedRows<UsageByAccount>(data.by_account, columns, { key: 'cost', dir: 'desc' })

  return (
    <Card
      title="By account"
      hint={`${rows.length} rows`}
      flush
      actions={
        <Button size="sm" icon="download" onClick={onExport} disabled={!rows.length}>
          CSV
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        sort={sort ?? undefined}
        onSort={setSort}
        empty={<EmptyState title="No per-account usage in this range" />}
      />
    </Card>
  )
}

function ByModelTable({ data, onExport }: { data: UsageResponse; onExport: () => void }): ReactElement {
  const maxCost = useMemo(() => Math.max(...data.by_model.map((m) => m.cost_usd), 0), [data.by_model])
  const columns = useMemo<Column<UsageByModel>[]>(
    () => [
      { key: 'model', header: 'Model', label: 'Model', sortValue: (r) => r.model, cell: (r) => <span className="mono truncate">{r.model}</span> },
      {
        key: 'requests',
        header: 'Requests',
        label: 'Requests',
        align: 'right',
        sortValue: (r) => r.requests,
        cell: (r) => <BarCell value={r.requests} max={Math.max(...data.by_model.map((m) => m.requests), 0)} format={(v) => num(v)} />,
      },
      {
        key: 'cost',
        header: 'Cost',
        label: 'Cost',
        align: 'right',
        sortValue: (r) => r.cost_usd,
        cell: (r) => <BarCell value={r.cost_usd} max={maxCost} format={(v) => usd(v)} />,
      },
      {
        key: 'tokens',
        header: 'Tokens',
        label: 'Tokens',
        align: 'right',
        sortValue: (r) => r.tokens_in + r.tokens_out,
        cell: (r) => (
          <span className="nums">
            {compact(r.tokens_in)}↓ {compact(r.tokens_out)}↑
          </span>
        ),
      },
      {
        key: 'per_req',
        header: 'Cost / request',
        label: 'Cost/req',
        align: 'right',
        sortValue: (r) => (r.requests ? r.cost_usd / r.requests : 0),
        cell: (r) => <span className="nums">{usd(r.requests ? r.cost_usd / r.requests : 0, 4)}</span>,
      },
    ],
    [data.by_model, maxCost],
  )
  const [rows, sort, setSort] = useSortedRows<UsageByModel>(data.by_model, columns, { key: 'cost', dir: 'desc' })

  return (
    <Card
      title="By model"
      hint={`${rows.length} models`}
      flush
      actions={
        <Button size="sm" icon="download" onClick={onExport} disabled={!rows.length}>
          CSV
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.model}
        sort={sort ?? undefined}
        onSort={setSort}
        empty={<EmptyState title="No model usage in this range" />}
      />
    </Card>
  )
}

function ByKeyTable({ data, onExport }: { data: UsageResponse; onExport: () => void }): ReactElement {
  const maxCost = useMemo(() => Math.max(...data.by_key.map((k) => k.cost_usd), 0), [data.by_key])
  const columns = useMemo<Column<UsageByKey>[]>(
    () => [
      { key: 'name', header: 'API key', label: 'Key', sortValue: (r) => r.name, cell: (r) => <span className="mono truncate">{r.name || 'master'}</span> },
      {
        key: 'requests',
        header: 'Requests',
        label: 'Requests',
        align: 'right',
        sortValue: (r) => r.requests,
        cell: (r) => <BarCell value={r.requests} max={Math.max(...data.by_key.map((k) => k.requests), 0)} format={(v) => num(v)} />,
      },
      {
        key: 'cost',
        header: 'Cost',
        label: 'Cost',
        align: 'right',
        sortValue: (r) => r.cost_usd,
        cell: (r) => <BarCell value={r.cost_usd} max={maxCost} format={(v) => usd(v)} />,
      },
    ],
    [data.by_key, maxCost],
  )
  const [rows, sort, setSort] = useSortedRows<UsageByKey>(data.by_key, columns, { key: 'cost', dir: 'desc' })

  return (
    <Card
      title="By API key"
      hint={`${rows.length} keys`}
      flush
      actions={
        <Button size="sm" icon="download" onClick={onExport} disabled={!rows.length}>
          CSV
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r, i) => `${r.name}-${i}`}
        sort={sort ?? undefined}
        onSort={setSort}
        empty={<EmptyState title="No per-key usage in this range" />}
      />
    </Card>
  )
}

function ratio(v: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, v / total)) : 0
}
