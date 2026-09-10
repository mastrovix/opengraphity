import type { ReactNode } from 'react'
import { palette } from '@/lib/tokens'

export interface SimpleColumn<T> {
  key:     keyof T & string
  label:   string
  width?:  string
  render?: (value: unknown, row: T) => ReactNode
}

/**
 * Lightweight table for embedded lists (detail pages, sidebars) — the
 * hand-rolled <table> pattern with uppercase headers and hover rows.
 * For full list pages use SortableFilterTable instead.
 */
export function SimpleTable<T extends { id: string }>({ columns, rows, onRowClick, empty }: {
  columns:     SimpleColumn<T>[]
  rows:        T[]
  onRowClick?: (row: T) => void
  empty?:      ReactNode
}) {
  if (rows.length === 0) return <>{empty ?? null}</>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          {columns.map((c) => (
            <th key={c.key} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', textTransform: 'uppercase', letterSpacing: '0.04em', width: c.width }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            // Clickable rows are reachable and activatable from the keyboard (E-14).
            tabIndex={onRowClick ? 0 : undefined}
            onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row) } } : undefined}
            className={onRowClick ? 'hover-bg' : undefined}
            style={{ cursor: onRowClick ? 'pointer' : undefined, borderBottom: `1px solid ${palette.neutral.borderLight}` }}
          >
            {columns.map((c) => (
              <td key={c.key} style={{ padding: '8px 8px', color: 'var(--color-slate-dark)' }}>
                {c.render ? c.render(row[c.key], row) : String(row[c.key] ?? '—')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
