import type { ReactElement } from 'react'

export interface BarListRow {
  label: string
  value: number
  /** Optional secondary line under the label. */
  hint?: string
  color?: string
  badge?: ReactElement | string
}

export interface BarListProps {
  rows: BarListRow[]
  formatValue?: (n: number) => string
  emptyMessage?: string
  max?: number
  maxRows?: number
}

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)']

/** Horizontal magnitude bars — used for cost-by-account, models, keys, … */
export function BarList({
  rows,
  formatValue = (n) => n.toLocaleString(),
  emptyMessage = 'Nothing to show yet',
  max,
  maxRows = 12,
}: BarListProps): ReactElement {
  if (!rows.length) {
    return (
      <div className="empty">
        <span className="empty__text">{emptyMessage}</span>
      </div>
    )
  }
  const top = max ?? Math.max(...rows.map((r) => r.value), 0)
  const shown = rows.slice(0, maxRows)
  const hidden = rows.length - shown.length

  return (
    <div className="barlist">
      {shown.map((row, i) => {
        const pct = top > 0 ? Math.max(0, Math.min(100, (row.value / top) * 100)) : 0
        const color = row.color || PALETTE[i % PALETTE.length]
        return (
          <div className="barlist__row" key={row.label} title={`${row.label}: ${formatValue(row.value)}`}>
            <div className="barlist__label">
              <div className="truncate">{row.label}</div>
              {row.hint ? <div className="tiny faint truncate">{row.hint}</div> : null}
            </div>
            <div className="bar" title={`${pct.toFixed(1)}% of max`}>
              <div
                className="bar__fill"
                style={{
                  width: `${pct}%`,
                  background: color,
                  animationDelay: `${i * 45}ms`,
                }}
              />
            </div>
            <div className="barlist__value">{row.badge ?? formatValue(row.value)}</div>
          </div>
        )
      })}
      {hidden > 0 && <div className="tiny faint">+{hidden} more</div>}
    </div>
  )
}