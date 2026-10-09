import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { api, streamLogs } from '../lib/api.ts'
import { isApiError } from '../lib/api.ts'
import type { Account, HealthResponse, LogEntry } from '../lib/types.ts'
import { useAsync, useInterval } from '../lib/hooks.ts'

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'paused'

export interface LiveValue {
  health: HealthResponse | null
  healthError: Error | null
  reloadHealth: () => void
  accounts: Account[] | null
  accountsError: Error | null
  reloadAccounts: () => void
  logs: LogEntry[]
  streamStatus: StreamStatus
  streamDetail: string
  paused: boolean
  setPaused: (v: boolean) => void
  backlog: number
  /** Global filter typed in the top bar. */
  query: string
  setQuery: (v: string) => void
}

const LiveContext = createContext<LiveValue | null>(null)

const MAX_LOGS = 400

export function LiveProvider({ children }: { children: ReactNode }): ReactElement {
  const health = useAsync<HealthResponse>((signal) => api.health(signal), [])
  const accounts = useAsync<{ accounts: Account[] }>((signal) => api.accounts(signal), [])

  // keep the shell fresh without hammering the backend
  useInterval(health.reload, 8000)
  useInterval(accounts.reload, 20000)

  const [logs, setLogs] = useState<LogEntry[]>([])
  const [paused, setPausedState] = useState(false)
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [detail, setDetail] = useState('')
  const [backlog, setBacklog] = useState(0)
  const [query, setQuery] = useState('')

  const pausedRef = useRef(false)
  const pendingRef = useRef<LogEntry[]>([])
  const lastIdRef = useRef<string | null>(null)

  useEffect(() => {
    pausedRef.current = paused
    if (!paused && pendingRef.current.length) {
      const pending = pendingRef.current
      pendingRef.current = []
      setBacklog(0)
      setLogs((prev) => [...pending.reverse(), ...prev].slice(0, MAX_LOGS))
    }
  }, [paused])

  useEffect(() => {
    const ac = new AbortController()
    void streamLogs({
      signal: ac.signal,
      after: () => lastIdRef.current,
      onLog: (log) => {
        if (log.id) lastIdRef.current = log.id
        if (pausedRef.current) {
          pendingRef.current.unshift(log)
          if (pendingRef.current.length > MAX_LOGS) pendingRef.current.length = MAX_LOGS
          setBacklog(pendingRef.current.length)
          return
        }
        setLogs((prev) => {
          if (prev.some((l) => l.id === log.id)) return prev
          return [log, ...prev].slice(0, MAX_LOGS)
        })
      },
      onStatus: (s, d) => {
        setStatus(s)
        setDetail(d || '')
      },
    }).catch(() => {
      setStatus('offline')
    })
    return () => ac.abort()
  }, [])

  const setPaused = useCallback((v: boolean) => setPausedState(v), [])

  // Keyboard: space toggles pause when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable
      if (e.key === '/' && !typing) {
        e.preventDefault()
        document.getElementById('global-search')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo<LiveValue>(
    () => ({
      health: health.data,
      healthError: health.error,
      reloadHealth: health.reload,
      accounts: accounts.data?.accounts ?? null,
      accountsError: accounts.error,
      reloadAccounts: accounts.reload,
      logs,
      streamStatus: paused ? 'paused' : status,
      streamDetail: detail,
      paused,
      setPaused,
      backlog,
      query,
      setQuery,
    }),
    [health.data, health.error, health.reload, accounts.data, accounts.error, accounts.reload, logs, status, detail, paused, setPaused, backlog, query],
  )

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export function useLive(): LiveValue {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used inside <LiveProvider>')
  return ctx
}

/** Shared, debounced health poll used by the top bar pill. */
export function useConnectionTone(): { tone: 'ok' | 'warn' | 'danger'; label: string } {
  const { health, healthError, streamStatus } = useLive()
  return useMemo(() => {
    if (healthError) {
      const offline = isApiError(healthError) && healthError.status === 0
      return { tone: offline ? ('danger' as const) : ('warn' as const), label: offline ? 'offline' : 'unreachable' }
    }
    if (!health) return { tone: 'warn' as const, label: 'connecting' }
    if (health.status !== 'ok') return { tone: 'danger' as const, label: health.status }
    if (streamStatus === 'reconnecting' || streamStatus === 'offline') return { tone: 'warn' as const, label: streamStatus }
    if (health.accounts.degraded) return { tone: 'warn' as const, label: 'degraded' }
    return { tone: 'ok' as const, label: 'connected' }
  }, [health, healthError, streamStatus])
}