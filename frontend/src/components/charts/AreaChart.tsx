import { useId, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { useMeasure } from '../../lib/hooks.ts'
import { areaPath, linePath, linearScale, niceTicks, shortNumber, tickIndices } from './chartUtils.ts'

export interface AreaSeries {
  key: string
  label: string
  color: string
  values: number[]
}

export interface AreaChartProps {
  series: AreaSeries[]
  /** x-axis labels, one per data point (bucket timestamps). */
  labels: string[]
  height?: number
  /** Stack the series instead of overlaying them. */
  stacked?: boolean
  formatValue?: (n: number) => string
  formatLabel?: (label: string, index: number) => string
  emptyMessage?: string
  /** Fill the area under the line (off for pure line charts). */
  fill?: boolean
}

const PAD = { top: 12, right: 10, bottom: 22, left: 44 }

export function AreaChart({
  series,
  labels,
  height = 220,
  stacked = false,
  formatValue = shortNumber,
  formatLabel,
  emptyMessage = 'No data in this range',
  fill = true,
}: AreaChartProps): ReactElement {
  const [wrapRef, size] = useMeasure<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const width = Math.max(220, size.width || 640)
  const n = labels.length

  const geom = useMemo(() => {
    const innerW = Math.max(10, width - PAD.left - PAD.right)
    const innerH = Math.max(10, height - PAD.top - PAD.bottom)

    const maxes = series.map((s) => {
      if (stacked) return s.values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
      return s.values.reduce((a, b) => Math.max(a, Number.isFinite(b) ? b : 0), 0)
    })
    const top = Math.max(...maxes, 0)
    const ticks = niceTicks(top || 1, 4)
    const yMax = ticks[ticks.length - 1] || 1
    const y = linearScale([0, yMax], [PAD.top + innerH, PAD.top])
    const x = (i: number) => (n <= 1 ? PAD.left + innerW / 2 : PAD.left + (i / (n - 1)) * innerW)

    // stacked baselines
    const running = new Array<number>(n).fill(0)
    const layers = series.map((s, si) => {
      const upper = s.values.map((v, i) => {
        const value = Number.isFinite(v) ? v : 0
        const top_i = stacked ? running[i] + value : value
        const lower_i = stacked ? running[i] : 0
        if (stacked) running[i] = top_i
        return { x: x(i), y1: y(top_i), y0: y(lower_i), value }
      })
      return { s, upper, lower: stacked ? upper.map((p) => ({ x: p.x, y: p.y0 })) : [], color: s.color || `var(--c${(si % 6) + 1})` }
    })

    // For stacked series the fill spans between the layer baseline and its top.
    const baselines = series.map((_, si) => {
      if (!stacked) return new Array<number>(n).fill(0)
      const base: number[] = []
      for (let i = 0; i < n; i++) {
        let sum = 0
        for (let k = 0; k < si; k++) sum += Number.isFinite(series[k].values[i] ?? 0) ? (series[k].values[i] ?? 0) : 0
        base.push(sum)
      }
      return base
    })

    return { innerW, innerH, y, x, ticks, layers, baselines, baselineY: y(0) }
  }, [series, width, height, stacked, n])

  if (!n || !series.length) {
    return (
      <div ref={wrapRef} className="chart" style={{ height }}>
        <div className="empty" style={{ height: '100%' }}>
          <span className="empty__text">{emptyMessage}</span>
        </div>
      </div>
    )
  }

  const hasData = series.some((s) => s.values.some((v) => Number.isFinite(v) && v > 0))
  const labelFor = (label: string, i: number): string => (formatLabel ? formatLabel(label, i) : label)
  const xTicks = tickIndices(n, Math.max(3, Math.floor(geom.innerW / 78)))

  const onMove = (e: ReactMouseEvent<SVGRectElement>): void => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = e.clientX - rect.left
    const ratio = (px - PAD.left) / (geom.innerW || 1)
    const idx = Math.round(ratio * (n - 1))
    setHover(idx >= 0 && idx < n ? idx : null)
  }

  const hovered = hover !== null && hover >= 0 && hover < n ? hover : null

  return (
    <div ref={wrapRef} className="chart" style={{ height }}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        role="img"
        aria-label={`${series.map((s) => s.label).join(', ')} over time`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {geom.layers.map((l, i) => (
            <linearGradient key={i} id={`${uid}-g${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={l.color} stopOpacity={0.38} />
              <stop offset="100%" stopColor={l.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>

        {/* gridlines + y labels */}
        {geom.ticks.map((t) => {
          const y = geom.y(t)
          return (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} stroke="var(--line-soft)" strokeWidth={1} />
              <text x={PAD.left - 7} y={y + 3.5} textAnchor="end" className="chart__ytick">
                {formatValue(t)}
              </text>
            </g>
          )
        })}

        {/* x labels */}
        {xTicks.map((i) => {
          const label = labelFor(labels[i] ?? '', i)
          return (
            <text
              key={i}
              x={geom.x(i)}
              y={height - 6}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              className="chart__xtick"
            >
              {label.length > 14 ? `${label.slice(0, 13)}…` : label}
            </text>
          )
        })}

        {/* series */}
        {geom.layers.map((l, i) => {
          const pts = l.upper.map((p) => ({ x: p.x, y: p.y1 }))
          const base = geom.baselines[i] ?? new Array<number>(n).fill(0)
          const d = linePath(pts)
          const basePts = l.upper.map((p, k) => ({ x: p.x, y: geom.y(base[k] ?? 0) }))
          const fillPath = stacked
            ? `${linePath(pts)} ${[...basePts].reverse().map((p) => `L${p.x},${p.y}`).join(' ')} Z`
            : areaPath(pts, geom.baselineY)
          return (
            <g key={l.s.key || i}>
              {fill && (
                <path
                  d={fillPath}
                  fill={`url(#${uid}-g${i})`}
                  className="chart__area"
                  style={{ animationDelay: `${60 + i * 90}ms` }}
                />
              )}
              <path
                d={d}
                fill="none"
                stroke={l.color}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                className="chart__line"
                style={{ animationDelay: `${i * 90}ms` }}
              />
            </g>
          )
        })}

        {/* hover crosshair */}
        {hovered !== null && (
          <g className="chart__hover">
            <line
              x1={geom.x(hovered)}
              x2={geom.x(hovered)}
              y1={PAD.top}
              y2={height - PAD.bottom}
              stroke="var(--line-strong)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {geom.layers.map((l) => {
              const p = l.upper[hovered]
              if (!p) return null
              return <circle key={l.s.key} cx={p.x} cy={p.y1} r={3.2} fill={l.color} stroke="var(--bg)" strokeWidth={1.5} />
            })}
          </g>
        )}

        <rect
          x={PAD.left}
          y={PAD.top}
          width={geom.innerW}
          height={geom.innerH}
          fill="transparent"
          onMouseMove={onMove}
          onTouchStart={(e) => {
            const t = e.touches[0]
            if (t) onMove({ clientX: t.clientX } as ReactMouseEvent<SVGRectElement>)
          }}
        />
      </svg>

      {hovered !== null && (
        <div
          className="chart__tip"
          style={{
            left: Math.min(Math.max(geom.x(hovered), 70), width - 70),
            top: PAD.top + 6,
          }}
        >
          <div className="chart__tip-title">{labels[hovered]}</div>
          {geom.layers.map((l) => (
            <div className="chart__tip-row" key={l.s.key}>
              <span className="chart__swatch" style={{ background: l.color }} />
              <span>{l.s.label}</span>
              <strong style={{ marginLeft: 'auto' }}>{formatValue(l.upper[hovered]?.value ?? 0)}</strong>
            </div>
          ))}
        </div>
      )}

      {!hasData && <div className="empty__text faint center tiny" style={{ marginTop: -height / 2 + 40 }}>All zeros</div>}
    </div>
  )
}