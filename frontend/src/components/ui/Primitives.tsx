import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
import { Icon } from './Icon.tsx'
import type { IconName } from './Icon.tsx'
import type { Tone } from '../../lib/format.ts'

/* ---------------------------------------------------------------- */
/* Button                                                            */
/* ---------------------------------------------------------------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
  icon?: IconName
  iconRight?: IconName
  loading?: boolean
  block?: boolean
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  iconRight,
  loading,
  block,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): ReactElement {
  const cls = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    className || '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 14} /> : null}
      {children}
      {iconRight && !loading ? <Icon name={iconRight} size={size === 'sm' ? 13 : 14} /> : null}
    </button>
  )
}

export function IconButton({
  label,
  name,
  onClick,
  pressed,
  disabled,
  size = 15,
  tone,
  className,
}: {
  label: string
  name: IconName
  onClick?: () => void
  pressed?: boolean
  disabled?: boolean
  size?: number
  tone?: Tone
  className?: string
}): ReactElement {
  const color =
    tone === 'danger'
      ? 'var(--danger)'
      : tone === 'ok'
        ? 'var(--ok)'
        : tone === 'warn'
          ? 'var(--warn)'
          : undefined
  return (
    <button
      type="button"
      className={`icon-btn${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      style={color ? { color } : undefined}
    >
      <Icon name={name} size={size} />
    </button>
  )
}

export function Spinner({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block', animation: 'spin 0.7s linear infinite' }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/* ---------------------------------------------------------------- */
/* Badge / Pill                                                      */
/* ---------------------------------------------------------------- */

export function Badge({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }): ReactElement {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  )
}

export function StatusPill({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }): ReactElement {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      {dot && <span className={`dot dot--${tone === 'accent' ? 'ok' : tone}`} />}
      {children}
    </span>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  ariaLabel,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: ReactNode
  disabled?: boolean
  ariaLabel?: string
}): ReactElement {
  return (
    <label className="switch" style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track" />
      {label ? <span className="switch__label">{label}</span> : null}
    </label>
  )
}

/* ---------------------------------------------------------------- */
/* Layout primitives                                                 */
/* ---------------------------------------------------------------- */

export function Card({
  title,
  hint,
  actions,
  children,
  footer,
  flush,
  className,
  tight,
  style,
}: {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
  flush?: boolean
  tight?: boolean
  className?: string
  style?: React.CSSProperties
}): ReactElement {
  return (
    <section className={`card${className ? ` ${className}` : ''}`} style={style}>
      {(title || actions) && (
        <header className="card__head">
          <div className="col" style={{ gap: 1, minWidth: 0 }}>
            {title ? <h3 className="card__title">{title}</h3> : null}
            {hint ? <span className="card__hint">{hint}</span> : null}
          </div>
          {actions ? <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>{actions}</div> : null}
        </header>
      )}
      <div className={`card__body${flush ? ' card__body--flush' : ''}${tight ? ' card__body--tight' : ''}`}>{children}</div>
      {footer ? <div className="card__foot">{footer}</div> : null}
    </section>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}): ReactElement {
  return (
    <div className="page__head">
      <div>
        <h1 className="page__title">{title}</h1>
        {subtitle ? <div className="page__sub">{subtitle}</div> : null}
      </div>
      {actions ? <div className="row row--wrap" style={{ gap: 8 }}>{actions}</div> : null}
    </div>
  )
}

export function SectionTitle({ children }: { children: ReactNode }): ReactElement {
  return <div className="section-title">{children}</div>
}

export function Alert({
  tone = 'info',
  icon,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger'
  icon?: IconName
  children: ReactNode
}): ReactElement {
  const ic: IconName = icon ?? (tone === 'danger' ? 'alert' : tone === 'warn' ? 'alert' : 'info')
  return (
    <div className={`alert alert--${tone}`}>
      <span className="alert__icon">
        <Icon name={ic} size={14} />
      </span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  )
}

export function KeyValue({ items }: { items: [string, ReactNode][] }): ReactElement {
  return (
    <div className="kv">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <div className="kv__k">{k}</div>
          <div className="kv__v">{v}</div>
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- */
/* Code + secrets                                                    */
/* ---------------------------------------------------------------- */

export function CodeBlock({ value, tall }: { value: string; tall?: boolean }): ReactElement {
  return <pre className={`code-block${tall ? ' code-block--tall' : ''}`}>{value}</pre>
}

export function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
  variant = 'ghost',
}: {
  value: string
  label?: string
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'default'
}): ReactElement {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), [])
  return (
    <Button
      size={size}
      variant={variant}
      icon={copied ? 'check' : 'copy'}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true)
            if (timer.current) window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setCopied(false), 1400)
          })
          .catch(() => {
            /* clipboard unavailable — value is selectable on screen */
          })
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}