import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { palette } from '@/lib/tokens'
import { keyActivate } from '@/lib/a11y'
import { sortRowsBy } from '@/components/SortableFilterTable'

export interface SimpleColumn<T> {
  key:     keyof T & string
  label:   string
  width?:  string
  render?: (value: unknown, row: T) => ReactNode
  /** Numbers read right-aligned. */
  align?:  'right'
  /** A column that must not get narrower (a title that would wrap word by word). */
  minWidth?: number
  /**
   * Every column sorts (26 Sep 2026, «le colonne dovrebbero essere sempre
   * tutte ordinabili»), as in SortableFilterTable: `false` only for a column
   * of buttons.
   */
  sortable?: boolean
  /** What the column sorts on when its raw value is not it (a label, a computed number). */
  sortValue?: (row: T) => unknown
}

/**
 * Lightweight table for embedded lists (detail pages, sidebars) — the
 * hand-rolled <table> pattern with uppercase headers and hover rows.
 * For full list pages use SortableFilterTable instead.
 */
export function SimpleTable<T extends { id: string }>({ columns, rows, onRowClick, empty, label }: {
  columns:     SimpleColumn<T>[]
  rows:        T[]
  onRowClick?: (row: T) => void
  empty?:      ReactNode
  /** The table's accessible name. */
  label?:      string
}) {
  // The column sorted on, by its place (two columns may share a key), and the direction.
  const [sort, setSort] = useState<{ index: number; dir: 'asc' | 'desc' } | null>(null)
  if (rows.length === 0) return <>{empty ?? null}</>
  const sortedColumn = sort ? columns[sort.index] : undefined
  const shown = sort && sortedColumn ? sortRowsBy(rows, sortedColumn.key, sort.dir, undefined, sortedColumn.sortValue) : rows
  const toggle = (index: number) => setSort((prev) => (prev?.index === index ? { index, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { index, dir: 'asc' }))
  return (
    /*
      Dentro un contenitore che scorre (`og-scroll-x`, index.css): questa
      tabella vive nelle pagine di dettaglio, dentro una colonna che su schermo
      stretto si restringe. Senza, spingeva la pagina di lato.
    */
    <div className="og-scroll-x">
    <table aria-label={label} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
      <thead>
        <tr>
          {columns.map((c, i) => {
            const active = sort?.index === i
            return (
              <th key={`${c.key}-${String(i)}`} scope="col" aria-sort={c.sortable === false ? undefined : active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                style={{ textAlign: c.align ?? 'left', padding: '6px 8px', width: c.width }}>
                {c.sortable === false ? c.label : (
                  <button type="button" onClick={() => toggle(i)}
                    style={{ font: 'inherit', color: 'inherit', background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, textTransform: 'inherit', letterSpacing: 'inherit' }}>
                    {c.label}
                    <span aria-hidden="true" style={{ display: 'inline-flex', opacity: active ? 1 : 0.3 }}>
                      {active && sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </span>
                  </button>
                )}
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {shown.map((row) => (
          <tr
            key={row.id}
            // A click on a control inside the row (a link elsewhere, a button) is the control's, as in SortableFilterTable.
            onClick={onRowClick ? (e) => {
              const control = (e.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="switch"]')
              if (control && e.currentTarget.contains(control)) return
              onRowClick(row)
            } : undefined}
            // Clickable rows are reachable and activatable from the keyboard (E-14).
            tabIndex={onRowClick ? 0 : undefined}
            onKeyDown={onRowClick ? keyActivate(() => onRowClick(row)) : undefined}
            className={onRowClick ? 'row-opens' : undefined}
            style={{ cursor: onRowClick ? 'pointer' : undefined, borderBottom: `1px solid ${palette.neutral.borderLight}` }}
          >
            {columns.map((c) => (
              <td key={c.key} style={{ padding: '8px 8px', color: 'var(--color-slate-dark)', textAlign: c.align, minWidth: c.minWidth }}>
                {c.render ? c.render(row[c.key], row) : String(row[c.key] ?? '—')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}
