import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Badge, Button, Card, IconButton, PageHeader, Switch } from '../components/ui/Primitives.tsx'
import { NumberField, SelectField, SliderField, TextAreaField } from '../components/ui/Fields.tsx'
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States.tsx'
import { Icon } from '../components/ui/Icon.tsx'
import { useToast } from '../components/ui/Overlays.tsx'
import { api, chatCompletion, errorMessage, getApiKey, isApiError } from '../lib/api.ts'
import type { ChatMessage, ChatRequestBody, ChatUsage, ModelList, ProxyResponseMeta } from '../lib/types.ts'
import { useAsync, useAutoScroll } from '../lib/hooks.ts'
import { compact, json, ms, num, usd } from '../lib/format.ts'

interface TurnMeta {
  meta: ProxyResponseMeta
  ttftMs: number | null
  latencyMs: number
  usage: ChatUsage | null
  costUsd: number | null
  finish: string | null
  cached: boolean
}

interface Turn {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  streaming?: boolean
  error?: string
  requestBody?: unknown
  raw?: string
  result?: TurnMeta
}

let seq = 0
const nextId = (): string => `turn-${++seq}`

const SUGGESTIONS = [
  'Explain circuit breakers in two sentences.',
  'Write a bash one-liner that tails the 5xx lines of a log.',
  'Return JSON: {"ok":true,"items":[1,2,3]}',
]

