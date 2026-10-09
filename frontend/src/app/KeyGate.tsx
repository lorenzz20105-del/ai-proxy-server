import { useState } from 'react'
import type { ReactElement } from 'react'
import { api, errorMessage, getApiKey, setApiKey } from '../lib/api.ts'
import { Button } from '../components/ui/Primitives.tsx'
import { Icon } from '../components/ui/Icon.tsx'

/** Shown until an API key is present in localStorage and accepted by the proxy. */
export function KeyGate({ onAuthenticated }: { onAuthenticated: (key: string) => void }): ReactElement {
  const [value, setValue] = useState(getApiKey())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const key = value.trim()
    if (!key) return
    setBusy(true)
    setError(null)
    setApiKey(key)
    try {
      // cheapest authenticated round-trip in the contract
      await api.verifyKey()
      onAuthenticated(key)
    } catch (e) {
      setApiKey('')
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate">
      <form
        className="gate__card"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="row">
          <span className="gate__logo">
            <Icon name="bolt" size={20} strokeWidth={2} />
          </span>
          <div className="col" style={{ gap: 0 }}>
            <span className="gate__title">AI Proxy Server</span>
            <span className="tiny muted">admin console · v3</span>
          </div>
        </div>

        <p className="gate__sub">
          Paste the master (or dashboard) API key. It is stored in this browser's localStorage and sent as{' '}
          <code className="mono">x-api-key</code> on every request.
        </p>

        <div className="field">
          <label className="label" htmlFor="api-key">
            API key
          </label>
          <input
            id="api-key"
            className={`input input--mono${error ? ' input--invalid' : ''}`}
            type="password"
            value={value}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="sk-…"
            onChange={(e) => setValue(e.target.value)}
          />
          {error ? <span className="field__error">{error}</span> : null}
        </div>

        <Button type="submit" variant="primary" block loading={busy} iconRight="arrowRight">
          {busy ? 'Verifying…' : 'Connect'}
        </Button>

        <p className="tiny faint" style={{ lineHeight: 1.5 }}>
          The key is never sent anywhere except this proxy instance. Endpoints read: <code className="mono">/admin/*</code>,{' '}
          <code className="mono">/v1/*</code>, <code className="mono">/health</code>.
        </p>
      </form>
    </div>
  )
}