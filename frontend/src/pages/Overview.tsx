import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { AreaChart } from '../components/charts/AreaChart.tsx'
import { BarList } from '../components/charts/BarList.tsx'
import { Donut } from '../components/charts/Donut.tsx'
import { Button, Card, PageHeader } from '../components/ui/Primitives.tsx'
import { QuickStart } from '../components/QuickStart.tsx'
import { Kpi } from '../components/ui/Kpi.tsx'
import { AsyncGate, EmptyState, ErrorState, Skeleton, SkeletonRows, SkeletonTiles } from '../components/ui/States.tsx'
import { useLive } from '../app/LiveContext.tsx'
import { api } from '../lib/api.ts'
import type { UsageRange } from '../lib/types.ts'
import { useAsync, useInterval } from '../lib/hooks.ts'
import { ago, bucketLabel, clock, compact, levelTone, ms, num, pct, toneColor, usd } from '../lib/format.ts'

const RANGES: UsageRange[] = ['1h', '24h', '7d', '30d', 'all']

export function Overview(): ReactElement {
  const { accounts, health, logs, streamStatus, paused, reloadAccounts } = useLive()
  const [range, setRange] = useRange()

  const usage = useAsync((signal) => api.usage(range, signal), [range])
  useInterval(usage.reload, 30000)

  const totals = usage.data?.totals
  const timeline = useMemo(() => usage.data?.timeline ?? [], [usage.data])
  const labels = useMemo(() => timeline.map((b) => bucketLabel(b.bucket)), [timeline])

  const accountList = accounts ?? []
  const enabledCount = accountList.filter((a) => a.enabled).length

  const errorRate = totals && totals.requests ? totals.errors / totals.requests : 0

  const feed = useMemo(() => logs.slice(0, 60), [logs])

  return (
    <div className="page">
      <PageHeader
        title="Overview"
        subtitle={
          health ? (
            <>
              v{health.version} · up {Math.floor(health.uptime_s / 3600)}h{' '}
              {Math.floor((health.uptime_s % 3600) / 60)}m · {health.accounts.total} accounts ·{' '}
              {health.accounts.enabled} enabled
            </>
          ) : (
            'connecting…'
          )
        }
        actions={
          <>
            <div className="segmented" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
                  {r}
                </button>
              ))}
            </div>
            <Button icon="refresh" onClick={() => usage.reload()} loading={usage.loading}>
              Refresh
            </Button>
          </>
        }
      />

      {/* Endpoint + key creation come first: without both, nothing below works. */}
      <QuickStart />

      {usage.error && !usage.data ? <ErrorState error={usage.error} onRetry={usage.reload} title="Usage report unavailable" /> : null}

      <AsyncGate
        state={usage}
        skeleton={
          <div className="col" style={{ gap: 14 }}>
            <SkeletonTiles count={8} />
            <div className="grid grid--main">
              <Skeleton height={260} radius={10} />
              <Skeleton height={260} radius={10} />
            </div>
          </div>
        }
        empty={
          <EmptyState
            icon="chart"
            title="No traffic in this window"
            text="Once requests flow through the proxy, the timeline, cost split and account health light up here."
            action={
              <Button icon="refresh" onClick={() => usage.reload()}>
                Reload
              </Button>
            }
          />
        }
      >
        {(data) => {
          const t = data.totals
          return (
            <>
              <div className="kpis">
                <Kpi
                  label="Requests"
                  value={compact(t.requests)}
                  tone="info"
                  meta={<span>{num(t.requests)} total</span>}
                  spark={timeline.map((b) => b.requests)}
                  sparkColor="var(--info)"
                />
                <Kpi
                  label="Error rate"
                  value={pct(errorRate, 2)}
                  tone={errorRate > 0.05 ? 'danger' : errorRate > 0.01 ? 'warn' : 'ok'}
                  meta={<span>{num(t.errors)} errors</span>}
                  spark={timeline.map((b) => b.errors)}
                  sparkColor="var(--danger)"
                />
                <Kpi
                  label="Success rate"
                  value={pct(t.success_rate, 2)}
                  tone={t.success_rate > 0.99 ? 'ok' : t.success_rate > 0.95 ? 'warn' : 'danger'}
                  meta={<span>{num(t.requests - t.errors)} ok</span>}
                />
                <Kpi
                  label="Tokens"
                  value={compact(t.tokens_in + t.tokens_out)}
                  meta={
                    <span className="row" style={{ gap: 6 }}>
                      <span title="prompt">↓{compact(t.tokens_in)}</span>
                      <span title="completion">↑{compact(t.tokens_out)}</span>
                    </span>
                  }
                  spark={timeline.map((b) => b.tokens_in + b.tokens_out)}
                />
                <Kpi
                  label="Cost"
                  value={usd(t.cost_usd)}
                  tone="accent"
                  meta={<span>{usd(t.requests ? t.cost_usd / t.requests : 0, 4)}/req</span>}
                  spark={timeline.map((b) => b.cost_usd)}
                  sparkColor="var(--accent-2)"
                />
                <Kpi label="Avg latency" value={ms(t.avg_latency_ms)} meta={<span>mean</span>} />
                <Kpi label="p95 latency" value={ms(t.p95_latency_ms)} meta={<span>tail</span>} />
                <Kpi
                  label="Cache hit rate"
                  value={pct(t.cache_hit_rate, 1)}
                  tone={t.cache_hit_rate > 0.2 ? 'ok' : 'muted'}
                  meta={<span>{num(t.cached_requests)} cached</span>}
                />
                <Kpi
                  label="Active accounts"
                  value={`${enabledCount}/${accountList.length}`}
                  tone={enabledCount > 0 ? 'ok' : 'danger'}
                  meta={
                    <span>
                      {accountList.filter((a) => a.health?.circuit === 'open').length} open circuit
                    </span>
                  }
                />
              </div>

              <div className="grid grid--main">
                <Card
                  title="Requests vs errors"
                  hint={`${data.range} · ${timeline.length} buckets`}
                  actions={
                    <div className="chart__legend">
                      <span>
                        <i className="chart__swatch" style={{ background: 'var(--c2)' }} /> requests
                      </span>
                      <span>
                        <i className="chart__swatch" style={{ background: 'var(--c5)' }} /> errors
                      </span>
                    </div>
                  }
                >
                  <AreaChart
                    labels={labels}
                    height={248}
                    series={[
                      { key: 'requests', label: 'requests', color: 'var(--c2)', values: timeline.map((b) => b.requests) },
                      { key: 'errors', label: 'errors', color: 'var(--c5)', values: timeline.map((b) => b.errors) },
                    ]}
                    emptyMessage="No buckets returned for this range"
                  />
                </Card>

                <Card title="Cost by account" hint={`${usd(t.cost_usd)} total`}>
                  {data.by_account.length ? (
                    <div className="col" style={{ gap: 14 }}>
                      <CostSplit total={t.cost_usd} rows={data.by_account.map((a) => ({ name: a.name, cost: a.cost_usd }))} />
                      <div className="divider" />
                      <BarList
                        rows={data.by_account.map((a) => ({
                          label: a.name,
                          value: a.cost_usd,
                          hint: `${num(a.requests)} req · ${pct(a.success_rate, 1)} ok`,
                        }))}
                        formatValue={(v) => usd(v)}
                      />
                    </div>
                  ) : (
                    <EmptyState title="No cost recorded yet" text="Cost per account appears once requests are billed." />
                  )}
                </Card>
              </div>
            </>
          )
        }}
      </AsyncGate>

      <Card
        title="Circuit breakers"
        hint="live per-account state"
        actions={
          <Button size="sm" icon="refresh" onClick={reloadAccounts}>
            Refresh
          </Button>
        }
      >
        {accounts === null ? (
          <SkeletonRows rows={2} />
        ) : accountList.length === 0 ? (
          <EmptyState icon="server" title="No accounts configured" text="Add a provider account to start routing traffic." />
        ) : (
          <div className="circuit-strip">
            {accountList.map((a) => {
              const h = a.health
              const tone = h?.circuit === 'closed' ? 'ok' : h?.circuit === 'half_open' ? 'warn' : 'danger'
              return (
                <div className={`circuit circuit--${tone}`} key={a.name} title={h?.last_error || a.name}>
                  <span className={`dot dot--${tone}`} />
                  <span className="circuit__name">{a.name}</span>
                  <span className={`badge badge--${tone === 'ok' ? 'ok' : tone}`}>{h?.circuit ?? 'unknown'}</span>
                  <span className="circuit__meta">
                    {ms(h?.avg_latency_ms)} · {pct(h?.success_rate, 1)}
                    {h?.consecutive_failures ? ` · ${h.consecutive_failures} fails` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card
        title="Live traffic"
        hint={`${feed.length} recent · ${streamStatus}${paused ? ' (paused)' : ''}`}
        flush
        actions={
          <Button size="sm" icon="external" onClick={() => (window.location.hash = '#/traffic')}>
            Open Traffic
          </Button>
        }
      >
        {feed.length === 0 ? (
          <EmptyState icon="pulse" title="No live requests yet" text="Events appear here the moment the proxy logs a request." />
        ) : (
          <div className="feed" style={{ maxHeight: 420 }}>
            {feed.map((l) => {
              const level = l.error || (l.status ?? 0) >= 400 ? 'error' : l.level
              const tone = levelTone(level)
              return (
                <div className={`feed__row feed__row--${tone}`} key={l.id}>
                  <span className="feed__time">{clock(l.ts)}</span>
                  <span className="feed__status" style={{ color: toneColor(tone) }}>
                    {l.status ?? '—'}
                  </span>
                  <span className="feed__main truncate">
                    <span className="feed__path">{l.model || l.requested_model || l.path || l.kind}</span>
                    {l.account ? <span className="faint">via {l.account}</span> : null}
                    {l.error ? <span className="truncate" style={{ color: 'var(--danger)' }}>{l.error}</span> : null}
                  </span>
                  <span className="feed__right">
                    {l.cached ? <span className="badge badge--info">CACHE</span> : null}
                    {l.stream ? <span className="badge badge--muted">STREAM</span> : null}
                    {l.latency_ms ? <span>{ms(l.latency_ms)}</span> : null}
                    {l.attempts && l.attempts > 1 ? <span className="badge badge--warn">×{l.attempts}</span> : null}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="Cache & database" hint="GET /health + GET /admin/cache">
        <div className="grid grid--3">
          <div className="col" style={{ gap: 4 }}>
            <span className="kpi__label">Cache entries</span>
            <span className="kpi__value" style={{ fontSize: 18 }}>
              {num(health?.cache.entries ?? 0)}
            </span>
            <span className="tiny muted">
              {num(health?.cache.hits ?? 0)} hits · {num(health?.cache.misses ?? 0)} misses
            </span>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <span className="kpi__label">DB latency</span>
            <span className="kpi__value" style={{ fontSize: 18 }}>
              {ms(health?.db.latency_ms ?? null)}
            </span>
            <span className="tiny muted">{health?.db.ok ? 'sqlite ok' : 'sqlite unavailable'}</span>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <span className="kpi__label">Last activity</span>
            <span className="kpi__value" style={{ fontSize: 18 }}>
              {logs[0] ? ago(logs[0].ts) : '—'}
            </span>
            <span className="tiny muted truncate">
              {logs[0] ? `${logs[0].account ?? '—'} · ${logs[0].path ?? logs[0].kind}` : 'idle'}
            </span>
          </div>
        </div>
      </Card>

      <TopModels />
    </div>
  )
}

function CostSplit({ total, rows }: { total: number; rows: { name: string; cost: number }[] }): ReactElement {
  const palette = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)']
  const sorted = [...rows].sort((a, b) => b.cost - a.cost)
  const sum = sorted.reduce((a, b) => a + b.cost, 0) || total || 1
  return (
    <div className="col" style={{ gap: 8 }}>
      <div
        role="img"
        aria-label={`Cost split across ${sorted.length} accounts`}
        style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--panel-3)' }}
      >
        {sorted.map((r, i) => (
          <div
            key={r.name}
            title={`${r.name}: ${usd(r.cost)}`}
            style={{
              width: `${Math.max(0.5, (r.cost / sum) * 100)}%`,
              background: palette[i % palette.length],
              transition: 'width 0.5s ease',
            }}
          />
        ))}
      </div>
      <div className="row row--wrap" style={{ gap: 10, fontSize: 11 }}>
        {sorted.slice(0, 4).map((r, i) => (
          <span className="row" key={r.name} style={{ gap: 5, color: 'var(--text-dim)' }}>
            <i className="chart__swatch" style={{ background: palette[i % palette.length] }} />
            <span className="truncate" style={{ maxWidth: 110 }}>
              {r.name}
            </span>
            <span className="nums faint">{usd(r.cost)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function TopModels(): ReactElement {
  const models = useAsync((signal) => api.usage('24h', signal), [])
  const rows = useMemo(() => (models.data?.by_model ?? []).slice().sort((a, b) => b.cost_usd - a.cost_usd), [models.data])
  if (!rows.length) return <></>
  return (
    <Card title="Top models" hint="last 24h by spend">
      <div className="grid grid--2">
        <BarList
          rows={rows.map((m) => ({ label: m.model, value: m.cost_usd, hint: `${num(m.requests)} req` }))}
          formatValue={(v) => usd(v)}
          maxRows={8}
        />
        <Donut
          segments={rows.slice(0, 6).map((m) => ({ label: m.model, value: m.requests }))}
          centerLabel="requests"
          formatValue={(v) => compact(v)}
        />
      </div>
    </Card>
  )
}

/** Range is kept in the URL so a view can be linked to. */
function useRange(): [UsageRange, (r: UsageRange) => void] {
  const get = (): UsageRange => {
    const m = /range=(1h|24h|7d|30d|all)/.exec(window.location.hash)
    return (m?.[1] as UsageRange) || '24h'
  }
  const [range, setRange] = useState(get())
  const set = (r: UsageRange): void => {
    setRange(r)
    const base = window.location.hash.replace(/^#/, '').split('?')[0] || '/overview'
    window.history.replaceState(null, '', `#${base}?range=${r}`)
  }
  return [range, set]
}