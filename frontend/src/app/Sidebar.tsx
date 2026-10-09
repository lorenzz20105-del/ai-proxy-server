import type { ReactElement } from 'react'
import { Icon } from '../components/ui/Icon.tsx'
import { NAV } from './nav.ts'
import { useLive } from './LiveContext.tsx'

export function Sidebar({
  route,
  onNavigate,
  open,
  onClose,
  onSignOut,
}: {
  route: string
  onNavigate: (path: string) => void
  open: boolean
  onClose: () => void
  onSignOut: () => void
}): ReactElement {
  const { health, accounts, streamStatus } = useLive()
  const enabled = accounts?.filter((a) => a.enabled).length ?? 0
  const openCircuits = accounts?.filter((a) => a.health?.circuit === 'open').length ?? 0

  const badge = (path: string): string | null => {
    if (path === '/providers') {
      if (!accounts) return null
      return openCircuits ? `${enabled}/${accounts.length}` : String(accounts.length)
    }
    if (path === '/overview') return streamStatus === 'live' ? 'live' : streamStatus
    return null
  }

  return (
    <>
      {open ? <div className="scrim" onClick={onClose} style={{ zIndex: 61 }} /> : null}
      <nav className={`sidebar${open ? ' is-open' : ''}`} aria-label="Primary">
        <div className="sidebar__brand">
          <span className="sidebar__logo">
            <Icon name="bolt" size={16} strokeWidth={2} />
          </span>
          <div className="col" style={{ gap: 0, minWidth: 0 }}>
            <span className="sidebar__title">AI Proxy</span>
            <span className="sidebar__subtitle">v{health?.version ?? '—'}</span>
          </div>
          <span className="spacer" />
          <button type="button" className="icon-btn sidebar__close" aria-label="Close navigation" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="nav-label">Console</div>
        {NAV.map((item) => (
          <button
            key={item.path}
            type="button"
            className="nav-item"
            aria-current={route === item.path ? 'page' : undefined}
            onClick={() => {
              onNavigate(item.path)
              onClose()
            }}
          >
            <span className="nav-item__icon">
              <Icon name={item.icon} size={15} />
            </span>
            <span className="truncate">{item.label}</span>
            {badge(item.path) ? <span className="nav-item__badge">{badge(item.path)}</span> : null}
          </button>
        ))}

        <div className="sidebar__foot">
          <div className="row tiny muted" style={{ gap: 6 }}>
            <span className={`dot dot--${health?.status === 'ok' ? 'ok' : 'danger'}`} />
            <span className="truncate">
              {health ? `${health.accounts.healthy}/${health.accounts.total} accounts healthy` : 'status unknown'}
            </span>
          </div>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onSignOut} style={{ justifyContent: 'flex-start' }}>
            <Icon name="key" size={13} /> Change API key
          </button>
        </div>
      </nav>
    </>
  )
}