export function Playground(): ReactElement {
  const toast = useToast()
  const models = useAsync<ModelList>((signal) => api.models(signal), [])

  const [model, setModel] = useState('')
  const [system, setSystem] = useState('You are a helpful assistant.')
  const [stream, setStream] = useState(true)
  const [jsonMode, setJsonMode] = useState(false)
  const [temperature, setTemperature] = useState<number | null>(0.7)
  const [topP, setTopP] = useState<number | null>(1)
  const [maxTokens, setMaxTokens] = useState<number | null>(512)
  const [seed, setSeed] = useState<number | null>(null)
  const [pinSession, setPinSession] = useState(true)
  const [noCache, setNoCache] = useState(false)

  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [inspector, setInspector] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const sessionRef = useRef<string>(`dash-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`)

  const modelIds = useMemo(() => (models.data?.data ?? []).map((m) => m.id), [models.data])
  useEffect(() => {
    if (!model && modelIds.length) setModel(modelIds[0])
  }, [modelIds, model])

  const scrollRef = useAutoScroll<HTMLDivElement>([turns], busy)

  const modelInfo = useMemo(() => (models.data?.data ?? []).find((m) => m.id === model), [models.data, model])

  /* ---------------------------------------------------------------- */
  /* totals                                                            */
  /* ---------------------------------------------------------------- */

  const totals = useMemo(() => {
    let tokensIn = 0
    let tokensOut = 0
    let cost = 0
    let costKnown = false
    let errors = 0
    let ttftSum = 0
    let ttftCount = 0
    let latencySum = 0
    for (const t of turns) {
      if (t.error) errors += 1
      if (!t.result) continue
      tokensIn += t.result.usage?.prompt_tokens ?? 0
      tokensOut += t.result.usage?.completion_tokens ?? 0
      if (typeof t.result.costUsd === 'number') {
        cost += t.result.costUsd
        costKnown = true
      }
      if (typeof t.result.ttftMs === 'number') {
        ttftSum += t.result.ttftMs
        ttftCount += 1
      }
      latencySum += t.result.latencyMs
    }
    const ok = turns.filter((t) => t.role === 'assistant' && t.result).length
    return {
      tokensIn,
      tokensOut,
      cost,
      costKnown,
      errors,
      turns: ok,
      avgTtft: ttftCount ? ttftSum / ttftCount : null,
      avgLatency: ok ? latencySum / ok : null,
    }
  }, [turns])

  /* ---------------------------------------------------------------- */
  /* send                                                              */
  /* ---------------------------------------------------------------- */

  const send = useCallback(
    async (text: string) => {
      const content = text.trim()
      if (!content || busy) return

      const history: ChatMessage[] = []
      if (system.trim()) history.push({ role: 'system', content: system.trim() })
      for (const t of turns) {
        if (t.error || !t.content) continue
        history.push({ role: t.role, content: t.content })
      }
      history.push({ role: 'user', content })

      const body: Record<string, unknown> = {
        model,
        messages: history,
        stream,
      }
      if (stream) body.stream_options = { include_usage: true }
      if (temperature !== null) body.temperature = temperature
      if (topP !== null && topP !== 1) body.top_p = topP
      if (maxTokens !== null) body.max_tokens = maxTokens
      if (seed !== null) body.seed = seed
      if (jsonMode) body.response_format = { type: 'json_object' }

      const userTurn: Turn = { id: nextId(), role: 'user', content, requestBody: body }
      const replyId = nextId()
      const reply: Turn = { id: replyId, role: 'assistant', content: '', streaming: true, requestBody: body }

      setTurns((prev) => [...prev, userTurn, reply])
      setInput('')
      setBusy(true)
      setInspector(replyId)

      const ac = new AbortController()
      abortRef.current = ac

      try {
        const res = await chatCompletion({
          body: body as ChatRequestBody,
          signal: ac.signal,
          sessionId: pinSession ? sessionRef.current : undefined,
          noCache: noCache || undefined,
          onChunk: (chunk) => {
            const piece = chunk.choices?.[0]?.delta?.content
            setTurns((prev) =>
              prev.map((t) =>
                t.id === replyId
                  ? { ...t, content: t.content + (typeof piece === 'string' ? piece : ''), raw: undefined }
                  : t,
              ),
            )
          },
        })

        const usage = res.usage ?? null
        const cost = await lookupCost(res.meta.requestId)

        setTurns((prev) =>
          prev.map((t) =>
            t.id === replyId
              ? {
                  ...t,
                  streaming: false,
                  content: res.content || t.content,
                  raw: res.raw,
                  result: {
                    meta: res.meta,
                    ttftMs: res.ttftMs,
                    latencyMs: res.latencyMs,
                    usage,
                    costUsd: cost,
                    finish: res.completion?.choices?.[0]?.finish_reason ?? 'stop',
                    cached: res.meta.cache === 'HIT',
                  },
                }
              : t,
          ),
        )
      } catch (e) {
        if (isApiError(e) && e.isAuth) {
          toast.error('Rejected by the proxy', e.message)
        }
        setTurns((prev) =>
          prev.map((t) =>
            t.id === replyId ? { ...t, streaming: false, error: errorMessage(e), raw: t.raw } : t,
          ),
        )
      } finally {
        setBusy(false)
        abortRef.current = null
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, turns, model, system, stream, temperature, topP, maxTokens, seed, jsonMode, pinSession, noCache],
  )

  /** The proxy records cost per request; look it up so the console shows real spend. */
  const lookupCost = async (requestId: string | null): Promise<number | null> => {
    if (!requestId) return null
    try {
      const res = await api.logs({ limit: 25 })
      const hit = res.logs?.find((l) => l.id === requestId)
      return typeof hit?.cost_usd === 'number' ? hit.cost_usd : null
    } catch {
      return null
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
    setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)))
    setBusy(false)
  }

  const clear = (): void => {
    stop()
    setTurns([])
    setInspector(null)
    toast.info('Conversation cleared')
  }

  const inspected = turns.find((t) => t.id === inspector) ?? turns[turns.length - 1] ?? null

  return (
    <div className="page">
      <PageHeader
        title="Playground"
        subtitle="Send real chat completions through the proxy and see exactly which account answered"
        actions={
          <>
            <Badge tone={pinSession ? 'accent' : 'muted'}>
              {pinSession ? `session ${sessionRef.current.slice(0, 12)}…` : 'no session pin'}
            </Badge>
            <Button icon="refresh" onClick={models.reload} loading={models.loading}>
              Models
            </Button>
            <Button icon="trash" onClick={clear} disabled={turns.length === 0}>
              Clear
            </Button>
          </>
        }
      />

      {models.error && !models.data ? <ErrorState error={models.error} onRetry={models.reload} title="/v1/models unavailable" /> : null}

      <div className="grid grid--split">
        <div className="col" style={{ gap: 14, minWidth: 0 }}>
          <Card
            title="Conversation"
            hint={modelInfo?.proxy?.alias ? 'alias' : modelInfo?.proxy?.accounts?.length ? `${modelInfo.proxy.accounts.length} accounts` : undefined}
            actions={
              <>
                <Switch checked={stream} onChange={setStream} label="stream" ariaLabel="Stream tokens" />
                <Switch checked={noCache} onChange={setNoCache} label="no-cache" ariaLabel="Bypass response cache" />
              </>
            }
            flush
          >
            <div className="chat" style={{ padding: 14, minHeight: 320, maxHeight: '58vh', overflowY: 'auto' }} ref={scrollRef}>
              {turns.length === 0 ? (
                <EmptyState
                  icon="play"
                  title="Send your first request"
                  text="The request goes through POST /v1/chat/completions exactly as a client would send it — streaming included."
                  action={
                    <div className="row row--wrap" style={{ gap: 6, justifyContent: 'center', marginTop: 4 }}>
                      {SUGGESTIONS.map((s) => (
                        <button key={s} type="button" className="chip" onClick={() => setInput(s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  }
                />
              ) : (
                turns.map((t) => <Bubble key={t.id} turn={t} onInspect={() => setInspector(t.id)} active={inspector === t.id} />)
              )}
            </div>

            <div style={{ padding: 12, borderTop: '1px solid var(--line-soft)' }}>
              <div className="composer">
                <textarea
                  className="textarea"
                  rows={2}
                  value={input}
                  placeholder="Type a message…  (Enter to send · Shift+Enter for a new line)"
                  aria-label="Message"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send(input)
                    }
                  }}
                />
                <div className="row" style={{ gap: 8 }}>
                  <span className="tiny faint truncate">
                    {model ? (
                      <>
                        → <code className="mono">{model}</code>
                        {jsonMode ? ' · json_object' : ''}
                        {stream ? ' · stream' : ''}
                      </>
                    ) : (
                      'select a model'
                    )}
                  </span>
                  <span className="spacer" />
                  {busy ? (
                    <Button variant="danger" icon="stop" onClick={stop}>
                      Stop
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    icon="arrowRight"
                    disabled={!input.trim() || !model || busy}
                    onClick={() => void send(input)}
                  >
                    Send
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          <SessionTotals totals={totals} />
        </div>

        <div className="col" style={{ gap: 14, minWidth: 0 }}>
          <Card title="Parameters">
            <div className="col" style={{ gap: 12 }}>
              {models.initial ? (
                <Skeleton height={30} />
              ) : (
                <SelectField
                  label="Model"
                  value={model}
                  onChange={setModel}
                  options={modelIds.map((id) => ({ value: id, label: id }))}
                  placeholder={modelIds.length ? undefined : 'no models exposed'}
                  hint={
                    modelInfo?.proxy?.alias
                      ? `alias → ${(modelInfo.proxy.accounts ?? []).join(' → ') || 'fallback chain'}`
                      : modelInfo?.proxy?.accounts?.length
                        ? `served by ${modelInfo.proxy.accounts.join(', ')}`
                        : modelInfo?.owned_by
                          ? `owned by ${modelInfo.owned_by}${modelInfo.proxy?.context_window ? ` · ${compact(modelInfo.proxy.context_window)} ctx` : ''}`
                          : undefined
                  }
                />
              )}

              <TextAreaField
                label="System prompt"
                value={system}
                onChange={setSystem}
                rows={2}
                placeholder="You are a helpful assistant."
                hint="Prepended to every request body."
              />

              <SliderField
                label="temperature"
                value={temperature}
                onChange={setTemperature}
                min={0}
                max={2}
                step={0.05}
                format={(v) => v.toFixed(2)}
                hint="Set 0 for deterministic (cacheable) requests"
              />
              <SliderField
                label="top_p"
                value={topP}
                onChange={setTopP}
                min={0}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
              />

              <div className="grid grid--2">
                <NumberField label="max_tokens" value={maxTokens} onChange={setMaxTokens} nullable min={1} max={128000} step={64} />
                <NumberField label="seed" value={seed} onChange={setSeed} nullable min={0} step={1} hint="null = unset" />
              </div>

              <div className="col" style={{ gap: 6 }}>
                <Switch
                  checked={jsonMode}
                  onChange={setJsonMode}
                  label='response_format: {"type":"json_object"}'
                  ariaLabel="JSON response format"
                />
                <Switch
                  checked={pinSession}
                  onChange={setPinSession}
                  label="Send x-session-id (affinity + cache hits)"
                  ariaLabel="Pin session"
                />
              </div>
            </div>
          </Card>

          <Card
            title="Request inspector"
            hint={inspected ? `${inspected.role} turn` : 'nothing selected'}
            actions={
              inspected ? (
                <IconButton
                  label="Copy request body"
                  name="copy"
                  onClick={() => void navigator.clipboard?.writeText(json(inspected.requestBody))}
                />
              ) : null
            }
          >
            {!inspected ? (
              <EmptyState icon="info" title="Send a request" text="The exact JSON body and raw response appear here." />
            ) : (
              <div className="col" style={{ gap: 10 }}>
                <div className="row row--wrap" style={{ gap: 6 }}>
                  <Badge tone="muted">request</Badge>
                  <span className="tiny muted">POST /v1/chat/completions</span>
                </div>
                <pre className="code-block">{json(inspected.requestBody)}</pre>

                {inspected.result ? (
                  <div className="col" style={{ gap: 6 }}>
                    <div className="section-title">response headers</div>
                    <div className="row row--wrap" style={{ gap: 6 }}>
                      <HeaderChip label="account" value={inspected.result.meta.account ?? '—'} tone="accent" />
                      <HeaderChip label="attempts" value={inspected.result.meta.attempts === null ? '—' : String(inspected.result.meta.attempts)} />
                      <HeaderChip label="latency" value={ms(inspected.result.meta.latencyMs)} />
                      <HeaderChip label="upstream" value={inspected.result.meta.upstreamStatus === null ? '—' : String(inspected.result.meta.upstreamStatus)} />
                      <HeaderChip
                        label="cache"
                        value={inspected.result.meta.cache ?? (inspected.result.cached ? 'HIT' : 'MISS')}
                        tone={inspected.result.cached ? 'ok' : undefined}
                      />
                      <HeaderChip label="request-id" value={inspected.result.meta.requestId ?? '—'} />
                    </div>
                  </div>
                ) : null}

                <div className="section-title">raw response</div>
                {inspected.raw ? (
                  <pre className="code-block">{inspected.raw}</pre>
                ) : (
                  <span className="tiny faint">
                    {inspected.streaming ? 'streaming…' : 'no body captured for this turn'}
                  </span>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function HeaderChip({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'accent' }): ReactElement {
  return (
    <span className="row" style={{ gap: 5, fontSize: 11 }}>
      <span className="faint mono">{label}</span>
      <Badge tone={tone ?? 'muted'}>{value}</Badge>
    </span>
  )
}

function SessionTotals({ totals }: { totals: { tokensIn: number; tokensOut: number; cost: number; costKnown: boolean; errors: number; turns: number; avgTtft: number | null; avgLatency: number | null } }): ReactElement {
  return (
    <Card title="Session totals" hint={`${totals.turns} assistant turn${totals.turns === 1 ? '' : 's'}`}>
      <div className="grid grid--4" style={{ gap: 10 }}>
        <Metric label="prompt tokens" value={compact(totals.tokensIn)} />
        <Metric label="completion tokens" value={compact(totals.tokensOut)} />
        <Metric
          label="cost"
          value={totals.costKnown ? usd(totals.cost, 4) : '—'}
          hint={totals.costKnown ? undefined : 'reported in /admin/logs'}
        />
        <Metric label="avg TTFT" value={ms(totals.avgTtft)} />
        <Metric label="avg latency" value={ms(totals.avgLatency)} />
        <Metric label="turns" value={num(totals.turns)} />
        <Metric label="errors" value={num(totals.errors)} tone={totals.errors ? 'danger' : undefined} />
        <Metric label="key" value={getApiKey() ? `${getApiKey().slice(0, 6)}…` : '—'} mono />
      </div>
    </Card>
  )
}

function Metric({ label, value, hint, tone, mono }: { label: string; value: string; hint?: string; tone?: 'danger'; mono?: boolean }): ReactElement {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ''}`} style={{ padding: '9px 11px' }}>
      <span className="kpi__label">{label}</span>
      <span className={`kpi__value${mono ? ' truncate' : ''}`} style={{ fontSize: 17 }}>
        {value}
      </span>
      {hint ? <span className="kpi__meta">{hint}</span> : null}
    </div>
  )
}

function Bubble({ turn, onInspect, active }: { turn: Turn; onInspect: () => void; active: boolean }): ReactElement {
  const r = turn.result
  return (
    <div className="col" style={{ gap: 3, alignSelf: turn.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '100%' }}>
      <div className={`bubble bubble--${turn.role}${turn.error ? ' bubble--error' : ''}`}>
        {turn.content || turn.streaming ? (
          <span className={turn.streaming ? 'caret' : undefined}>{turn.content || ' '}</span>
        ) : null}
        {!turn.content && !turn.streaming && !turn.error ? <span className="faint tiny">(empty response)</span> : null}
        {turn.error ? (
          <span className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
            <Icon name="alert" size={13} />
            <span className="mono tiny">{turn.error}</span>
          </span>
        ) : null}
      </div>

      {r || turn.error ? (
        <div className="row row--wrap bubble__meta" style={{ alignSelf: turn.role === 'user' ? 'flex-end' : 'flex-start' }}>
          {r?.meta.account ? (
            <span>
              account <strong style={{ color: 'var(--accent-2)' }}>{r.meta.account}</strong>
            </span>
          ) : null}
          {r?.meta.attempts ? <span>attempts {r.meta.attempts}</span> : null}
          <span>ttft {ms(r?.ttftMs ?? null)}</span>
          <span>total {ms(r?.latencyMs ?? null)}</span>
          {r?.usage ? (
            <span>
              {num(r.usage.prompt_tokens)}↓ {num(r.usage.completion_tokens)}↑
            </span>
          ) : null}
          {typeof r?.costUsd === 'number' ? <span>{usd(r.costUsd, 4)}</span> : null}
          {r?.cached ? <span className="badge badge--ok">CACHE HIT</span> : null}
          <button type="button" className="btn btn--sm btn--ghost" onClick={onInspect} aria-pressed={active}>
            {active ? 'inspecting' : 'inspect'}
          </button>
        </div>
      ) : null}
    </div>
  )
}