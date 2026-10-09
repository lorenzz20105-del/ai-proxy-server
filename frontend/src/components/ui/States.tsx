import type { ReactElement, ReactNode } from 'react'
import { Button } from './Primitives.tsx'
import { Icon } from './Icon.tsx'
import type { IconName } from './Icon.tsx'
import { errorMessage } from '../../lib/api.ts'

export function Skeleton({ height = 12, width = '100%', radius = 5, style }: { height?: number | string; width?: number | string; radius?: number; style?: React.CSSProperties }): ReactElement {
  return <div className="skeleton" style={{ height, width, borderRadius: radius, ...style }} />
}

export function SkeletonTiles({ count = 8, height = 76 }: { count?: number; height?: number }): ReactElement {
  return (
    <div className="kpis">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={height} radius={10} />
      ))}
    </div>
  )
}

export function SkeletonRows({ rows = 6, height = 32 }: { rows?: number; height?: number }): ReactElement {
  return (
    <div className="col" style={{ gap: 7, padding: 4 }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} />
      ))}
    </div>
  )
}

export function EmptyState({
  icon = 'info',
  title,
  text,
  action,
}: {
  icon?: IconName
  title: string
  text?: ReactNode
  action?: ReactNode
}): ReactElement {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={17} />
      </div>
      <div className="empty__title">{title}</div>
      {text ? <div className="empty__text">{text}</div> : null}
      {action}
    </div>
  )
}

export function ErrorState({
  error,
  onRetry,
  title = 'Request failed',
  compact,
}: {
  error: unknown
  onRetry?: () => void
  title?: string
  compact?: boolean
}): ReactElement {
  return (
    <div className="error-state" role="alert" style={compact ? { padding: 12 } : undefined}>
      <div className="row" style={{ gap: 8 }}>
        <Icon name="alert" size={15} />
        <span className="error-state__title">{title}</span>
        <span className="spacer" />
        {onRetry ? (
          <Button size="sm" icon="refresh" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
      <div className="error-state__detail">{errorMessage(error)}</div>
    </div>
  )
}

/** Full-page loading / error / empty gate used by every data screen. */
export function AsyncGate<T>({
  state,
  skeleton,
  isEmpty,
  empty,
  children,
}: {
  state: { data: T | null; error: Error | null; loading: boolean; initial: boolean; reload: () => void }
  skeleton: ReactNode
  isEmpty?: (data: T) => boolean
  empty?: ReactNode
  children: (data: T) => ReactNode
}): ReactElement {
  if (state.initial && state.loading) return <>{skeleton}</>
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.reload} />
  if (!state.data) return <>{skeleton}</>
  if (isEmpty && isEmpty(state.data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>
  return <>{children(state.data)}</>
}