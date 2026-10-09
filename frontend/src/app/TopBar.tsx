import type { ReactElement } from 'react'
import { Icon } from '../components/ui/Icon.tsx'
import { IconButton } from '../components/ui/Primitives.tsx'
import { useConnectionTone, useLive } from './LiveContext.tsx'
import { levelTone, toneColor } from '../lib/format.ts'

export function TopBar({
  title,
  onMenu,
  onRefresh,
}: {
  title: string
  onMenu: () => void
  onRefresh: () => void
}): ReactElement {
  const { query, setQuery, paused, setPaused, backlog } = useLive()
  const tone = useConnectionTone()

  return (
    <header className="topbar">
      <button type="button" className="icon-btn topbar__menu" aria-label="Open navigation" onClick={onMenu}>
        <Icon name="menu" size={16} />
      </button>
      <div className="col" style={{ gap: 0, minWidth: 0 }}>
        <span className="topbar__title truncate">{title}</span>
        <span className="topbar__crumb">/admin console</span>
      </div>

      <div className="search">
        <span className="search__icon">
          <Icon name="search" size={14} />
        </span>
        <input
          id="global-search"
          type="search"
          value={query}
          placeholder="Filter traffic, accounts, models…"
          aria-label="Global filter"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) window.location.hash = `#/traffic?q=${encodeURIComponent(query.trim())}`
            if (e.key === 'Escape') setQuery('')
          }}
        />
        <span className="search__kbd">/</span>
      </div>

      <span className="spacer" />

      <span className={`status-pill status-pill--${tone.tone}`} title={`proxy: ${tone.label}`}>
        <span className={`dot dot--${tone.tone}`} />
        <span className="nowrap">{tone.label}</span>
      </span>

      <IconButton
        label={paused ? `Resume live feed${backlog ? ` (${backlog} queued)` : ''}` : 'Pause live feed'}
        name={paused ? 'play' : 'pause'}
        pressed={paused}
        onClick={() => setPaused(!paused)}
      />
      <IconButton label="Refresh data" name="refresh" onClick={onRefresh} />
    </header>
  )
}

export function Ticker(): ReactElement {
  const { logs, query, streamStatus, paused } = useLive()
  const q = query.trim().toLowerCase()
  const items = (q
    ? logs.filter((l) =>
        [l.account, l.model, l.requested_model, l.path, l.key_name, l.error, String(l.status)]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      )
    : logs
  ).slice(0, 24)

  return (
    <div className="ticker" role="status" aria-label="Live request ticker">
      <span className="ticker__label">
        {paused ? 'Paused' : streamStatus === 'live' ? 'Live' : streamStatus}
      </span>
      <div className="ticker__track">
        {items.length === 0 ? (
          <span className="ticker__empty">
            {query ? `No live event matches “${query}”` : 'Waiting for traffic on /admin/logs/stream…'}
          </span>
        ) : (
          items.map((l) => {
            const tone = l.error || (l.status && l.status >= 400) ? levelTone('error') : levelTone(l.level)
            return (
              <span className="ticker__item" key={l.id} title={l.error || `${l.method} ${l.path}`}>
                <span style={{ color: toneColor(tone), fontWeight: 700 }}>{l.status ?? l.level}</span>
                <span className="faint">{l.account || '—'}</span>
                <span className="muted">{l.model || l.requested_model || l.kind}</span>
                {l.latency_ms ? <span className="faint">{Math.round(l.latency_ms)}ms</span> : null}
                {l.error ? <span style={{ color: 'var(--danger)' }}>{l.error.slice(0, 60)}</span> : null}
              </span>
            )
          })
        )}
      </div>
      <span className="tiny faint nowrap">{logs.length} buffered</span>
    </div>
  )
}