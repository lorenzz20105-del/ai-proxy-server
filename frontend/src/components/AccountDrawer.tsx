import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Drawer, useConfirm, useToast } from './ui/Overlays.tsx'
import { Alert, Button, Card, SectionTitle, Switch } from './ui/Primitives.tsx'
import { HeaderEditor, NumberField, SelectField, TagInput, TextField } from './ui/Fields.tsx'
import { api, errorMessage } from '../lib/api.ts'
import type { Account, AccountInput } from '../lib/types.ts'

const PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'google',
  'openai_compatible',
  'azure',
  'bedrock',
  'vertex',
  'groq',
  'together',
  'mistral',
  'deepseek',
  'xai',
  'ollama',
  'custom',
]

/** Local form state. Secrets live here only while the drawer is open. */
interface FormState {
  name: string
  provider_type: string
  base_url: string
  api_key: string
  models: string[]
  weight: number
  priority: number
  enabled: boolean
  models_exact: boolean
  rate_limit: { rpm: number | null; tpm: number | null; burst: number | null; enabled: boolean }
  budget: { daily_usd: number | null; monthly_usd: number | null }
  routing: { strategy: string; cost_multiplier: number | null }
  proxy: { enabled: boolean; url: string }
  location: string
  user_agent: string
  extra_headers: Record<string, string>
}

const BLANK: FormState = {
  name: '',
  provider_type: 'openai',
  base_url: '',
  api_key: '',
  models: [],
  weight: 1,
  priority: 10,
  enabled: true,
  models_exact: true,
  rate_limit: { rpm: null, tpm: null, burst: null, enabled: true },
  budget: { daily_usd: null, monthly_usd: null },
  routing: { strategy: '', cost_multiplier: 1 },
  proxy: { enabled: false, url: '' },
  location: '',
  user_agent: '',
  extra_headers: {},
}

function fromAccount(a: Account): FormState {
  return {
    name: a.name,
    provider_type: a.provider_type ?? 'openai',
    base_url: a.base_url ?? '',
    api_key: '',
    models: a.models ?? [],
    weight: a.weight ?? 1,
    priority: a.priority ?? 10,
    enabled: a.enabled ?? true,
    models_exact: a.models_exact ?? true,
    rate_limit: {
      rpm: a.rate_limit?.rpm ?? null,
      tpm: a.rate_limit?.tpm ?? null,
      burst: a.rate_limit?.burst ?? null,
      enabled: a.rate_limit?.enabled ?? true,
    },
    budget: { daily_usd: a.budget?.daily_usd ?? null, monthly_usd: a.budget?.monthly_usd ?? null },
    routing: { strategy: a.routing?.strategy ?? '', cost_multiplier: a.routing?.cost_multiplier ?? 1 },
    proxy: { enabled: a.proxy?.enabled ?? false, url: '' },
    location: a.location ?? '',
    user_agent: a.user_agent ?? '',
    extra_headers: a.extra_headers ?? {},
  }
}

function toPayload(form: FormState, original: Account | null): AccountInput {
  const payload: AccountInput = {
    name: form.name.trim(),
    provider_type: form.provider_type.trim() || 'openai',
    base_url: form.base_url.trim(),
    models: form.models,
    weight: form.weight,
    priority: form.priority,
    enabled: form.enabled,
    models_exact: form.models_exact,
    rate_limit: {
      rpm: form.rate_limit.rpm,
      tpm: form.rate_limit.tpm,
      burst: form.rate_limit.burst,
      enabled: form.rate_limit.enabled,
    },
    budget: { daily_usd: form.budget.daily_usd, monthly_usd: form.budget.monthly_usd },
    routing: { strategy: form.routing.strategy.trim() || null, cost_multiplier: form.routing.cost_multiplier },
    proxy: { enabled: form.proxy.enabled },
    location: form.location.trim() || null,
    user_agent: form.user_agent.trim() || null,
    extra_headers: form.extra_headers,
  }
  // Secrets are write-only. A blank field means "keep the stored value" on an
  // update — sending null would wipe it, because the real value is never read back.
  if (form.api_key.trim()) payload.api_key = form.api_key.trim()
  else if (!original) delete payload.api_key
  const proxyUrl = form.proxy.url.trim()
  if (proxyUrl) payload.proxy = { ...payload.proxy, url: proxyUrl }
  else if (!original) payload.proxy = { ...payload.proxy, url: null }
  return payload
}

