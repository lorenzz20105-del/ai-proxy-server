import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconButton, Spinner } from './Primitives.tsx'
import { Icon } from './Icon.tsx'
import { useEscape, useFocusTrap } from '../../lib/hooks.ts'

/* ---------------------------------------------------------------- */
/* Drawer (right slide-over)                                          */
/* ---------------------------------------------------------------- */

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  busy,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  busy?: boolean
}): ReactElement | null {
  const ref = useFocusTrap<HTMLDivElement>(open)
  useEscape(onClose, open)

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Panel'} ref={ref}>
        <header className="drawer__head">
          <div className="col" style={{ gap: 1, minWidth: 0 }}>
            <span className="drawer__title">{title}</span>
            {subtitle ? <span className="tiny muted truncate">{subtitle}</span> : null}
          </div>
          <span className="spacer" />
          {busy ? <Spinner /> : null}
          <IconButton label="Close panel" name="x" onClick={onClose} />
        </header>
        <div className="drawer__body">{children}</div>
        {footer ? <footer className="drawer__foot">{footer}</footer> : null}
      </aside>
    </>,
    document.body,
  )
}

/* ---------------------------------------------------------------- */
/* Modal                                                             */
/* ---------------------------------------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
}): ReactElement | null {
  const ref = useFocusTrap<HTMLDivElement>(open)
  useEscape(onClose, open)
  if (!open) return null
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" style={width ? { width: `min(${width}px, calc(100vw - 28px))` } : undefined} role="dialog" aria-modal="true" ref={ref}>
        <div className="modal__body">
          <div className="modal__title">{title}</div>
          {children}
        </div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </>,
    document.body,
  )
}

/* ---------------------------------------------------------------- */
/* Confirm dialog (promise based)                                    */
/* ---------------------------------------------------------------- */

interface ConfirmOptions {
  title: string
  text?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null)

  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => setState({ opts, resolve })),
    [],
  )

  const settle = (value: boolean): void => {
    state?.resolve(value)
    setState(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={state !== null}
        onClose={() => settle(false)}
        title={state?.opts.title ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => settle(false)}>
              {state?.opts.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={state?.opts.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
              {state?.opts.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {state?.opts.text ? <div className="modal__text">{state.opts.text}</div> : null}
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx
}

/* ---------------------------------------------------------------- */
/* Toasts                                                            */
/* ---------------------------------------------------------------- */

export type ToastKind = 'ok' | 'error' | 'warn' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  title: string
  message?: string
}

export interface ToastApi {
  success: (title: string, message?: string) => void
  error: (title: string, message?: string) => void
  warn: (title: string, message?: string) => void
  info: (title: string, message?: string) => void
  /** Shorthand for mutation results. */
  result: (ok: boolean, title: string, err?: unknown) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const ICONS: Record<ToastKind, 'checkCircle' | 'xCircle' | 'alert' | 'info'> = {
  ok: 'checkCircle',
  error: 'xCircle',
  warn: 'alert',
  info: 'info',
}

const TONE: Record<ToastKind, string> = {
  ok: 'var(--ok)',
  error: 'var(--danger)',
  warn: 'var(--warn)',
  info: 'var(--info)',
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const push = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = ++seq.current
    setItems((prev) => [...prev.slice(-4), { id, kind, title, message }])
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3800)
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (t, m) => push('ok', t, m),
      error: (t, m) => push('error', t, m),
      warn: (t, m) => push('warn', t, m),
      info: (t, m) => push('info', t, m),
      result: (ok, t, err) =>
        ok
          ? push('ok', t)
          : push('error', t, err instanceof Error ? err.message : typeof err === 'string' ? err : undefined),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toasts" role="region" aria-label="Notifications">
          {items.map((t) => (
            <div key={t.id} className={`toast toast--${t.kind}`} role="status" aria-live="polite">
              <span style={{ color: TONE[t.kind], marginTop: 1 }}>
                <Icon name={ICONS[t.kind]} size={15} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="toast__title">{t.title}</div>
                {t.message ? <div className="toast__msg">{t.message}</div> : null}
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-label="Dismiss notification"
                onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}