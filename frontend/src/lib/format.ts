/** Presentation helpers. Pure functions, no React. */

export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function compact(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(digits)}B`
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(digits)}M`
  if (abs >= 10_000) return `${(n / 1000).toFixed(digits)}k`
  if (abs >= 1000) return `${(n / 1000).toFixed(digits)}k`
  if (abs >= 100) return n.toFixed(0)
  if (abs >= 1) return n.toFixed(abs % 1 === 0 ? 0 : 1)
  return n.toFixed(abs === 0 ? 0 : 2)
}

export function usd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n === 0) return '$0.00'
  if (Math.abs(n) < 0.01) return `$${n.toFixed(5)}`
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}s`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`
  if (n >= 100) return `${Math.round(n)}ms`
  return `${n.toFixed(n < 10 ? 1 : 0)}ms`
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** Timestamps from the API are unix seconds (float). */
export function clock(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false })
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, { hour12: false })
}

export function shortDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function ago(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (!ts) return 'never'
  const delta = Math.max(0, now - ts)
  if (delta < 5) return 'just now'
  if (delta < 60) return `${Math.floor(delta)}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

export function bucketLabel(bucket: string): string {
  const d = new Date(bucket)
  if (Number.isNaN(d.getTime())) return bucket
  const hasMinutes = /T\d{2}:\d{2}/.test(bucket)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: hasMinutes ? '2-digit' : undefined,
    hour12: false,
  })
}

export function truncate(s: string, max = 48): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

export function middleTruncate(s: string, max = 28): string {
  if (s.length <= max) return s
  const keep = Math.max(4, Math.floor((max - 1) / 2))
  return `${s.slice(0, keep)}…${s.slice(-keep)}`
}

/* ---------------- status / level classification ---------------- */

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'accent'

export function statusTone(status: number | null | undefined): Tone {
  if (status === null || status === undefined) return 'muted'
  if (status >= 500) return 'danger'
  if (status >= 400) return 'warn'
  if (status >= 200 && status < 300) return 'ok'
  return 'info'
}

export function statusClass(status: number | null | undefined): string {
  if (status === null || status === undefined) return '—'
  return `${Math.floor(status / 100)}xx`
}

export function levelTone(level: string | null | undefined): Tone {
  switch ((level || '').toLowerCase()) {
    case 'error':
    case 'critical':
    case 'fatal':
      return 'danger'
    case 'warn':
    case 'warning':
      return 'warn'
    case 'info':
      return 'info'
    case 'debug':
    case 'trace':
      return 'muted'
    default:
      return 'muted'
  }
}

export function circuitTone(circuit: string | null | undefined): Tone {
  switch ((circuit || '').toLowerCase()) {
    case 'closed':
      return 'ok'
    case 'half_open':
    case 'half-open':
      return 'warn'
    case 'open':
      return 'danger'
    default:
      return 'muted'
  }
}

export function toneColor(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'var(--ok)'
    case 'warn':
      return 'var(--warn)'
    case 'danger':
      return 'var(--danger)'
    case 'info':
      return 'var(--info)'
    case 'accent':
      return 'var(--accent)'
    default:
      return 'var(--muted)'
  }
}

export function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`
}

/** Series of numbers → array of numbers, tolerating nulls. */
export function series(values: (number | null | undefined)[]): number[] {
  return values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
}