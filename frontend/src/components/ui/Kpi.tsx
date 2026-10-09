import type { ReactElement, ReactNode } from 'react'
import { Sparkline } from '../charts/Sparkline.tsx'
import type { Tone } from '../../lib/format.ts'

export interface KpiProps {
  label: string
  value: ReactNode
  meta?: ReactNode
  tone?: Tone
  spark?: number[]
  sparkColor?: string
  sparkDomain?: [number, number]
  title?: string
}

export function Kpi({ label, value, meta, tone, spark, sparkColor, sparkDomain, title }: KpiProps): ReactElement {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ''}`} title={title}>
      <span className="kpi__label">{label}</span>
      <span className="kpi__value">{value}</span>
      {spark && spark.length > 1 ? (
        <Sparkline values={spark} color={sparkColor ?? toneColor(tone)} domain={sparkDomain} height={22} />
      ) : null}
      <span className="kpi__meta">{meta}</span>
    </div>
  )
}

function toneColor(tone?: Tone): string {
  switch (tone) {
    case 'ok':
      return 'var(--ok)'
    case 'warn':
      return 'var(--warn)'
    case 'danger':
      return 'var(--danger)'
    case 'info':
      return 'var(--info)'
    default:
      return 'var(--accent)'
  }
}