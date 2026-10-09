import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Badge, Button, Card, PageHeader, SectionTitle, Switch } from '../components/ui/Primitives.tsx'
import { NumberField, TagInput, TextField } from '../components/ui/Fields.tsx'
import { CopyButton } from '../components/ui/Primitives.tsx'
import { AsyncGate, EmptyState, ErrorState, Skeleton } from '../components/ui/States.tsx'
import { Icon } from '../components/ui/Icon.tsx'
import { useConfirm, useToast } from '../components/ui/Overlays.tsx'
import { api, errorMessage } from '../lib/api.ts'
import type { BudgetResponse, BudgetUpdate, CacheStatus, KeyRecord, KeysResponse, ServerConfigResponse } from '../lib/types.ts'
import { useAsync } from '../lib/hooks.ts'
import { ago, bytes, json, num, pct, usd } from '../lib/format.ts'

type ConfigDraft = {
  server: { host: string; port: number; request_timeout_s: number; stream_timeout_s: number }
  limits: { max_body_bytes: number; max_concurrency: number }
  cors: { origins: string[] }
  features: Record<string, boolean>
}

export function Settings(): ReactElement {
  const toast = useToast()
  const config = useAsync<ServerConfigResponse>((signal) => api.config(signal), [])
  const [draft, setDraft] = useState<ConfigDraft | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!config.data) return
    setDraft({
      server: config.data.server,
      limits: config.data.limits,
      cors: { origins: config.data.cors?.origins ?? [] },
      features: { ...config.data.features },
    })
  }, [config.data])

  const dirty = useMemo(() => {
    if (!draft || !config.data) return false
    return (
      JSON.stringify(draft.server) !== JSON.stringify(config.data.server) ||
      JSON.stringify(draft.limits) !== JSON.stringify(config.data.limits) ||
      JSON.stringify(draft.cors) !== JSON.stringify({ origins: config.data.cors?.origins ?? [] }) ||
      JSON.stringify(draft.features) !== JSON.stringify(config.data.features)
    )
  }, [draft, config.data])

  const saveConfig = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      await api.updateConfig({
        server: draft.server,
        limits: draft.limits,
        cors: draft.cors,
        features: draft.features,
      })
      toast.success('Configuration saved')
      config.reload()
    } catch (e) {
      toast.error('Save failed', errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        subtitle="Server configuration, budgets, API keys and maintenance"
        actions={
          <>
            {dirty ? <Badge tone="warn">unsaved changes</Badge> : null}
            <Button icon="refresh" onClick={config.reload} loading={config.loading}>
              Reload
            </Button>
            <Button variant="primary" icon="save" onClick={() => void saveConfig()} disabled={!dirty} loading={saving}>
              Save config
            </Button>
          </>
        }
      />

      {config.error && !config.data ? <ErrorState error={config.error} onRetry={config.reload} /> : null}

      <AsyncGate state={config} skeleton={<Skeleton height={260} radius={10} />}>
        {(data) => (
          <>
            <div className="grid grid--2">
              <Card title="Instance" hint={`version ${data.version}`}>
                <div className="col" style={{ gap: 10 }}>
                  <div className="kv">
                    <div className="kv__k">database</div>
                    <div className="kv__v">{data.db}</div>
                    <div className="kv__k">data dir</div>
                    <div className="kv__v truncate" title={data.data_dir}>
                      {data.data_dir}
                    </div>
                    <div className="kv__k">encryption</div>
                    <div className="kv__v">
                      <Badge tone={data.encryption === 'fernet' ? 'ok' : 'warn'}>{data.encryption}</Badge>
                    </div>
                    <div className="kv__k">master key</div>
                    <div className="kv__v">{data.master_key_masked}</div>
                  </div>
                  {data.encryption !== 'fernet' ? (
                    <div className="alert alert--warn">
                      <span className="alert__icon">
                        <Icon name="alert" size={14} />
                      </span>
                      Set <code className="mono">PROXY_ENCRYPTION_KEY</code> to store account secrets encrypted at rest.
                    </div>
                  ) : null}
                </div>
              </Card>

              <Card title="Server" hint="PUT /admin/config">
                {draft ? (
                  <div className="col" style={{ gap: 12 }}>
                    <div className="grid grid--2">
                      <TextField label="Host" mono value={draft.server.host} onChange={(v) => setDraft({ ...draft, server: { ...draft.server, host: v } })} />
                      <NumberField
                        label="Port"
                        value={draft.server.port}
                        onChange={(v) => setDraft({ ...draft, server: { ...draft.server, port: v ?? 8000 } })}
                        min={1}
                        max={65535}
                      />
                    </div>
                    <div className="grid grid--2">
                      <NumberField
                        label="Request timeout (s)"
                        value={draft.server.request_timeout_s}
                        onChange={(v) => setDraft({ ...draft, server: { ...draft.server, request_timeout_s: v ?? 120 } })}
                        min={1}
                        step={10}
                      />
                      <NumberField
                        label="Stream timeout (s)"
                        value={draft.server.stream_timeout_s}
                        onChange={(v) => setDraft({ ...draft, server: { ...draft.server, stream_timeout_s: v ?? 900 } })}
                        min={1}
                        step={30}
                      />
                    </div>
                    <div className="grid grid--2">
                      <NumberField
                        label="Max body bytes"
                        value={draft.limits.max_body_bytes}
                        onChange={(v) => setDraft({ ...draft, limits: { ...draft.limits, max_body_bytes: v ?? 0 } })}
                        min={0}
                        step={1024}
                      />
                      <NumberField
                        label="Max concurrency (0 = unlimited)"
                        value={draft.limits.max_concurrency}
                        onChange={(v) => setDraft({ ...draft, limits: { ...draft.limits, max_concurrency: v ?? 0 } })}
                        min={0}
                      />
                    </div>
                    <TagInput label="CORS origins" values={draft.cors.origins} onChange={(v) => setDraft({ ...draft, cors: { origins: v } })} placeholder="https://app.example.com" />
                  </div>
                ) : null}
              </Card>
            </div>

            <Card title="Feature flags" hint="toggled instantly on save">
              {draft ? (
                <div className="grid grid--3">
                  {Object.entries(draft.features).map(([key, value]) => (
                    <Switch
                      key={key}
                      checked={value}
                      onChange={(v) => setDraft({ ...draft, features: { ...draft.features, [key]: v } })}
                      label={key.replace(/_/g, ' ')}
                      ariaLabel={key}
                    />
                  ))}
                </div>
              ) : null}
            </Card>

            <CacheCard />
          </>
        )}
      </AsyncGate>

      <BudgetSection />
      <KeysSection />
      <DangerZone />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

function CacheCard(): ReactElement {
  const toast = useToast()
  const askConfirm = useConfirm()
  const cache = useAsync<CacheStatus>((signal) => api.cache(signal), [])

  const clear = async (): Promise<void> => {
    const ok = await askConfirm({ title: 'Clear the response cache?', text: `${num(cache.data?.entries ?? 0)} entries will be dropped. Requests are unaffected.`, confirmLabel: 'Clear cache' })
    if (!ok) return
    try {
      const res = await api.clearCache()
      toast.success(`Cleared ${res.cleared} cache entries`)
      cache.reload()
    } catch (e) {
      toast.error('Clear failed', errorMessage(e))
    }
  }

  return (
    <Card
      title="Response cache"
      hint="GET /admin/cache"
      actions={
        <Button size="sm" icon="trash" onClick={() => void clear()}>
          Clear
        </Button>
      }
    >
      {cache.initial ? (
        <Skeleton height={60} />
      ) : cache.error ? (
        <ErrorState error={cache.error} onRetry={cache.reload} compact />
      ) : !cache.data ? (
        <EmptyState title="Cache status unavailable" />
      ) : (
        <div className="kpis">
          <Tile label="Entries" value={num(cache.data.entries)} meta={`max ${num(cache.data.max_entries)}`} />
          <Tile label="Hit rate" value={pct(cache.data.hit_rate, 1)} meta={`${num(cache.data.hits)} hits / ${num(cache.data.misses)} misses`} tone="ok" />
          <Tile label="TTL" value={`${num(cache.data.ttl_seconds)}s`} meta={cache.data.enabled ? 'enabled' : 'disabled'} tone={cache.data.enabled ? 'accent' : undefined} />
          <Tile label="Size" value={bytes(cache.data.bytes)} meta={`${num(cache.data.evictions)} evictions`} />
        </div>
      )}
    </Card>
  )
}

function Tile({ label, value, meta, tone }: { label: string; value: string; meta: string; tone?: 'ok' | 'accent' }): ReactElement {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ''}`} style={{ padding: '10px 12px' }}>
      <span className="kpi__label">{label}</span>
      <span className="kpi__value" style={{ fontSize: 18 }}>
        {value}
      </span>
      <span className="kpi__meta truncate">{meta}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

function BudgetSection(): ReactElement {
  const toast = useToast()
  const budget = useAsync<BudgetResponse>((signal) => api.budget(signal), [])
  const [draft, setDraft] = useState<BudgetUpdate | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!budget.data) return
    setDraft({
      daily_usd: budget.data.global?.daily_usd ?? null,
      monthly_usd: budget.data.global?.monthly_usd ?? null,
      hard_stop: budget.data.global?.hard_stop ?? true,
      alerts: (budget.data.alerts ?? []).map((a) => a.threshold_pct),
    })
  }, [budget.data])

  const dirty = useMemo(() => {
    if (!draft || !budget.data) return false
    return (
      draft.daily_usd !== budget.data.global?.daily_usd ||
      draft.monthly_usd !== budget.data.global?.monthly_usd ||
      draft.hard_stop !== budget.data.global?.hard_stop ||
      JSON.stringify(draft.alerts) !== JSON.stringify((budget.data.alerts ?? []).map((a) => a.threshold_pct))
    )
  }, [draft, budget.data])

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      await api.updateBudget(draft)
      toast.success('Budget updated')
      budget.reload()
    } catch (e) {
      toast.error('Save failed', errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const g = budget.data?.global

  return (
    <Card
      title="Budget & alerts"
      hint="PUT /admin/budget"
      actions={
        <>
          {dirty ? <Badge tone="warn">unsaved</Badge> : null}
          <Button size="sm" icon="save" onClick={() => void save()} disabled={!dirty} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      {budget.initial ? (
        <Skeleton height={140} />
      ) : budget.error ? (
        <ErrorState error={budget.error} onRetry={budget.reload} compact />
      ) : !draft || !g ? (
        <EmptyState title="Budget not configured" />
      ) : (
        <div className="col" style={{ gap: 14 }}>
          <div className="grid grid--4">
            <Tile label="Spent today" value={usd(g.spent_today_usd)} meta={`window ${g.window_utc ?? 'utc'}`} tone="accent" />
            <Tile label="Remaining today" value={usd(g.remaining_today_usd)} meta={`cap ${usd(g.daily_usd)}`} tone="ok" />
            <Tile label="Spent this month" value={usd(g.spent_month_usd)} meta={g.monthly_usd ? `cap ${usd(g.monthly_usd)}` : 'no monthly cap'} />
            <div className="kpi" style={{ padding: '10px 12px' }}>
              <span className="kpi__label">Hard stop</span>
              <span style={{ paddingTop: 4 }}>
                <Switch
                  checked={draft.hard_stop ?? true}
                  onChange={(v) => setDraft({ ...draft, hard_stop: v })}
                  label={draft.hard_stop ? '429 when exhausted' : 'allow overspend'}
                  ariaLabel="Hard stop"
                />
              </span>
            </div>
          </div>

          <div className="grid grid--3">
            <NumberField label="Daily budget (USD)" value={draft.daily_usd ?? null} onChange={(v) => setDraft({ ...draft, daily_usd: v })} nullable min={0} step={1} />
            <NumberField label="Monthly budget (USD)" value={draft.monthly_usd ?? null} onChange={(v) => setDraft({ ...draft, monthly_usd: v })} nullable min={0} step={10} />
            <TagInput
              label="Alert thresholds (%)"
              values={(draft.alerts ?? []).map(String)}
              onChange={(v) => setDraft({ ...draft, alerts: v.map(Number).filter((n) => Number.isFinite(n)) })}
              placeholder="80, 95"
              hint="comma separated percentages of the budget"
            />
          </div>

          {(budget.data?.alerts ?? []).length ? (
            <div className="row row--wrap" style={{ gap: 6 }}>
              <span className="tiny muted">fired:</span>
              {(budget.data?.alerts ?? []).map((a) => (
                <Badge key={a.threshold_pct} tone={a.fired ? 'warn' : 'muted'}>
                  {a.threshold_pct}%{a.fired ? ' · fired' : ''}
                </Badge>
              ))}
            </div>
          ) : null}

          {(budget.data?.keys ?? []).length ? (
            <>
              <SectionTitle>per-key budgets</SectionTitle>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th style={{ textAlign: 'right' }}>Daily cap</th>
                      <th style={{ textAlign: 'right' }}>Spent</th>
                      <th style={{ textAlign: 'right' }}>rpm / tpm</th>
                      <th>Allow / deny</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(budget.data?.keys ?? []).map((k, i) => (
                      <tr key={`${k.name}-${i}`}>
                        <td className="mono small">{k.name}</td>
                        <td className="right nums small">{usd(k.daily_usd)}</td>
                        <td className="right nums small">{usd(k.spent_today_usd, 4)}</td>
                        <td className="right nums small">
                          {k.rpm ?? '∞'} / {k.tpm ?? '∞'}
                        </td>
                        <td className="tiny muted truncate">
                          {k.models_allow ? `allow: ${k.models_allow.join(', ')}` : ''}
                          {k.models_deny ? ` deny: ${k.models_deny.join(', ')}` : ''}
                          {!k.models_allow && !k.models_deny ? 'all models' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

function KeysSection(): ReactElement {
  const toast = useToast()
  const keys = useAsync<KeysResponse>((signal) => api.keys(signal), [])
  const [name, setName] = useState('')
  const [daily, setDaily] = useState<number | null>(null)
  const [rpm, setRpm] = useState<number | null>(null)
  const [tpm, setTpm] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<{ name: string; key: string } | null>(null)

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const res = await api.createKey({
        name: name.trim(),
        daily_usd: daily,
        rpm,
        tpm,
      })
      // the full key is returned exactly once
      setRevealed({ name: res.name, key: res.key })
      setName('')
      setDaily(null)
      setRpm(null)
      setTpm(null)
      toast.success(`Key “${res.name}” created`)
      keys.reload()
    } catch (e) {
      toast.error('Could not create key', errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const rows: KeyRecord[] = keys.data?.keys ?? []

  return (
    <Card
      title="API keys"
      hint="GET /admin/keys · POST /admin/keys"
      actions={
        <Button size="sm" icon="refresh" onClick={keys.reload} loading={keys.loading}>
          Refresh
        </Button>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {revealed ? (
          <div className="col" style={{ gap: 8 }}>
            <div className="alert alert--warn">
              <span className="alert__icon">
                <Icon name="alert" size={14} />
              </span>
              <div>
                <strong>This is the only time the full key is shown.</strong> Copy it now — the server only keeps the
                masked form <code className="mono">{revealed.key.slice(0, 10)}…</code> and cannot display it again.
              </div>
            </div>
            <div className="secret">
              <span style={{ flex: 1 }}>{revealed.key}</span>
              <CopyButton value={revealed.key} />
              <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}

        <div className="row row--wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <TextField label="Name" value={name} onChange={setName} placeholder="laptop" id="key-name" />
          <NumberField label="Daily USD" value={daily} onChange={setDaily} nullable min={0} step={0.5} />
          <NumberField label="RPM" value={rpm} onChange={setRpm} nullable min={0} />
          <NumberField label="TPM" value={tpm} onChange={setTpm} nullable min={0} step={1000} />
          <Button variant="primary" icon="plus" onClick={() => void create()} loading={busy} disabled={!name.trim()}>
            Create key
          </Button>
        </div>

        {keys.initial ? (
          <Skeleton height={80} />
        ) : keys.error ? (
          <ErrorState error={keys.error} onRetry={keys.reload} compact />
        ) : rows.length === 0 ? (
          <EmptyState icon="key" title="No dashboard keys" text="The master key still works — create a scoped key per client instead of sharing it." />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th style={{ textAlign: 'right' }}>Daily</th>
                  <th style={{ textAlign: 'right' }}>RPM/TPM</th>
                  <th>Models</th>
                  <th>Last used</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k, i) => (
                  <tr key={`${k.name}-${i}`}>
                    <td data-label="Name" className="mono small" style={{ fontWeight: 600 }}>
                      {k.name}
                    </td>
                    <td data-label="Key" className="mono tiny muted">
                      {k.key_masked}
                    </td>
                    <td data-label="Daily" className="right nums small">
                      {usd(k.daily_usd)}
                    </td>
                    <td data-label="RPM/TPM" className="right nums small">
                      {k.rpm ?? '∞'} / {k.tpm ?? '∞'}
                    </td>
                    <td data-label="Models" className="tiny muted truncate">
                      {k.models_allow ? `allow ${k.models_allow.join(', ')}` : k.models_deny ? `deny ${k.models_deny.join(', ')}` : 'all'}
                    </td>
                    <td data-label="Last used" className="tiny muted">
                      {ago(k.last_used_ts)}
                    </td>
                    <td data-label="State" className="right">
                      <Badge tone={k.enabled ? 'ok' : 'muted'}>{k.enabled ? 'enabled' : 'disabled'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Danger zone                                                         */
/* ------------------------------------------------------------------ */

function DangerZone(): ReactElement {
  const toast = useToast()
  const askConfirm = useConfirm()
  const [busy, setBusy] = useState<'cache' | 'logs' | null>(null)

  const run = async (what: 'cache' | 'logs'): Promise<void> => {
    const isCache = what === 'cache'
    const ok = await askConfirm({
      title: isCache ? 'Clear the response cache?' : 'Delete every log entry?',
      text: isCache
        ? 'All cached completions are dropped. The next identical request will hit the upstream again.'
        : 'The request log, usage history derived from it and the audit trail are erased. This cannot be undone.',
      confirmLabel: isCache ? 'Clear cache' : 'Delete all logs',
      danger: !isCache,
    })
    if (!ok) return
    setBusy(what)
    try {
      if (isCache) {
        const res = await api.clearCache()
        toast.success(`Cleared ${res.cleared} entries`)
      } else {
        const res = await api.clearLogs()
        toast.success(`Deleted ${num(res.deleted)} log entries`)
      }
    } catch (e) {
      toast.error('Operation failed', errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const probe = async (): Promise<void> => {
    try {
      await api.probe()
      toast.success('Active probe sweep triggered')
    } catch (e) {
      toast.error('Probe failed', errorMessage(e))
    }
  }

  return (
    <Card
      className="danger-zone"
      title="Danger zone"
      hint="irreversible operations"
      actions={
        <Button size="sm" icon="zap" onClick={() => void probe()}>
          Run probe now
        </Button>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="row row--wrap" style={{ gap: 10, alignItems: 'center' }}>
          <div className="col" style={{ gap: 2, flex: '1 1 260px' }}>
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>Clear response cache</span>
            <span className="tiny muted">DELETE /admin/cache</span>
          </div>
          <Button icon="trash" onClick={() => void run('cache')} loading={busy === 'cache'}>
            Clear cache
          </Button>
        </div>
        <div className="divider" />
        <div className="row row--wrap" style={{ gap: 10, alignItems: 'center' }}>
          <div className="col" style={{ gap: 2, flex: '1 1 260px' }}>
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>Delete all logs</span>
            <span className="tiny muted">DELETE /admin/logs — removes the audit trail as well</span>
          </div>
          <Button variant="danger" icon="trash" onClick={() => void run('logs')} loading={busy === 'logs'}>
            Delete logs
          </Button>
        </div>
        <details>
          <summary className="tiny muted" style={{ cursor: 'pointer' }}>
            raw endpoints used by this console
          </summary>
          <pre className="code-block" style={{ marginTop: 8 }}>
            {json([
              'GET /health',
              'GET /admin/accounts · POST /admin/accounts',
              'PUT /admin/accounts/{name} · DELETE /admin/accounts/{name}',
              'POST /admin/accounts/{name}/test · POST /admin/accounts/{name}/reset',
              'GET /admin/routing · PUT /admin/routing',
              'GET /admin/aliases · PUT /admin/aliases/{alias} · DELETE /admin/aliases/{alias}',
              'GET /admin/budget · PUT /admin/budget',
              'GET /admin/usage?range= · GET /admin/logs · GET /admin/logs/stream · DELETE /admin/logs',
              'GET /admin/keys · POST /admin/keys',
              'GET /admin/config · PUT /admin/config',
              'GET /admin/locations · GET /admin/cache · DELETE /admin/cache',
              'POST /admin/health-check · POST /admin/probe',
              'GET /admin/export.csv · GET /admin/export.json',
              'GET /v1/models · POST /v1/chat/completions',
            ]).trim()}
          </pre>
        </details>
      </div>
    </Card>
  )
}