export function AccountDrawer({
  open,
  account,
  onClose,
  onSaved,
}: {
  open: boolean
  /** null → create mode */
  account: Account | null
  onClose: () => void
  onSaved: (name: string) => void
}): ReactElement | null {
  const toast = useToast()
  const askConfirm = useConfirm()
  const [form, setForm] = useState<FormState>(BLANK)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(account ? fromAccount(account) : BLANK)
    setError(null)
  }, [open, account])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => setForm((f) => ({ ...f, [key]: value }))

  const nameTaken = useMemo(
    () => Boolean(account) && form.name.trim() !== account?.name,
    [account, form.name],
  )

  const submit = async (): Promise<void> => {
    if (!form.name.trim()) {
      setError('Account name is required.')
      return
    }
    if (nameTaken) {
      const ok = await askConfirm({
        title: 'Rename account?',
        text: (
          <>
            The account is currently called <code className="mono">{account?.name}</code> and will be renamed to{' '}
            <code className="mono">{form.name.trim()}</code>. Stats and circuit state follow the new name.
          </>
        ),
        confirmLabel: 'Rename',
      })
      if (!ok) return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = toPayload(form, account)
      if (account) await api.updateAccount(account.name, payload)
      else await api.createAccount(payload)
      toast.success(account ? `Account “${account.name}” updated` : `Account “${payload.name}” created`)
      onSaved(String(payload.name))
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      toast.error('Save failed', errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const preview = useMemo(() => JSON.stringify(toPayload(form, account), null, 2), [form, account])

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={account ? `Edit ${account.name}` : 'New account'}
      subtitle={account ? `api_key ${account.api_key_masked || '—'}` : 'POST /admin/accounts'}
      busy={busy}
      footer={
        <>
          <span className="tiny faint spacer">
            {account ? `PUT /admin/accounts/${account.name}` : 'POST /admin/accounts'}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} icon="save">
            {account ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card title="Identity" hint="how the proxy addresses this account">
        <div className="col" style={{ gap: 12 }}>
          <TextField
            label="Name"
            id="acc-name"
            value={form.name}
            onChange={(v) => set('name', v)}
            placeholder="openai-primary"
            hint={nameTaken ? 'Saving renames the existing account' : 'Unique identifier used in logs and routing'}
          />
          <div className="grid grid--2">
            <div className="field">
              <label className="label" htmlFor="acc-provider">
                Provider type
              </label>
              <input
                id="acc-provider"
                className="input input--mono"
                list="provider-types"
                value={form.provider_type}
                onChange={(e) => set('provider_type', e.target.value)}
                placeholder="openai"
              />
              <datalist id="provider-types">
                {PROVIDER_TYPES.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              <span className="hint">openai · anthropic · google · openai_compatible · …</span>
            </div>
            <TextField
              label="Location"
              id="acc-location"
              value={form.location}
              onChange={(v) => set('location', v)}
              placeholder="US-East"
              hint="Groups accounts in the console; see GET /admin/locations"
            />
          </div>
          <TextField
            label="Base URL"
            id="acc-base-url"
            mono
            value={form.base_url}
            onChange={(v) => set('base_url', v)}
            placeholder="https://api.openai.com/v1"
            optional
          />
          <div className="field">
            <label className="label" htmlFor="acc-key">
              API key <span className="label__opt">write-only</span>
            </label>
            <input
              id="acc-key"
              className="input input--mono"
              type="password"
              value={form.api_key}
              autoComplete="off"
              spellCheck={false}
              placeholder={account?.api_key_masked ? `${account.api_key_masked} — leave blank to keep` : 'sk-…'}
              onChange={(e) => set('api_key', e.target.value)}
            />
            <span className="hint">
              Stored encrypted at rest when <code className="mono">PROXY_ENCRYPTION_KEY</code> is configured. The server
              never returns the secret.
            </span>
          </div>
          <TextField
            label="User agent"
            id="acc-ua"
            mono
            value={form.user_agent}
            onChange={(v) => set('user_agent', v)}
            placeholder="MyApp/1.0"
            optional
          />
        </div>
      </Card>

      <Card title="Models & routing weights">
        <div className="col" style={{ gap: 12 }}>
          <TagInput
            label="Models"
            values={form.models}
            onChange={(v) => set('models', v)}
            placeholder="gpt-4o, gpt-4o-mini"
            hint="Empty list = pass-through for any model allowed by strict_models"
          />
          <div className="row">
            <Switch
              checked={form.models_exact}
              onChange={(v) => set('models_exact', v)}
              label="models_exact — exact ids only"
              ariaLabel="Exact model matching"
            />
          </div>
          <div className="grid grid--3">
            <NumberField label="Weight" value={form.weight} onChange={(v) => set('weight', v ?? 1)} min={0} step={1} hint="weighted strategy" />
            <NumberField label="Priority" value={form.priority} onChange={(v) => set('priority', v ?? 0)} min={0} step={1} hint="lower wins" />
            <SelectField
              label="Strategy override"
              value={form.routing.strategy}
              onChange={(v) => set('routing', { ...form.routing, strategy: v })}
              placeholder="inherit global"
              options={[
                { value: 'round_robin', label: 'round_robin' },
                { value: 'failover', label: 'failover' },
                { value: 'weighted', label: 'weighted' },
                { value: 'random', label: 'random' },
                { value: 'least_latency', label: 'least_latency' },
                { value: 'least_cost', label: 'least_cost' },
                { value: 'least_requests', label: 'least_requests' },
                { value: 'priority', label: 'priority' },
              ]}
            />
          </div>
          <NumberField
            label="Cost multiplier"
            value={form.routing.cost_multiplier}
            onChange={(v) => set('routing', { ...form.routing, cost_multiplier: v })}
            min={0}
            step={0.1}
            hint="1.0 = list price; used by least_cost"
          />
        </div>
      </Card>

      <Card title="Rate limits">
        <div className="col" style={{ gap: 12 }}>
          <Switch checked={form.rate_limit.enabled} onChange={(v) => set('rate_limit', { ...form.rate_limit, enabled: v })} label="Enforce rate limits" />
          <div className="grid grid--3">
            <NumberField label="RPM" value={form.rate_limit.rpm} onChange={(v) => set('rate_limit', { ...form.rate_limit, rpm: v })} nullable min={0} />
            <NumberField label="TPM" value={form.rate_limit.tpm} onChange={(v) => set('rate_limit', { ...form.rate_limit, tpm: v })} nullable min={0} />
            <NumberField label="Burst" value={form.rate_limit.burst} onChange={(v) => set('rate_limit', { ...form.rate_limit, burst: v })} nullable min={0} />
          </div>
        </div>
      </Card>

      <Card title="Budget">
        <div className="grid grid--2">
          <NumberField label="Daily USD" value={form.budget.daily_usd} onChange={(v) => set('budget', { ...form.budget, daily_usd: v })} nullable min={0} step={0.5} />
          <NumberField label="Monthly USD" value={form.budget.monthly_usd} onChange={(v) => set('budget', { ...form.budget, monthly_usd: v })} nullable min={0} step={5} />
        </div>
      </Card>

      <Card title="Egress proxy">
        <div className="col" style={{ gap: 12 }}>
          <Switch checked={form.proxy.enabled} onChange={(v) => set('proxy', { ...form.proxy, enabled: v })} label="Route upstream calls through a proxy" />
          <div className="field">
            <label className="label" htmlFor="acc-proxy-url">
              Proxy URL <span className="label__opt">write-only</span>
            </label>
            <input
              id="acc-proxy-url"
              className="input input--mono"
              type="password"
              value={form.proxy.url}
              autoComplete="off"
              spellCheck={false}
              disabled={!form.proxy.enabled}
              placeholder={
                account?.proxy?.url_masked ? `${account.proxy.url_masked} — leave blank to keep` : 'http://user:pass@host:8080'
              }
              onChange={(e) => set('proxy', { ...form.proxy, url: e.target.value })}
            />
            {account?.proxy?.url_masked ? (
              <span className="hint">
                Current: <code className="mono">{account.proxy.url_masked}</code>
              </span>
            ) : null}
          </div>
        </div>
      </Card>

      <Card title="Extra headers">
        <HeaderEditor value={form.extra_headers} onChange={(v) => set('extra_headers', v)} />
      </Card>

      <Card title="Payload preview" hint="exact JSON sent to the proxy">
        <pre className="code-block">{preview}</pre>
      </Card>

      <SectionTitle>Notes</SectionTitle>
      <p className="tiny faint">
        Updating with <code className="mono">PUT /admin/accounts/{'{name}'}</code> is partial — omitted fields stay as they
        are. Secrets are only sent when you type them; the stored value is never read back.
      </p>
    </Drawer>
  )
}