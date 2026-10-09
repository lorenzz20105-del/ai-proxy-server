import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Icon } from './Icon.tsx'

/* ---------------------------------------------------------------- */
/* Text / number / select / textarea                                 */
/* ---------------------------------------------------------------- */

export function Field({
  label,
  hint,
  optional,
  error,
  children,
  htmlFor,
}: {
  label?: ReactNode
  hint?: ReactNode
  optional?: boolean
  error?: string
  children: ReactNode
  htmlFor?: string
}): ReactElement {
  return (
    <div className="field">
      {label ? (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {optional ? <span className="label__opt">optional</span> : null}
        </label>
      ) : null}
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

export interface TextFieldProps {
  label?: ReactNode
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: ReactNode
  error?: string
  type?: 'text' | 'password' | 'url'
  mono?: boolean
  disabled?: boolean
  autoComplete?: string
  id?: string
  optional?: boolean
  onEnter?: () => void
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  type = 'text',
  mono,
  disabled,
  autoComplete,
  id,
  optional,
  onEnter,
}: TextFieldProps): ReactElement {
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={id}>
      <input
        id={id}
        className={`input${mono ? ' input--mono' : ''}${error ? ' input--invalid' : ''}`}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete ?? (type === 'password' ? 'off' : 'on')}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault()
            onEnter()
          }
        }}
      />
    </Field>
  )
}

/** Password field with a reveal toggle (used for account secrets). */
export function SecretField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  id,
}: {
  label?: ReactNode
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: ReactNode
  id?: string
}): ReactElement {
  const [shown, setShown] = useState(false)
  return (
    <Field label={label} hint={hint} optional htmlFor={id}>
      <div className="input-group">
        <input
          id={id}
          className="input input--mono"
          type={shown ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label={shown ? 'Hide value' : 'Show value'}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} size={14} />
        </button>
      </div>
    </Field>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  hint,
  placeholder,
  nullable,
  disabled,
  id,
}: {
  label?: ReactNode
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  hint?: ReactNode
  placeholder?: string
  /** Allow an empty value that maps to JSON null. */
  nullable?: boolean
  disabled?: boolean
  id?: string
}): ReactElement {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value))
  useEffect(() => {
    setText(value === null || value === undefined ? '' : String(value))
  }, [value])

  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        className="input input--mono"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder ?? (nullable ? 'null' : undefined)}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          if (raw === '') {
            onChange(nullable ? null : min ?? 0)
            return
          }
          const n = Number(raw)
          if (Number.isFinite(n)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)))
        }}
      />
    </Field>
  )
}

export interface Option {
  value: string
  label: string
  disabled?: boolean
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  id,
  disabled,
  placeholder,
}: {
  label?: ReactNode
  value: string
  onChange: (v: string) => void
  options: Option[]
  hint?: ReactNode
  id?: string
  disabled?: boolean
  placeholder?: string
}): ReactElement {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function TextAreaField({
  label,
  value,
  onChange,
  rows = 3,
  hint,
  placeholder,
  id,
  mono,
}: {
  label?: ReactNode
  value: string
  onChange: (v: string) => void
  rows?: number
  hint?: ReactNode
  placeholder?: string
  id?: string
  mono?: boolean
}): ReactElement {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <textarea
        id={id}
        className={`textarea${mono ? ' input--mono' : ''}`}
        rows={rows}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

/* ---------------------------------------------------------------- */
/* Tag list (models[], allow/deny lists)                              */
/* ---------------------------------------------------------------- */

export function TagInput({
  label,
  values,
  onChange,
  placeholder = 'type and press Enter',
  hint,
  disabled,
}: {
  label?: ReactNode
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  hint?: ReactNode
  disabled?: boolean
}): ReactElement {
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    const parts = draft
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!parts.length) return
    const next = [...values]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setDraft('')
  }

  return (
    <Field label={label} hint={hint}>
      <div className="tag-input" style={disabled ? { opacity: 0.5 } : undefined}>
        {values.map((v) => (
          <span className="tag" key={v}>
            {v}
            {!disabled && (
              <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input
            value={draft}
            placeholder={values.length ? '' : placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Backspace' && !draft && values.length) {
                onChange(values.slice(0, -1))
              }
            }}
            aria-label="Add entry"
          />
        )}
      </div>
    </Field>
  )
}

/* ---------------------------------------------------------------- */
/* Key/value header editor (extra_headers)                            */
/* ---------------------------------------------------------------- */

export function HeaderEditor({
  value,
  onChange,
}: {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}): ReactElement {
  const entries = Object.entries(value)
  const setAt = (i: number, k: string, v: string): void => {
    const next = entries.map((e, idx) => (idx === i ? [k, v] : e))
    onChange(Object.fromEntries(next.filter(([key]) => key.trim() !== '')))
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      {entries.map(([k, v], i) => (
        <div className="row" key={i} style={{ gap: 6 }}>
          <input
            className="input input--mono"
            value={k}
            placeholder="Header-Name"
            aria-label="Header name"
            onChange={(e) => setAt(i, e.target.value, v)}
          />
          <input
            className="input input--mono"
            value={v}
            placeholder="value"
            aria-label={`Value for ${k || 'header'}`}
            onChange={(e) => setAt(i, k, e.target.value)}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={`Remove header ${k}`}
            onClick={() => onChange(Object.fromEntries(entries.filter((_, idx) => idx !== i)))}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => onChange({ ...value, '': '' })}
      >
        <Icon name="plus" size={12} /> Add header
      </button>
    </div>
  )
}

/* ---------------------------------------------------------------- */
/* Slider (temperature / top_p)                                       */
/* ---------------------------------------------------------------- */

export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  format,
  disabled,
}: {
  label: ReactNode
  value: number | null
  onChange: (v: number | null) => void
  min: number
  max: number
  step: number
  hint?: ReactNode
  format?: (v: number) => string
  disabled?: boolean
}): ReactElement {
  const v = value ?? min
  return (
    <Field
      label={
        <span className="row row--between" style={{ width: '100%' }}>
          <span>{label}</span>
          <span className="nums tiny" style={{ color: 'var(--text)' }}>
            {format ? format(v) : v}
          </span>
        </span>
      }
      hint={hint}
    >
      <div className="row" style={{ gap: 8 }}>
        <input
          className="range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          disabled={disabled}
          aria-label={typeof label === 'string' ? label : 'slider'}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={value === null || disabled}
          onClick={() => onChange(null)}
          title="Send as provider default"
        >
          auto
        </button>
      </div>
    </Field>
  )
}