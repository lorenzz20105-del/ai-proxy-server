import { useId, useState } from 'react'
import type { ReactElement } from 'react'

export interface DonutSegment {
  label: string
  value: number
  color?: string
}

export interface DonutProps {
  segments: DonutSegment[]
  size?: number
  thickness?: number
  centerLabel?: string
  centerValue?: string
  formatValue?: (n: number) => string
  emptyMessage?: string
}

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)']

/** Proportional donut with a hover-highlighted legend. */
export function Donut({
  segments,
  size = 150,
  thickness = 16,
  centerLabel,
  centerValue,
  formatValue = (n) => n.toLocaleString(),
  emptyMessage = 'No data',
}: DonutProps): ReactElement {
  const uid = useId().replace(/:/g, '')
  const [active, setActive] = useState<string | null>(null)

  const data = segments.filter((s) => Number.isFinite(s.value) && s.value > 0)
  const total = data.reduce((a, b) => a + b.value, 0)

  if (!total) {
    return (
      <div className="empty">
        <span className="empty__text">{emptyMessage}</span>
      </div>
    )
  }

  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r

  // prefix sums give each arc its dash offset without mutating anything
  const running = data.reduce<number[]>((acc, s) => {
    acc.push((acc[acc.length - 1] ?? 0) + s.value)
    return acc
  }, [])

  const arcs = data.map((s, i) => {
    const frac = s.value / total
    const len = frac * c
    const before = i === 0 ? 0 : running[i - 1]
    return {
      ...s,
      color: s.color || PALETTE[i % PALETTE.length],
      dash: `${len} ${c - len}`,
      offset: -(before / total) * c,
      frac,
    }
  })

  return (
    <div className="row" style={{ gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Distribution donut" style={{ flex: 'none' }}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-3)" strokeWidth={thickness} />
          {arcs.map((a) => (
            <circle
              key={`${a.label}-${uid}`}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth={active === a.label ? thickness + 4 : thickness}
              strokeDasharray={a.dash}
              strokeDashoffset={a.offset}
              strokeLinecap="butt"
              className="donut__arc"
              opacity={active && active !== a.label ? 0.35 : 1}
              onMouseEnter={() => setActive(a.label)}
              onMouseLeave={() => setActive(null)}
            />
          ))}
        </g>
        <text x={size / 2} y={size / 2 - 3} textAnchor="middle" className="donut__value">
          {active
            ? formatValue(data.find((d) => d.label === active)?.value ?? 0)
            : (centerValue ?? formatValue(total))}
        </text>
        <text x={size / 2} y={size / 2 + 14} textAnchor="middle" className="donut__label">
          {active ?? centerLabel ?? 'total'}
        </text>
      </svg>

      <div className="col" style={{ gap: 5, minWidth: 140, flex: '1 1 140px' }}>
        {arcs.map((a) => (
          <div
            key={a.label}
            className="row"
            style={{ gap: 7, fontSize: 11.5, opacity: active && active !== a.label ? 0.5 : 1, cursor: 'default' }}
            onMouseEnter={() => setActive(a.label)}
            onMouseLeave={() => setActive(null)}
          >
            <span className="chart__swatch" style={{ background: a.color }} />
            <span className="truncate" style={{ color: 'var(--text-dim)' }}>
              {a.label}
            </span>
            <span className="spacer" />
            <span className="nums tiny">{(a.frac * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}