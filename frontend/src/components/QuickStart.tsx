import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Card, CopyButton, Button, Badge } from './ui/Primitives.tsx'
import { TextField, NumberField } from './ui/Fields.tsx'
import { Icon } from './ui/Icon.tsx'
import { useToast } from './ui/Overlays.tsx'
import { api, errorMessage } from '../lib/api.ts'
import { useAsync } from '../lib/hooks.ts'
import type { CreatedKey, KeysResponse } from '../lib/types.ts'

/* ------------------------------------------------------------------ */
/* Connection target                                                   */
/* ------------------------------------------------------------------ */

/**
 * The proxy is same-origin with this console, so the OpenAI-compatible base URL is
 * always derived from the current origin — correct for a laptop, for a LAN host, and
 * for the bundled Android app (which serves this page from 127.0.0.1).
 */
export function baseUrl(): string {
  return `${window.location.origin}/v1`
}

type Target = 'curl' | 'python' | 'node' | 'js'

const TARGETS: Target[] = ['curl', 'python', 'node', 'js']

function snippet(target: Target, base: string, key: string): string {
  const k = key || '$YOUR_API_KEY'
  switch (target) {
    case 'curl':
      return `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'`
    case 'python':
      return `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${k}",
)

reply = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "hi"}],
)
print(reply.choices[0].message.content)`
    case 'node':
      return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: "${k}",
});

const reply = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
});

console.log(reply.choices[0].message.content);`
    default:
      return `OPENAI_BASE_URL=${base} OPENAI_API_KEY=${k} \\\n  npx openai-cli chat "hello"`
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * The first panel on the Overview: where to point clients, and a key to point them with.
 *
 * <p>Both live on the main dashboard because they are the only two things a new user
 * needs before the proxy is usable — the endpoint and a credential for it.
 */
export function QuickStart(): ReactElement {
  const toast = useToast()
  const keys = useAsync<KeysResponse>((signal) => api.keys(signal), [])
  const base = useMemo(baseUrl, [])

  const [name, setName] = useState('')
  const [daily, setDaily] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<CreatedKey | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [target, setTarget] = useState<Target>('curl')

  const create = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('Name the key first', 'A short label so you know which client is using it.')
      return
    }
    setBusy(true)
    try {
      const res = await api.createKey({ name: trimmed, daily_usd: daily, rpm: null, tpm: null })
      // the full key is returned exactly once, on create
      setRevealed(res)
      setName('')
      setDaily(null)
      setAdvanced(false)
      toast.success(`Key “${res.name}” created`, 'Copy it now — only the masked form is stored.')
      keys.reload()
    } catch (e) {
      toast.error('Could not create key', errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const rows: KeysResponse['keys'] = keys.data?.keys ?? []

  return (
    <div className="grid grid--quickstart">
      {/* ---------------------------------------------------------- endpoint */}
      <Card title="Base URL endpoint" hint="OpenAI-compatible · same origin as this console">
        <div className="col" style={{ gap: 10 }}>
          <div className="secret">
            <span className="mono" style={{ flex: 1 }}>
              {base}
            </span>
            <CopyButton value={base} label="Copy URL" variant="default" />
          </div>

          <div className="segmented" role="tablist" aria-label="Client snippet">
            {TARGETS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={t === target}
                onClick={() => setTarget(t)}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="col" style={{ gap: 6 }}>
            <pre className="code-block code-block--tall">{snippet(target, base, '')}</pre>
            <div className="row row--wrap" style={{ gap: 6, alignItems: 'center' }}>
              <CopyButton value={snippet(target, base, '')} label="Copy snippet" />
              <span className="tiny muted">
                swap in a key from the right, or any key ending in the mask above
              </span>
            </div>
          </div>

          <div className="divider" />

          <div className="row row--wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span className="tiny muted">endpoints</span>
            <Badge tone="info">POST /v1/chat/completions</Badge>
            <Badge tone="info">GET /v1/models</Badge>
            <Badge tone="muted">SSE stream supported</Badge>
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------------- key */}
      <Card title="Create an API key" hint="POST /admin/keys · shown once, then masked">
        <div className="col" style={{ gap: 12 }}>
          {revealed ? (
            <div className="col" style={{ gap: 8 }}>
              <div className="alert alert--warn">
                <span className="alert__icon">
                  <Icon name="alert" size={14} />
                </span>
                <div>
                  <strong>This is the only time the full key is shown.</strong> The server keeps
                  only <code className="mono">{revealed.key_masked || revealed.key.slice(0, 10) + '…'}</code>.
                </div>
              </div>
              <div className="secret">
                <span className="mono" style={{ flex: 1 }}>
                  {revealed.key}
                </span>
                <CopyButton value={revealed.key} label="Copy key" variant="default" />
              </div>
              <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
                  Dismiss
                </Button>
                <CopyButton value={`${base}`} label="Copy base URL" size="sm" />
              </div>
            </div>
          ) : null}

          <div className="col" style={{ gap: 8 }}>
            <TextField
              label="Key name"
              value={name}
              onChange={setName}
              onEnter={() => void create()}
              placeholder="laptop · colab · my-editor"
              id="quickstart-key-name"
            />

            {advanced ? (
              <NumberField
                label="Daily USD limit"
                value={daily}
                onChange={setDaily}
                nullable
                min={0}
                step={0.5}
                hint="Leave empty for no cap."
              />
            ) : (
              <Button size="sm" variant="ghost" icon="chevronDown" onClick={() => setAdvanced(true)}>
                Limits
              </Button>
            )}

            <Button
              variant="primary"
              icon="plus"
              loading={busy}
              disabled={!name.trim()}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : 'Create API key'}
            </Button>
          </div>

          <div className="divider" />

          <div className="col" style={{ gap: 6 }}>
            <span className="tiny muted">existing keys</span>
            {keys.error ? (
              <span className="tiny" style={{ color: 'var(--danger)' }}>
                {errorMessage(keys.error)}
              </span>
            ) : rows.length === 0 ? (
              <span className="tiny muted">None yet — the master key works until you make one.</span>
            ) : (
              <div className="row row--wrap" style={{ gap: 6 }}>
                {rows.slice(0, 6).map((k, i) => (
                  <span
                    key={`${k.name}-${i}`}
                    className="row"
                    style={{ gap: 5, alignItems: 'center' }}
                    title={k.key_masked}
                  >
                    <Badge tone={k.enabled ? 'ok' : 'muted'}>{k.name}</Badge>
                    <span className="tiny mono faint">{k.key_masked}</span>
                  </span>
                ))}
                {rows.length > 6 ? <span className="tiny muted">+{rows.length - 6} more</span> : null}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}
