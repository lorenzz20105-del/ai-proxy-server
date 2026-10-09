/** Tiny scale/path helpers shared by the hand-rolled SVG charts. */

export interface Scale {
  (v: number): number
  invert(px: number): number
  domain: [number, number]
  range: [number, number]
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0 || 1
  const fn = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale
  fn.invert = (px: number) => d0 + ((px - r0) / (r1 - r0 || 1)) * span
  fn.domain = domain
  fn.range = range
  return fn
}

/** "Nice" axis ticks (1 / 2 / 2.5 / 5 × 10ⁿ). */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)))
  if (ticks.length < 2) ticks.push(step)
  return ticks
}

export function extent(values: number[]): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) return [0, 1]
  if (min === max) return [min === 0 ? 0 : Math.min(0, min), max === 0 ? 1 : max * 1.1]
  return [min, max]
}

export interface Point {
  x: number
  y: number
}

/** Smooth-ish polyline. `curve` of 0 gives a crisp straight line. */
export function linePath(points: Point[], curve = 0.22): string {
  if (!points.length) return ''
  if (points.length < 3 || curve <= 0) {
    return points.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x)},${fmt(p.y)}`).join(' ')
  }
  let d = `M${fmt(points[0].x)},${fmt(points[0].y)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] || p2
    const t = curve
    const c1x = p1.x + (p2.x - p0.x) * t * 0.5
    const c1y = p1.y + (p2.y - p0.y) * t * 0.5
    const c2x = p2.x - (p3.x - p1.x) * t * 0.5
    const c2y = p2.y - (p3.y - p1.y) * t * 0.5
    d += ` C${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(p2.x)},${fmt(p2.y)}`
  }
  return d
}

export function areaPath(points: Point[], baseline: number): string {
  if (!points.length) return ''
  const first = points[0]
  const last = points[points.length - 1]
  return `${linePath(points)} L${fmt(last.x)},${fmt(baseline)} L${fmt(first.x)},${fmt(baseline)} Z`
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** Evenly-spaced subset of tick indices that fit the available width. */
export function tickIndices(count: number, maxTicks: number): number[] {
  if (count <= 0) return []
  if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i)
  const step = Math.ceil(count / maxTicks)
  const out: number[] = []
  for (let i = 0; i < count; i += step) out.push(i)
  if (out[out.length - 1] !== count - 1) out.push(count - 1)
  return out
}

export function shortNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  if (abs >= 1) return String(Math.round(n * 10) / 10)
  if (abs === 0) return '0'
  return n.toFixed(2)
}