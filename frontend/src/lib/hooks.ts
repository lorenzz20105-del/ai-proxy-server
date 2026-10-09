/** Small hand-rolled hooks — no state library. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { errorMessage } from './api.ts'

/* ------------------------------------------------------------------ */
/* Async data with abort + retry                                       */
/* ------------------------------------------------------------------ */

export interface AsyncState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  /** true only for the very first load (drives skeletons, not spinners). */
  initial: boolean
  reload: () => void
  setData: (updater: T | ((prev: T | null) => T | null)) => void
}

export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = options.enabled !== false
  const [data, setDataState] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const [initial, setInitial] = useState(true)
  const [nonce, setNonce] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const hasData = data !== null

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const ac = new AbortController()
    let alive = true
    setLoading(true)
    setError(null)
    loaderRef
      .current(ac.signal)
      .then((value) => {
        if (!alive) return
        setDataState(value)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!alive || (e instanceof DOMException && e.name === 'AbortError')) return
        setError(e instanceof Error ? e : new Error(errorMessage(e)))
      })
      .finally(() => {
        if (!alive) return
        setLoading(false)
        setInitial(false)
      })
    return () => {
      alive = false
      ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const setData = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater))
  }, [])

  return { data, error, loading, initial: initial && !hasData, reload, setData }
}

/* ------------------------------------------------------------------ */
/* Hash router (no router package)                                     */
/* ------------------------------------------------------------------ */

export type RouteChangeListener = (route: string) => void

export function parseHash(hash: string): { path: string; params: URLSearchParams } {
  const raw = hash.replace(/^#/, '') || '/'
  const [path, search = ''] = raw.split('?')
  return { path: path || '/', params: new URLSearchParams(search) }
}

export function useHashRoute(): [string, (to: string, opts?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<string>(() => (typeof window === 'undefined' ? '/' : window.location.hash))

  useEffect(() => {
    const onChange = (): void => setRoute(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    const target = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : `/${to}`}`
    if (opts?.replace) window.location.replace(target)
    else window.location.hash = target
    if (opts?.replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])

  return [route, navigate]
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

/** Element width via ResizeObserver — used to make charts crisp, not blurry. */
export function useMeasure<T extends HTMLElement>(): [
  RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const rect = el.getBoundingClientRect()
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height },
      )
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, size]
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' || !window.matchMedia ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(query)
    const onChange = (): void => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function useCopy(resetMs = 1400): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), [])
  const copy = useCallback(
    async (text: string) => {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
        else {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        setCopied(true)
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), resetMs)
      } catch {
        /* clipboard blocked — the value is selectable on screen anyway */
      }
    },
    [resetMs],
  )
  return [copied, copy]
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function useInterval(callback: () => void, ms: number | null): void {
  const saved = useRef(callback)
  useEffect(() => {
    saved.current = callback
  }, [callback])
  useEffect(() => {
    if (ms === null) return
    const id = window.setInterval(() => saved.current(), ms)
    return () => window.clearInterval(id)
  }, [ms])
}

export function useEscape(onEscape: () => void, active = true): void {
  const saved = useRef(onEscape)
  useEffect(() => {
    saved.current = onEscape
  }, [onEscape])
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') saved.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

/** Traps Tab inside a container while it is open (drawers, dialogs). */
export function useFocusTrap<T extends HTMLElement>(active: boolean): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return
    const previous = document.activeElement as HTMLElement | null
    const selector =
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const focusables = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
    const first = focusables()[0]
    if (first) first.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const idx = list.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && (idx <= 0)) {
        e.preventDefault()
        list[list.length - 1].focus()
      } else if (!e.shiftKey && idx === list.length - 1) {
        e.preventDefault()
        list[0].focus()
      }
    }
    node.addEventListener('keydown', onKey)
    return () => {
      node.removeEventListener('keydown', onKey)
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [active])
  return ref
}

export function useAutoScroll<T extends HTMLElement>(deps: unknown[], enabled = true): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return ref
}
