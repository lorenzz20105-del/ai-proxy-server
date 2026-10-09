import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Badge, Button, Card, IconButton, PageHeader, Switch } from '../components/ui/Primitives.tsx'
import { NumberField, SelectField, TextField } from '../components/ui/Fields.tsx'
import { AsyncGate, EmptyState, ErrorState, Skeleton } from '../components/ui/States.tsx'
import { Icon } from '../components/ui/Icon.tsx'
import { useConfirm, useToast } from '../components/ui/Overlays.tsx'
import { api, chatCompletion, errorMessage } from '../lib/api.ts'
import type {
  AliasEntry,
  ModelList,
  ModelMatching,
  RoutingCache,
  RoutingCircuitBreaker,
  RoutingConfig,
  RoutingRetry,
  RoutingSessionAffinity,
  RoutingStrategy,
} from '../lib/types.ts'

/** Exactly the writable subset of GET /admin/routing. */
interface DraftConfig {
  strategy: RoutingStrategy
  model_matching: ModelMatching
  retry: RoutingRetry
  circuit_breaker: RoutingCircuitBreaker
  session_affinity: RoutingSessionAffinity
  cache: RoutingCache
}
import { useAsync } from '../lib/hooks.ts'
import { ms } from '../lib/format.ts'

const STRATEGY_DOC: Record<string, { title: string; when: string }> = {
  round_robin: {
    title: 'Round robin',
    when: 'Even, predictable distribution across equal accounts. Default when all accounts cost the same.',
  },
  failover: {
    title: 'Failover',
    when: 'Send everything to the first healthy account and only fail over on error. Best for paid primary + cheap backup.',
  },
  weighted: {
    title: 'Weighted',
    when: 'Split traffic by the per-account weight. Use when one account deserves a larger share.',
  },
  random: {
    title: 'Random',
    when: 'Uniform random pick — good for spreading bursty client traffic without ordering effects.',
  },
  least_latency: {
    title: 'Least latency',
    when: 'Always pick the account with the lowest rolling average latency. Optimises perceived speed.',
  },
  least_cost: {
    title: 'Least cost',
    when: 'Pick the cheapest account that can serve the model. Optimises spend; multiply by cost_multiplier.',
  },
  least_requests: {
    title: 'Least requests',
    when: 'Balance by in-flight/handled request count — useful for accounts with hard concurrency limits.',
  },
  priority: {
    title: 'Priority',
    when: 'Strict tiers by the account priority field (lower number wins). Deterministic ordering.',
  },
}

