import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { AccountDrawer } from '../components/AccountDrawer.tsx'
import { BarList } from '../components/charts/BarList.tsx'
import { Badge, Button, Card, IconButton, PageHeader, Spinner, StatusPill, Switch } from '../components/ui/Primitives.tsx'
import { DataTable } from '../components/ui/DataTable.tsx'
import type { Column } from '../components/ui/DataTable.tsx'
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/States.tsx'
import { Icon } from '../components/ui/Icon.tsx'
import { useConfirm, useToast } from '../components/ui/Overlays.tsx'
import { useLive } from '../app/LiveContext.tsx'
import { api, errorMessage } from '../lib/api.ts'
import type { Account, AccountTestResult } from '../lib/types.ts'
import { ago, circuitTone, compact, ms, num, pct, usd } from '../lib/format.ts'

interface TestState {
  loading: boolean
  result?: AccountTestResult
  error?: string
}

export function Providers(): ReactElement {
  const { accounts, accountsError, reloadAccounts } = useLive()
  const toast = useToast()
  const askConfirm = useConfirm()

  const [drawer, setDrawer] = useState<{ open: boolean; account: Account | null }>({ open: false, account: null })
  const [view, setView] = useState<'grouped' | 'table'>('grouped')
  const [filter, setFilter] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [busyRow, setBusyRow] = useState<string | null>(null)

  const list = useMemo(() => accounts ?? [], [accounts])
  const q = filter.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      q
        ? list.filter((a) =>
            [a.name, a.provider_type, a.base_url, a.location, ...(a.models || [])]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(q)),
          )
        : list,
    [list, q],
  )

  const groups = useMemo(() => {
    const map = new Map<string, Account[]>()
    for (const a of filtered) {
      const key = a.location || 'Unassigned'
      const arr = map.get(key) ?? []
      arr.push(a)
      map.set(key, arr)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  /* ---------------------------------------------------------------- */
  /* row actions                                                       */
  /* ---------------------------------------------------------------- */

  const runTest = async (name: string): Promise<void> => {
    setTests((t) => ({ ...t, [name]: { loading: true } }))
    try {
      const result = await api.testAccount(name)
      setTests((t) => ({ ...t, [name]: { loading: false, result } }))
      toast[result.ok ? 'success' : 'warn'](`${name}: ${result.ok ? 'reachable' : 'test failed'}`, result.ok ? `${ms(result.latency_ms)} · status ${result.status}` : result.error ?? undefined)
      reloadAccounts()
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { loading: false, error: errorMessage(e) } }))
      toast.error(`Test failed for ${name}`, errorMessage(e))
    }
  }

  const testAll = async (): Promise<void> => {
    const names = filtered.map((a) => a.name)
    if (!names.length) return
    setTests((t) => {
      const next = { ...t }
      for (const n of names) next[n] = { loading: true }
      return next
    })
    try {
      // POST /admin/health-check runs the same probe across every account
      const res = await api.healthCheck()
      setTests((t) => {
        const next = { ...t }
        for (const r of res.results ?? []) {
          next[r.name] = {
            loading: false,
            result: { name: r.name, ok: r.ok, status: r.status, latency_ms: r.latency_ms, models_sampled: null, error: null },
          }
        }
        return next
      })
      const ok = (res.results ?? []).filter((r) => r.ok).length
      toast.result(true, `Health check: ${ok}/${(res.results ?? []).length} reachable`)
      reloadAccounts()
    } catch (e) {
      setTests((t) => {
        const next = { ...t }
        for (const n of names) next[n] = { loading: false, error: errorMessage(e) }
        return next
      })
      toast.error('Health check failed', errorMessage(e))
    }
  }

  const toggleEnabled = async (account: Account, next: boolean): Promise<void> => {
    setBusyRow(account.name)
    // optimistic — reverted if the server rejects it
    reloadAccounts()
    try {
      await api.updateAccount(account.name, { enabled: next })
      toast.success(`${account.name} ${next ? 'enabled' : 'disabled'}`)
    } catch (e) {
      toast.error('Update failed', errorMessage(e))
    } finally {
      setBusyRow(null)
      reloadAccounts()
    }
  }

  const resetCircuit = async (account: Account): Promise<void> => {
    setBusyRow(account.name)
    try {
      await api.resetAccount(account.name)
      toast.success(`Circuit reset for ${account.name}`)
      reloadAccounts()
    } catch (e) {
      toast.error('Reset failed', errorMessage(e))
    } finally {
      setBusyRow(null)
    }
  }

  const remove = async (account: Account): Promise<void> => {
    const ok = await askConfirm({
      title: `Delete “${account.name}”?`,
      text: (
        <>
          The account is removed from the router immediately. Requests that would have used it will be failed over to the
          next healthy account. This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete account',
      danger: true,
    })
    if (!ok) return
    setBusyRow(account.name)
    try {
      const res = await api.deleteAccount(account.name)
      toast.success(`Deleted ${res.deleted ?? account.name}`)
      setDrawer({ open: false, account: null })
    } catch (e) {
      toast.error('Delete failed', errorMessage(e))
    } finally {
      setBusyRow(null)
      reloadAccounts()
    }
  }

  const openNew = (): void => setDrawer({ open: true, account: null })
  const openEdit = (account: Account): void => setDrawer({ open: true, account })

  /* ---------------------------------------------------------------- */
  /* columns                                                           */
  /* ---------------------------------------------------------------- */

  const columns = useMemo<Column<Account>[]>(
    () => [
      {
        key: 'name',
        header: 'Account',
        label: 'Account',
        width: '22%',
        sortValue: (a) => a.name,
        cell: (a) => (
          <div className="col" style={{ gap: 1, minWidth: 0 }}>
            <span className="row" style={{ gap: 6 }}>
              <Icon name="server" size={13} className="muted" />
              <span className="truncate" style={{ fontWeight: 600 }}>
                {a.name}
              </span>
              {!a.enabled ? <Badge tone="muted">off</Badge> : null}
            </span>
            <span className="tiny faint truncate mono">
              {a.provider_type}
              {a.base_url ? ` · ${a.base_url}` : ''}
            </span>
          </div>
        ),
      },
      {
        key: 'models',
        header: 'Models',
        label: 'Models',
        sortValue: (a) => a.models?.length ?? 0,
        cell: (a) => (
          <span className="tiny mono muted truncate" title={a.models?.join(', ')}>
            {a.models?.length ? `${a.models.length} · ${a.models.slice(0, 2).join(', ')}${(a.models?.length ?? 0) > 2 ? '…' : ''}` : 'pass-through'}
          </span>
        ),
      },
      {
        key: 'circuit',
        header: 'Circuit',
        label: 'Circuit',
        sortValue: (a) => a.health?.circuit ?? '',
        cell: (a) => {
          const tone = circuitTone(a.health?.circuit)
          return (
            <span className="row" style={{ gap: 6 }}>
              <span className={`dot dot--${tone === 'muted' ? 'warn' : tone}`} />
              <span className="small">{a.health?.circuit ?? 'unknown'}</span>
              {a.health?.consecutive_failures ? <span className="tiny faint">×{a.health.consecutive_failures}</span> : null}
            </span>
          )
        },
      },
      {
        key: 'latency',
        header: 'Latency',
        label: 'Latency',
        align: 'right',
        sortValue: (a) => a.health?.avg_latency_ms ?? Number.MAX_SAFE_INTEGER,
        cell: (a) => <span className="nums small">{ms(a.health?.avg_latency_ms)}</span>,
      },
      {
        key: 'success',
        header: 'Success',
        label: 'Success',
        align: 'right',
        sortValue: (a) => a.health?.success_rate ?? -1,
        cell: (a) => <span className="nums small">{pct(a.health?.success_rate, 1)}</span>,
      },
      {
        key: 'requests',
        header: 'Requests',
        label: 'Requests',
        align: 'right',
        sortValue: (a) => a.counters?.requests ?? 0,
        cell: (a) => <span className="nums small">{compact(a.counters?.requests ?? 0)}</span>,
      },
      {
        key: 'tokens',
        header: 'Tokens',
        label: 'Tokens',
        align: 'right',
        sortValue: (a) => (a.counters?.tokens_in ?? 0) + (a.counters?.tokens_out ?? 0),
        cell: (a) => <span className="nums small">{compact((a.counters?.tokens_in ?? 0) + (a.counters?.tokens_out ?? 0))}</span>,
      },
      {
        key: 'cost',
        header: 'Cost',
        label: 'Cost',
        align: 'right',
        sortValue: (a) => a.budget?.spent_today_usd ?? 0,
        cell: (a) => {
          const spent = a.budget?.spent_today_usd ?? 0
          const cap = a.budget?.daily_usd ?? 0
          const ratio = cap > 0 ? spent / cap : 0
          return (
            <div className="bar-cell" style={{ justifyContent: 'flex-end' }}>
              {cap > 0 ? (
                <div className="bar" style={{ width: 46 }}>
                  <div
                    className={`bar__fill${ratio > 0.9 ? ' bar__fill--danger' : ratio > 0.7 ? ' bar__fill--warn' : ''}`}
                    style={{ width: `${Math.min(100, ratio * 100)}%` }}
                  />
                </div>
              ) : null}
              <span className="bar-cell__value">{usd(spent)}</span>
            </div>
          )
        },
      },
      {
        key: 'test',
        header: 'Test',
        label: 'Test',
        sortValue: (a) => (tests[a.name]?.result?.latency_ms ?? Number.MAX_SAFE_INTEGER),
        cell: (a) => <TestCell name={a.name} state={tests[a.name]} onRun={runTest} />,
      },
      {
        key: 'actions',
        header: 'Actions',
        label: '',
        actions: true,
        cell: (a) => (
          <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {busyRow === a.name ? <Spinner /> : null}
            <Switch
              checked={a.enabled}
              onChange={(v) => void toggleEnabled(a, v)}
              ariaLabel={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
              disabled={busyRow === a.name}
            />
            <IconButton label={`Edit ${a.name}`} name="edit" onClick={() => openEdit(a)} />
            <IconButton
              label={`Reset circuit for ${a.name}`}
              name="refresh"
              onClick={() => void resetCircuit(a)}
              disabled={busyRow === a.name}
            />
            <IconButton label={`Delete ${a.name}`} name="trash" tone="danger" onClick={() => void remove(a)} disabled={busyRow === a.name} />
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tests, busyRow],
  )

  /* ---------------------------------------------------------------- */
  /* render                                                            */
  /* ---------------------------------------------------------------- */

  const loading = accounts === null

  return (
    <div className="page">
      <PageHeader
        title="Providers"
        subtitle={`${list.length} accounts · ${list.filter((a) => a.enabled).length} enabled · ${list.filter((a) => a.health?.circuit === 'open').length} open circuit`}
        actions={
          <>
            <input
              className="input"
              style={{ width: 180 }}
              placeholder="Filter accounts…"
              value={filter}
              aria-label="Filter accounts"
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="segmented" role="group" aria-label="View mode">
              <button type="button" aria-pressed={view === 'grouped'} onClick={() => setView('grouped')}>
                Grouped
              </button>
              <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
                Table
              </button>
            </div>
            <Button icon="zap" onClick={() => void testAll()} loading={Object.values(tests).every((t) => !t.loading)}>
              Test all
            </Button>
            <Button variant="primary" icon="plus" onClick={openNew}>
              New account
            </Button>
          </>
        }
      />

      {accountsError && !accounts ? (
        <ErrorState error={accountsError} onRetry={reloadAccounts} title="Could not load accounts" />
      ) : null}

      {list.length > 0 ? (
        <div className="kpis">
          <StatTile label="Accounts" value={num(list.length)} meta={`${list.filter((a) => a.enabled).length} enabled`} />
          <StatTile
            label="Healthy"
            value={num(list.filter((a) => a.health?.circuit === 'closed').length)}
            tone="ok"
            meta={`${num(list.filter((a) => a.health?.circuit === 'open').length)} open · ${num(list.filter((a) => a.health?.circuit === 'half_open').length)} half-open`}
          />
          <StatTile
            label="Requests"
            value={compact(list.reduce((s, a) => s + (a.counters?.requests ?? 0), 0))}
            meta={`${compact(list.reduce((s, a) => s + (a.counters?.errors ?? 0), 0))} errors`}
          />
          <StatTile
            label="Spend"
            value={usd(list.reduce((s, a) => s + (a.budget?.spent_today_usd ?? 0), 0))}
            tone="accent"
            meta="today, all accounts"
          />
          <StatTile
            label="Avg latency"
            value={ms(
              (() => {
                const withLat = list.filter((a) => typeof a.health?.avg_latency_ms === 'number')
                if (!withLat.length) return null
                return withLat.reduce((s, a) => s + (a.health?.avg_latency_ms ?? 0), 0) / withLat.length
              })(),
            )}
            meta="across accounts"
          />
        </div>
      ) : null}

      {loading ? (
        <Card title="Accounts">
          <SkeletonRows rows={5} height={40} />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon="server"
            title="No accounts yet"
            text="Add your first upstream account — OpenAI, Anthropic, Gemini or any OpenAI-compatible endpoint."
            action={
              <Button variant="primary" icon="plus" onClick={openNew}>
                New account
              </Button>
            }
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState icon="search" title="No accounts match the filter" text={`Nothing matched “${filter}”.`} />
        </Card>
      ) : view === 'table' ? (
        <Card title="All accounts" hint={`${filtered.length} rows`} flush>
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(a) => a.name}
            renderExpanded={(a) => <AccountDetail account={a} tests={tests} onTest={runTest} />}
          />
        </Card>
      ) : (
        <div className="col" style={{ gap: 14 }}>
          {groups.map(([location, rows]) => (
            <Card
              key={location}
              title={
                <span className="row" style={{ gap: 7 }}>
                  <Icon name="database" size={13} className="muted" />
                  {location}
                </span>
              }
              hint={`${rows.length} account${rows.length === 1 ? '' : 's'} · ${rows.filter((a) => a.enabled).length} enabled`}
              flush
              footer={
                <div style={{ width: '100%' }}>
                  <BarList
                    rows={rows.map((a) => ({
                      label: a.name,
                      value: a.counters?.requests ?? 0,
                      hint: `${usd(a.budget?.spent_today_usd ?? 0)} today · ${pct(a.health?.success_rate, 1)} ok`,
                    }))}
                    formatValue={(v) => `${compact(v)} req`}
                    maxRows={5}
                  />
                </div>
              }
            >
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(a) => a.name}
                renderExpanded={(a) => <AccountDetail account={a} tests={tests} onTest={runTest} />}
              />
            </Card>
          ))}
        </div>
      )}

      <AccountDrawer
        open={drawer.open}
        account={drawer.account}
        onClose={() => setDrawer({ open: false, account: null })}
        onSaved={() => reloadAccounts()}
      />
    </div>
  )
}

function StatTile({ label, value, meta, tone }: { label: string; value: string; meta: string; tone?: 'ok' | 'accent' }): ReactElement {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ''}`}>
      <span className="kpi__label">{label}</span>
      <span className="kpi__value">{value}</span>
      <span className="kpi__meta">{meta}</span>
    </div>
  )
}

function TestCell({ name, state, onRun }: { name: string; state?: TestState; onRun: (n: string) => void }): ReactElement {
  if (!state) {
    return (
      <Button size="sm" icon="play" onClick={() => onRun(name)} aria-label={`Test ${name}`}>
        Run
      </Button>
    )
  }
  if (state.loading) return <span className="row tiny muted" style={{ gap: 5 }}><Spinner size={11} /> testing…</span>
  if (state.error) return <span className="tiny" style={{ color: 'var(--danger)' }}>{state.error.slice(0, 40)}</span>
  const r = state.result
  if (!r) return <span className="tiny faint">—</span>
  return (
    <span className="row tiny" style={{ gap: 6, justifyContent: 'flex-end' }} title={r.error ?? `status ${r.status}`}>
      <Badge tone={r.ok ? 'ok' : 'danger'}>{r.ok ? 'OK' : 'FAIL'}</Badge>
      <span className="nums muted">{ms(r.latency_ms)}</span>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRun(name)} aria-label={`Retest ${name}`}>
        ↻
      </button>
    </span>
  )
}

function AccountDetail({
  account,
  tests,
  onTest,
}: {
  account: Account
  tests: Record<string, TestState>
  onTest: (n: string) => void
}): ReactElement {
  const h = account.health
  const t = tests[account.name]
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="grid grid--3">
        <div className="col" style={{ gap: 3 }}>
          <span className="kpi__label">Health</span>
          <StatusPill tone={circuitTone(h?.circuit)}>{h?.circuit ?? 'unknown'}</StatusPill>
          <span className="tiny muted truncate">
            {h?.consecutive_failures ?? 0} consecutive failures · {h?.in_flight ?? 0} in flight
          </span>
        </div>
        <div className="col" style={{ gap: 3 }}>
          <span className="kpi__label">Traffic</span>
          <span className="small">
            {num(account.counters?.requests ?? 0)} requests · {num(account.counters?.errors ?? 0)} errors
          </span>
          <span className="tiny muted">
            {num(account.counters?.tokens_in ?? 0)} in · {num(account.counters?.tokens_out ?? 0)} out ·{' '}
            {usd(account.counters?.cost_usd ?? 0)}
          </span>
        </div>
        <div className="col" style={{ gap: 3 }}>
          <span className="kpi__label">Limits</span>
          <span className="small">
            {account.rate_limit?.rpm ?? '∞'} rpm · {account.rate_limit?.tpm ?? '∞'} tpm
            {account.rate_limit?.burst ? ` · burst ${account.rate_limit.burst}` : ''}
          </span>
          <span className="tiny muted">
            {account.rate_limit?.enabled === false ? 'rate limiting disabled' : 'enforced'} · w{account.weight} · p
            {account.priority}
          </span>
        </div>
      </div>

      {h?.last_error ? (
        <div className="alert alert--danger">
          <span className="alert__icon">
            <Icon name="alert" size={14} />
          </span>
          <div className="truncate" style={{ maxWidth: '100%' }}>
            {h.last_error}
          </div>
        </div>
      ) : null}

      <div className="kv">
        <div className="kv__k">Models</div>
        <div className="kv__v">{account.models?.length ? account.models.join(', ') : 'pass-through'}</div>
        <div className="kv__k">Base URL</div>
        <div className="kv__v">{account.base_url || '—'}</div>
        <div className="kv__k">API key</div>
        <div className="kv__v">{account.api_key_masked || '—'}</div>
        <div className="kv__k">Proxy</div>
        <div className="kv__v">
          {account.proxy?.enabled ? account.proxy.url_masked || 'enabled (url masked)' : 'direct'}
        </div>
        <div className="kv__k">User agent</div>
        <div className="kv__v">{account.user_agent || 'default'}</div>
        <div className="kv__k">Budget</div>
        <div className="kv__v">
          {usd(account.budget?.spent_today_usd ?? 0)} today
          {account.budget?.daily_usd ? ` / ${usd(account.budget.daily_usd)}` : ' · no daily cap'}
          {account.budget?.monthly_usd ? ` · ${usd(account.budget.monthly_usd)} monthly` : ''}
        </div>
        <div className="kv__k">Last success</div>
        <div className="kv__v">{ago(h?.last_success_ts ?? null)}</div>
        <div className="kv__k">Extra headers</div>
        <div className="kv__v">
          {account.extra_headers && Object.keys(account.extra_headers).length
            ? Object.entries(account.extra_headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')
            : 'none'}
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <Button size="sm" icon="play" onClick={() => onTest(account.name)} loading={t?.loading}>
          {t?.result ? 'Retest' : 'Test connectivity'}
        </Button>
        {t?.result ? (
          <span className="tiny muted">
            status {t.result.status} · {ms(t.result.latency_ms)}
            {t.result.models_sampled ? ` · ${t.result.models_sampled} models sampled` : ''}
            {t.result.error ? ` · ${t.result.error}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  )
}