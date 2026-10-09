import { useId, useMemo } from 'react'
import type { ReactElement } from 'react'
import { linePath, linearScale } from './chartUtils.ts'

export interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  color?: string
  fill?: boolean
  strokeWidth?: number
  /** Force the y-domain instead of auto-fitting (e.g. 0..1 for rates). */
  domain?: [number, number]
  label?: string
}

/** Tiny inline chart for KPI tiles. Never renders axes. */
export function Sparkline({
  values,
  width = 120,
  height = 24,
  color = 'var(--accent)',
  fill = true,
  strokeWidth = 1.5,
  domain,
  label,
}: SparklineProps): ReactElement {
  const uid = useId().replace(/:/g, '')
  const clean = useMemo(
    () => values.map((v) => (Number.isFinite(v) ? v : 0)),
    [values],
  )
  if (clean.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true" className="kpi__spark">
        <line
          x1={0}
          x2={width}
          y1={height - 1}
          y2={height - 1}
          stroke="var(--line)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    )
  }

  const max = domain ? domain[1] : Math.max(...clean)
  const min = domain ? domain[0] : Math.min(0, ...clean)
  const y = linearScale([min, max === min ? min + 1 : max], [height - 2, 2])
  const x = linearScale([0, clean.length - 1], [1, width - 1])
  const pts = clean.map((v, i) => ({ x: x(i), y: y(v) }))
  const d = linePath(pts, 0.18)
  const area = `${d} L${pts[pts.length - 1].x},${height} L${pts[0].x},${height} Z`

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} className="kpi__spark">
      <defs>
        <linearGradient id={`sp-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#sp-${uid})`} className="chart__area" />}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        pathLength={1}
        className="chart__line"
      />
    </svg>
  )
}