export function Routing(): ReactElement {
  const toast = useToast()
  const askConfirm = useConfirm()

  const routing = useAsync<RoutingConfig>((signal) => api.routing(signal), [])
  const aliases = useAsync<{ aliases: Record<string, AliasEntry> }>((signal) => api.aliases(signal), [])
  const models = useAsync<ModelList>((signal) => api.models(signal), [])

  const [draft, setDraft] = useState<DraftConfig | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!routing.data) return
    setDraft({
      strategy: routing.data.strategy,
      model_matching: routing.data.model_matching,
      retry: routing.data.retry,
      circuit_breaker: routing.data.circuit_breaker,
      session_affinity: routing.data.session_affinity,
      cache: routing.data.cache,
    })
  }, [routing.data])

  const original = useMemo<DraftConfig | null>(() => {
    if (!routing.data) return null
    return {
      strategy: routing.data.strategy,
      model_matching: routing.data.model_matching,
      retry: routing.data.retry,
      circuit_breaker: routing.data.circuit_breaker,
      session_affinity: routing.data.session_affinity,
      cache: routing.data.cache,
    }
  }, [routing.data])

  const dirty = Boolean(draft && original && JSON.stringify(draft) !== JSON.stringify(original))
  const set = <K extends keyof DraftConfig>(key: K, value: DraftConfig[K]): void =>
    setDraft((d) => (d ? { ...d, [key]: value } : d))

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      await api.updateRouting(draft satisfies DraftConfig)
      toast.success('Routing configuration saved')
      routing.reload()
    } catch (e) {
      toast.error('Save failed', errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const reset = async (): Promise<void> => {
    const ok = await askConfirm({ title: 'Discard changes?', text: 'Revert the form to the values last stored by the proxy.', confirmLabel: 'Discard' })
    if (ok) {
      setDraft(original)
      toast.info('Reverted to stored configuration')
    }
  }

  const strategies = routing.data?.strategies ?? Object.keys(STRATEGY_DOC)

  return (
    <div className="page">
      <PageHeader
        title="Routing"
        subtitle="Selection strategy, retry policy, circuit breakers, session affinity and response cache"
        actions={
          <>
            {dirty ? <Badge tone="warn">unsaved changes</Badge> : null}
            <Button icon="refresh" onClick={reset} disabled={!dirty || saving}>
              Reset
            </Button>
            <Button variant="primary" icon="save" onClick={() => void save()} disabled={!dirty} loading={saving}>
              Save
            </Button>
          </>
        }
      />

      <AsyncGate
        state={routing}
        skeleton={
          <div className="col" style={{ gap: 14 }}>
            <Skeleton height={120} radius={10} />
            <div className="grid grid--2">
              <Skeleton height={220} radius={10} />
              <Skeleton height={220} radius={10} />
            </div>
          </div>
        }
      >
        {(data) =>
          draft ? (
            <>
              <Card
                title="Strategy"
                hint={`PUT /admin/routing · current: ${data.strategy}`}
                actions={
                  <SelectField
                    value={String(draft.strategy ?? data.strategy)}
                    onChange={(v) => set('strategy', v as RoutingStrategy)}
                    options={strategies.map((s) => ({ value: s, label: STRATEGY_DOC[s]?.title ?? s }))}
                  />
                }
              >
                <div className="grid grid--4" style={{ gap: 8 }}>
                  {strategies.map((s) => {
                    const active = draft.strategy === s
                    const doc = STRATEGY_DOC[s] ?? { title: s, when: 'Custom strategy reported by the proxy.' }
                    return (
                      <button
                        key={s}
                        type="button"
                        className={`strategy-pick${active ? ' is-active' : ''}`}
                        aria-pressed={active}
                        onClick={() => set('strategy', s)}
                      >
                        <span className="row row--between" style={{ width: '100%' }}>
                          <span style={{ fontWeight: 620, fontSize: 12.5 }}>{doc.title}</span>
                          <code className="tiny faint">{s}</code>
                        </span>
                        <span className="tiny muted" style={{ textAlign: 'left', lineHeight: 1.45 }}>
                          {doc.when}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </Card>

              <div className="grid grid--2">
                <Card title="Retry & backoff" hint="retry.max_attempts across accounts">
                  <div className="col" style={{ gap: 12 }}>
                    <div className="grid grid--2">
                      <NumberField
                        label="Max attempts"
                        value={draft.retry?.max_attempts ?? null}
                        onChange={(v) => set('retry', { ...draft.retry, max_attempts: v ?? 1 })}
                        min={1}
                        max={20}
                      />
                      <NumberField
                        label="Backoff (s)"
                        value={draft.retry?.backoff_seconds ?? null}
                        onChange={(v) => set('retry', { ...draft.retry, backoff_seconds: v ?? 0 })}
                        min={0}
                        step={0.05}
                      />
                    </div>
                    <div className="grid grid--2">
                      <NumberField
                        label="Max backoff (s)"
                        value={draft.retry?.max_backoff_seconds ?? null}
                        onChange={(v) => set('retry', { ...draft.retry, max_backoff_seconds: v ?? 0 })}
                        min={0}
                        step={0.5}
                      />
                      <Switch
                        checked={Boolean(draft.retry?.jitter)}
                        onChange={(v) => set('retry', { ...draft.retry, jitter: v })}
                        label="Jitter backoff"
                      />
                    </div>
                    <TextField
                      label="Retry status codes"
                      mono
                      value={(draft.retry?.retry_status_codes ?? []).join(', ')}
                      onChange={(v) =>
                        set('retry', {
                          ...draft.retry,
                          retry_status_codes: v
                            .split(',')
                            .map((s) => Number(s.trim()))
                            .filter((n) => Number.isFinite(n)),
                        })
                      }
                      hint="comma separated HTTP statuses that trigger another account"
                    />
                  </div>
                </Card>

                <Card title="Circuit breaker" hint="per-account failure isolation">
                  <div className="col" style={{ gap: 12 }}>
                    <div className="grid grid--2">
                      <NumberField
                        label="Failure threshold"
                        value={draft.circuit_breaker?.failure_threshold ?? null}
                        onChange={(v) => set('circuit_breaker', { ...draft.circuit_breaker, failure_threshold: v ?? 1 })}
                        min={1}
                      />
                      <NumberField
                        label="Success threshold"
                        value={draft.circuit_breaker?.success_threshold ?? null}
                        onChange={(v) => set('circuit_breaker', { ...draft.circuit_breaker, success_threshold: v ?? 1 })}
                        min={1}
                      />
                    </div>
                    <div className="grid grid--2">
                      <NumberField
                        label="Cooldown (s)"
                        value={draft.circuit_breaker?.cooldown_seconds ?? null}
                        onChange={(v) => set('circuit_breaker', { ...draft.circuit_breaker, cooldown_seconds: v ?? 1 })}
                        min={1}
                        step={5}
                      />
                      <NumberField
                        label="Half-open concurrency"
                        value={draft.circuit_breaker?.half_open_max_concurrency ?? null}
                        onChange={(v) => set('circuit_breaker', { ...draft.circuit_breaker, half_open_max_concurrency: v ?? 1 })}
                        min={1}
                      />
                    </div>
                  </div>
                </Card>
              </div>

              <div className="grid grid--2">
                <Card title="Session affinity" hint="pins a conversation to one account">
                  <div className="col" style={{ gap: 12 }}>
                    <Switch
                      checked={Boolean(draft.session_affinity?.enabled)}
                      onChange={(v) => set('session_affinity', { ...draft.session_affinity, enabled: v })}
                      label="Enable session affinity"
                    />
                    <div className="grid grid--2">
                      <NumberField
                        label="TTL (s)"
                        value={draft.session_affinity?.ttl_seconds ?? null}
                        onChange={(v) => set('session_affinity', { ...draft.session_affinity, ttl_seconds: v ?? 0 })}
                        min={0}
                        step={60}
                      />
                      <TextField
                        label="Header"
                        mono
                        value={draft.session_affinity?.header ?? ''}
                        onChange={(v) => set('session_affinity', { ...draft.session_affinity, header: v })}
                        placeholder="x-session-id"
                      />
                    </div>
                    <p className="tiny faint">
                      The playground sends <code className="mono">x-session-id</code> so multi-turn chats hit the same account
                      and stay cache-friendly.
                    </p>
                  </div>
                </Card>

                <Card title="Response cache" hint="chat completions only">
                  <div className="col" style={{ gap: 12 }}>
                    <Switch
                      checked={Boolean(draft.cache?.enabled)}
                      onChange={(v) => set('cache', { ...draft.cache, enabled: v })}
                      label="Enable response cache"
                    />
                    <div className="grid grid--2">
                      <NumberField
                        label="TTL (s)"
                        value={draft.cache?.ttl_seconds ?? null}
                        onChange={(v) => set('cache', { ...draft.cache, ttl_seconds: v ?? 0 })}
                        min={0}
                        step={30}
                      />
                      <NumberField
                        label="Max entries"
                        value={draft.cache?.max_entries ?? null}
                        onChange={(v) => set('cache', { ...draft.cache, max_entries: v ?? 0 })}
                        min={0}
                        step={100}
                      />
                    </div>
                    <Switch
                      checked={Boolean(draft.cache?.deterministic_only)}
                      onChange={(v) => set('cache', { ...draft.cache, deterministic_only: v })}
                      label="Only cache deterministic requests (temp = 0, no tools)"
                    />
                    <Switch
                      checked={Boolean(draft.cache?.forward_client_caching_headers)}
                      onChange={(v) => set('cache', { ...draft.cache, forward_client_caching_headers: v })}
                      label="Forward client caching headers"
                    />
                  </div>
                </Card>
              </div>

              <Card title="Model matching" hint="how requested model ids resolve to account models">
                <div className="segmented" role="group" aria-label="Model matching">
                  {['exact', 'prefix'].map((m) => (
                    <button key={m} type="button" aria-pressed={draft.model_matching === m} onClick={() => set('model_matching', m)}>
                      {m}
                    </button>
                  ))}
                </div>
                <p className="tiny muted" style={{ marginTop: 8 }}>
                  {draft.model_matching === 'exact'
                    ? 'Exact — gpt-4o only matches the account model "gpt-4o".'
                    : 'Prefix — gpt-4o-2024-05-13 matches "gpt-4o".'}
                </p>
              </Card>
            </>
          ) : null
        }
      </AsyncGate>

      {routing.error && !routing.data ? <ErrorState error={routing.error} onRetry={routing.reload} /> : null}

      <AliasEditor aliasesState={aliases} modelsState={models} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Alias / fallback chains                                             */
/* ------------------------------------------------------------------ */

type Probe = { state: 'idle' | 'running' | 'ok' | 'fail'; account?: string; latencyMs?: number; detail?: string }

function AliasEditor({
  aliasesState,
  modelsState,
}: {
  aliasesState: ReturnType<typeof useAsync<{ aliases: Record<string, AliasEntry> }>>
  modelsState: ReturnType<typeof useAsync<ModelList>>
}): ReactElement {
  const toast = useToast()
  const askConfirm = useConfirm()
  const [newAlias, setNewAlias] = useState('')
  const [newTarget, setNewTarget] = useState('')
  const [edits, setEdits] = useState<Record<string, string[]>>({})
  const [probes, setProbes] = useState<Record<string, Probe>>({})

  const stored = aliasesState.data?.aliases ?? {}
  const entries = useMemo(
    () => Object.entries(stored).sort(([a], [b]) => a.localeCompare(b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aliasesState.data?.aliases],
  )
  const targetsOf = (name: string): string[] => edits[name] ?? stored[name]?.targets ?? []
  const isDirtyFor = (name: string): boolean => edits[name] !== undefined && JSON.stringify(edits[name]) !== JSON.stringify(stored[name]?.targets)

  const modelIds = useMemo(() => (modelsState.data?.data ?? []).map((m) => m.id), [modelsState.data])

  const setTargets = (name: string, targets: string[]): void => setEdits((e) => ({ ...e, [name]: targets }))

  const move = (name: string, index: number, delta: number): void => {
    const list = [...targetsOf(name)]
    const next = index + delta
    if (next < 0 || next >= list.length) return
    const tmp = list[index]
    list[index] = list[next]
    list[next] = tmp
    setTargets(name, list)
  }

  const saveAlias = async (name: string): Promise<void> => {
    try {
      await api.putAlias(name, targetsOf(name))
      toast.success(`Alias “${name}” saved`)
      setEdits((e) => {
        const next = { ...e }
        delete next[name]
        return next
      })
      aliasesState.reload()
    } catch (e) {
      toast.error('Could not save alias', errorMessage(e))
    }
  }

  const createAlias = async (): Promise<void> => {
    const name = newAlias.trim()
    if (!name) return
    try {
      await api.putAlias(name, newTarget.trim() ? [newTarget.trim()] : [])
      toast.success(`Alias “${name}” created`)
      setNewAlias('')
      setNewTarget('')
      aliasesState.reload()
    } catch (e) {
      toast.error('Could not create alias', errorMessage(e))
    }
  }

  const removeAlias = async (name: string): Promise<void> => {
    const ok = await askConfirm({
      title: `Delete alias “${name}”?`,
      text: 'Requests for this model id will stop resolving through the fallback chain.',
      confirmLabel: 'Delete alias',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteAlias(name)
      toast.success(`Alias “${name}” deleted`)
      aliasesState.reload()
    } catch (e) {
      toast.error('Delete failed', errorMessage(e))
    }
  }

  const tryModel = async (name: string): Promise<void> => {
    setProbes((p) => ({ ...p, [name]: { state: 'running' } }))
    try {
      const res = await chatCompletion({
        body: {
          model: name,
          messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
          max_tokens: 16,
          stream: false,
        },
      })
      setProbes((p) => ({
        ...p,
        [name]: {
          state: 'ok',
          account: res.meta.account ?? undefined,
          latencyMs: res.meta.latencyMs ?? res.latencyMs,
          detail: res.content.slice(0, 60),
        },
      }))
      toast.success(`${name} → ${res.meta.account ?? 'unknown account'}`, `${ms(res.meta.latencyMs ?? res.latencyMs)}${res.meta.attempts ? ` · ${res.meta.attempts} attempt(s)` : ''}`)
    } catch (e) {
      setProbes((p) => ({ ...p, [name]: { state: 'fail', detail: errorMessage(e) } }))
      toast.error(`${name} probe failed`, errorMessage(e))
    }
  }

  return (
    <Card
      title="Model aliases & fallback chains"
      hint="PUT /admin/aliases/{alias} — targets are tried in order"
      actions={
        <Button size="sm" icon="refresh" onClick={aliasesState.reload}>
          Refresh
        </Button>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="row row--wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <TextField label="New alias" value={newAlias} onChange={setNewAlias} placeholder="fast" id="new-alias" />
          <TextField
            label="First target"
            mono
            value={newTarget}
            onChange={setNewTarget}
            placeholder="gpt-4o-mini"
            id="new-target"
            optional
          />
          <Button variant="primary" icon="plus" onClick={() => void createAlias()}>
            Add alias
          </Button>
          <span className="spacer" />
          <span className="tiny faint">
            {modelsState.data ? `${modelsState.data.data.length} models exposed by /v1/models` : 'loading /v1/models…'}
          </span>
        </div>

        {aliasesState.initial ? (
          <Skeleton height={80} radius={8} />
        ) : aliasesState.error ? (
          <ErrorState error={aliasesState.error} onRetry={aliasesState.reload} compact />
        ) : entries.length === 0 ? (
          <EmptyState
            icon="shuffle"
            title="No aliases configured"
            text="An alias maps a virtual model name to an ordered fallback chain — the router tries each target until one succeeds."
          />
        ) : (
          entries.map(([name, meta]) => {
            const targets = targetsOf(name)
            const probe = probes[name]
            return (
              <div key={name} className="alias-card">
                <div className="row row--wrap" style={{ gap: 8 }}>
                  <code className="alias-name">{name}</code>
                  {meta.strategy ? <Badge tone="muted">{meta.strategy}</Badge> : null}
                  <span className="tiny faint">{targets.length} target{targets.length === 1 ? '' : 's'}</span>
                  <span className="spacer" />
                  {isDirtyFor(name) ? <Badge tone="warn">unsaved</Badge> : null}
                  <Button size="sm" icon="play" onClick={() => void tryModel(name)} loading={probe?.state === 'running'}>
                    Try this model
                  </Button>
                  <Button size="sm" variant="primary" icon="save" disabled={!isDirtyFor(name)} onClick={() => void saveAlias(name)}>
                    Save
                  </Button>
                  <IconButton label={`Delete alias ${name}`} name="trash" tone="danger" onClick={() => void removeAlias(name)} />
                </div>

                <div className="alias-chain">
                  {targets.map((t, i) => (
                    <div className="chain-item" key={`${t}-${i}`}>
                      <span className="chain-item__idx">{i + 1}</span>
                      <span className="chain-item__grip">
                        <Icon name="grip" size={13} />
                      </span>
                      <span className="chain-item__name" title={t}>
                        {t}
                      </span>
                      <IconButton label={`Move ${t} up`} name="chevronUp" size={13} onClick={() => move(name, i, -1)} disabled={i === 0} />
                      <IconButton
                        label={`Move ${t} down`}
                        name="chevronDown"
                        size={13}
                        onClick={() => move(name, i, 1)}
                        disabled={i === targets.length - 1}
                      />
                      <IconButton
                        label={`Remove ${t}`}
                        name="x"
                        size={13}
                        tone="danger"
                        onClick={() => setTargets(name, targets.filter((_, idx) => idx !== i))}
                      />
                    </div>
                  ))}
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      className="input input--mono"
                      list="model-ids"
                      placeholder="add target…"
                      aria-label={`Add target to ${name}`}
                      onKeyDown={(e) => {
                        const v = (e.target as HTMLInputElement).value.trim()
                        if (e.key === 'Enter' && v) {
                          setTargets(name, [...targets, v])
                          ;(e.target as HTMLInputElement).value = ''
                        }
                      }}
                    />
                    <datalist id="model-ids">
                      {modelIds.slice(0, 200).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </div>
                </div>

                {probe && probe.state !== 'running' ? (
                  <div className={`alert ${probe.state === 'ok' ? 'alert--info' : 'alert--danger'}`}>
                    <span className="alert__icon">
                      <Icon name={probe.state === 'ok' ? 'checkCircle' : 'xCircle'} size={14} />
                    </span>
                    <div className="col" style={{ gap: 2 }}>
                      <span>
                        {probe.state === 'ok' ? (
                          <>
                            served by <code className="mono">{probe.account ?? 'unknown'}</code> in {ms(probe.latencyMs ?? null)}
                          </>
                        ) : (
                          probe.detail
                        )}
                      </span>
                      {probe.state === 'ok' && probe.detail ? <span className="tiny muted truncate">“{probe.detail}”</span> : null}
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </Card>
  )
}
