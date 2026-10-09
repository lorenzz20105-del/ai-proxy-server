import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { ConfirmProvider, ToastProvider } from './components/ui/Overlays.tsx'
import { LiveProvider, useLive } from './app/LiveContext.tsx'
import { KeyGate } from './app/KeyGate.tsx'
import { Sidebar } from './app/Sidebar.tsx'
import { NAV, routeFromHash } from './app/nav.ts'
import { Ticker, TopBar } from './app/TopBar.tsx'
import { Overview } from './pages/Overview.tsx'
import { Providers } from './pages/Providers.tsx'
import { Routing } from './pages/Routing.tsx'
import { Playground } from './pages/Playground.tsx'
import { Usage } from './pages/Usage.tsx'
import { Traffic } from './pages/Traffic.tsx'
import { Settings } from './pages/Settings.tsx'
import { api, getApiKey, isApiError, setApiKey } from './lib/api.ts'
import { Spinner } from './components/ui/Primitives.tsx'
import { Icon } from './components/ui/Icon.tsx'
import { useHashRoute } from './lib/hooks.ts'
import './styles/index.css'
import './styles/app.css'

export default function App(): ReactElement {
  const [key, setKey] = useState<string>(() => getApiKey())
  const [verified, setVerified] = useState(false)

  // A stored key that the proxy rejects must not leave a dead console behind.
  useEffect(() => {
    if (!key) {
      setVerified(false)
      return
    }
    let alive = true
    api
      .verifyKey()
      .then(() => alive && setVerified(true))
      .catch((e: unknown) => {
        if (!alive) return
        if (isApiError(e) && e.isAuth) {
          setApiKey('')
          setKey('')
        } else {
          // network trouble — let the shell boot and surface the error inline
          setVerified(true)
        }
      })
    return () => {
      alive = false
    }
  }, [key])

  if (!key) return <KeyGate onAuthenticated={setKey} />
  if (!verified) return <Booting />

  return (
    <ToastProvider>
      <ConfirmProvider>
        <LiveProvider>
          <Shell
            onSignOut={() => {
              setApiKey('')
              setKey('')
            }}
          />
        </LiveProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}

function Booting(): ReactElement {
  return (
    <div className="gate">
      <div className="col" style={{ alignItems: 'center', gap: 12 }}>
        <span className="gate__logo">
          <Icon name="bolt" size={20} strokeWidth={2} />
        </span>
        <span className="muted small row" style={{ gap: 8 }}>
          <Spinner /> Verifying API key…
        </span>
      </div>
    </div>
  )
}

function Shell({ onSignOut }: { onSignOut: () => void }): ReactElement {
  const [hash, navigate] = useHashRoute()
  const [navOpen, setNavOpen] = useState(false)
  const { reloadHealth, reloadAccounts } = useLive()

  const route = useMemo(() => routeFromHash(hash), [hash])
  const title = NAV.find((n) => n.path === route)?.label ?? 'Overview'

  const refresh = useCallback(() => {
    reloadHealth()
    reloadAccounts()
  }, [reloadHealth, reloadAccounts])

  return (
    <div className="app">
      <Sidebar
        route={route}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        onNavigate={(p) => navigate(p)}
        onSignOut={onSignOut}
      />
      <div className="app__main">
        <TopBar title={title} onMenu={() => setNavOpen(true)} onRefresh={refresh} />
        <Ticker />
        <main className="app__content" id="main">
          {route === '/overview' ? <Overview /> : null}
          {route === '/providers' ? <Providers /> : null}
          {route === '/routing' ? <Routing /> : null}
          {route === '/playground' ? <Playground /> : null}
          {route === '/usage' ? <Usage /> : null}
          {route === '/traffic' ? <Traffic /> : null}
          {route === '/settings' ? <Settings /> : null}
        </main>
      </div>
    </div>
  )
}