import { Fragment, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Icon } from './Icon.tsx'

export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: string
  dir: SortDir
}

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T, index: number) => ReactNode
  /** Value used for sorting; omit to disable sorting on this column. */
  sortValue?: (row: T) => number | string
  align?: 'left' | 'right'
  width?: number | string
  /** Header shown when the table collapses into stacked cards. */
  label?: string
  className?: string
  actions?: boolean
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowClick,
  selectedKey,
  renderExpanded,
  empty,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  sort?: SortState
  onSort?: (s: SortState) => void
  onRowClick?: (row: T) => void
  selectedKey?: string | null
  renderExpanded?: (row: T) => ReactNode
  empty?: ReactNode
}): ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null)

  /** Expand when a renderer is supplied, otherwise hand the row to onRowClick. */
  const activate = (row: T, key: string, isOpen: boolean): void => {
    if (renderExpanded) setExpanded(isOpen ? null : key)
    else onRowClick?.(row)
  }

  const toggleSort = (col: Column<T>): void => {
    if (!onSort || !col.sortValue) return
    onSort({ key: col.key, dir: sort && sort.key === col.key && sort.dir === 'desc' ? 'asc' : 'desc' })
  }

  if (!rows.length && empty) return <>{empty}</>

  return (
    <div className="table-wrap">
      <table className="table table--stack">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  width: col.width,
                  textAlign: col.align === 'right' ? 'right' : 'left',
                  cursor: col.sortValue && onSort ? 'pointer' : undefined,
                }}
                aria-sort={sort?.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                onClick={() => toggleSort(col)}
              >
                <span className="sortable-header">
                  {col.header}
                  {col.sortValue && onSort ? (
                    <Icon
                      name={sort?.key === col.key ? (sort.dir === 'asc' ? 'chevronUp' : 'chevronDown') : 'dots'}
                      size={11}
                      className={sort?.key === col.key ? undefined : 'faint'}
                    />
                  ) : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey(row, i)
            const isOpen = expanded === key
            return (
              <Fragment key={key}>
                <tr
                  className={`${onRowClick || renderExpanded ? 'is-clickable' : ''}${selectedKey === key ? ' is-selected' : ''}`}
                  onClick={(e) => {
                    // never hijack clicks that came from a control inside the row
                    if ((e.target as HTMLElement).closest('button,a,input,select,textarea,label')) return
                    activate(row, key, isOpen)
                  }}
                  tabIndex={onRowClick || renderExpanded ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (onRowClick || renderExpanded)) {
                      e.preventDefault()
                      activate(row, key, isOpen)
                    }
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      data-label={col.label ?? (typeof col.header === 'string' ? col.header : '')}
                      className={`${col.actions ? 'col-actions' : ''} ${col.className || ''}`}
                      style={{ textAlign: col.align === 'right' ? 'right' : 'left' }}
                    >
                      {col.cell(row, i)}
                    </td>
                  ))}
                </tr>
                {isOpen && renderExpanded ? (
                  <tr className="table__expanded">
                    <td colSpan={columns.length}>
                      <div className="table__expanded-inner">{renderExpanded(row)}</div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Local sort state + memoised sorted rows. */
export function useSortedRows<T>(
  rows: T[],
  columns: Column<T>[],
  initial: SortState | null = null,
): [T[], SortState | null, (s: SortState) => void] {
  const [sort, setSort] = useState<SortState | null>(initial)
  const colMap = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = colMap.get(sort.key)
    if (!col?.sortValue) return rows
    const get = col.sortValue
    return [...rows].sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true })
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, sort, colMap])

  return [sorted, sort, setSort]
}

/** Inline magnitude bar for table cells. */
export function BarCell({ value, max, tone, format }: { value: number; max: number; tone?: 'ok' | 'warn' | 'danger'; format?: (n: number) => string }): ReactElement {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="bar-cell">
      <div className="bar" style={{ flex: 1 }}>
        <div className={`bar__fill${tone ? ` bar__fill--${tone}` : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-cell__value">{format ? format(value) : value.toLocaleString()}</span>
    </div>
  )
}