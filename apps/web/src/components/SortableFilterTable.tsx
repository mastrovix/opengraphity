import { useState } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

export interface ColumnDef<T> {
  key:           keyof T
  label:         string
  sortable?:     boolean
  filterable?:   boolean
  filterType?:   'text' | 'select'
  filterOptions?: { value: string; label: string }[]
  width?:        string
  render?:       (value: unknown, row: T) => React.ReactNode
}

interface Props<T> {
  columns:      ColumnDef<T>[]
  data:         T[]
  onRowClick?:  (row: T) => void
  loading?:     boolean
  emptyMessage?: string
}

const thStyle: React.CSSProperties = {
  background:    '#f8f9fc',
  borderBottom:  '2px solid #e2e6f0',
  padding:       '8px 12px 6px',
  verticalAlign: 'top',
  textAlign:     'left',
  whiteSpace:    'nowrap',
  userSelect:    'none',
  boxSizing:     'border-box',
}

const filterInputBase: React.CSSProperties = {
  height:      28,
  fontSize:    12,
  width:       '100%',
  border:      '1px solid #e2e6f0',
  borderRadius: 4,
  padding:     '2px 6px',
  background:  'white',
  color:       '#0f1629',
  outline:     'none',
  boxSizing:   'border-box',
}

export function SortableFilterTable<T extends object>({
  columns,
  data,
  onRowClick,
  loading = false,
  emptyMessage = 'No results found',
}: Props<T>) {
  const [sortKey, setSortKey] = useState<keyof T | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filters, setFilters] = useState<Record<string, string>>({})

  const handleSort = (key: keyof T) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const handleFilter = (key: string, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }))
  }

  const getVal = (row: T, key: keyof T): unknown =>
    (row as Record<string, unknown>)[String(key)]

  // filter
  const filtered = data.filter((row) =>
    columns.every((col) => {
      if (!col.filterable) return true
      const fv = filters[String(col.key)]
      if (!fv) return true
      const cv = String(getVal(row, col.key) ?? '').toLowerCase()
      return col.filterType === 'text'
        ? cv.includes(fv.toLowerCase())
        : cv === fv
    })
  )

  // sort
  const sorted = sortKey == null
    ? filtered
    : [...filtered].sort((a, b) => {
        const av = getVal(a, sortKey)
        const bv = getVal(b, sortKey)
        if (av == null) return 1
        if (bv == null) return -1
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
        return sortDir === 'asc' ? cmp : -cmp
      })

  return (
    <div style={{ border: '1px solid #e2e6f0', borderRadius: 8, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <colgroup>
          {columns.map((col) => (
            <col key={String(col.key)} style={{ width: col.width }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {columns.map((col) => {
              const isActive = sortKey === col.key
              return (
                <th key={String(col.key)} style={thStyle}>
                  {/* Label row */}
                  <div
                    style={{
                      display:       'flex',
                      alignItems:    'center',
                      gap:           4,
                      fontSize:      11,
                      fontWeight:    600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color:         isActive ? '#4f46e5' : '#8892a4',
                      marginBottom:  col.filterable ? 4 : 0,
                      cursor:        col.sortable ? 'pointer' : 'default',
                    }}
                    onClick={() => col.sortable && handleSort(col.key)}
                  >
                    {col.label}
                    {col.sortable && (
                      <span style={{ opacity: isActive ? 1 : 0.3, color: isActive ? '#4f46e5' : '#8892a4', display: 'flex' }}>
                        {isActive && sortDir === 'asc'
                          ? <ChevronUp  size={12} />
                          : <ChevronDown size={12} />
                        }
                      </span>
                    )}
                  </div>

                  {/* Filter row */}
                  {col.filterable && (
                    col.filterType === 'select' ? (
                      <select
                        value={filters[String(col.key)] ?? ''}
                        onChange={(e) => handleFilter(String(col.key), e.target.value)}
                        style={{ ...filterInputBase, cursor: 'pointer', appearance: 'auto' }}
                      >
                        <option value="">All</option>
                        {col.filterOptions?.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={filters[String(col.key)] ?? ''}
                        onChange={(e) => handleFilter(String(col.key), e.target.value)}
                        placeholder="Filter…"
                        style={filterInputBase}
                      />
                    )
                  )}
                </th>
              )
            })}
          </tr>
        </thead>

        <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={String(col.key)} style={{ padding: '12px', borderBottom: '1px solid #f1f3f9' }}>
                    <div style={{ height: 14, background: '#f1f3f9', borderRadius: 4, width: '75%' }} />
                  </td>
                ))}
              </tr>
            ))
          ) : sorted.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{ textAlign: 'center', color: '#8892a4', padding: '40px 20px', fontSize: 13 }}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sorted.map((row, i) => {
              const rowId = String((row as Record<string, unknown>)['id'] ?? i)
              return (
                <tr
                  key={rowId}
                  onClick={() => onRowClick?.(row)}
                  style={{
                    borderBottom:    '1px solid #f1f3f9',
                    cursor:          onRowClick ? 'pointer' : 'default',
                    backgroundColor: 'white',
                    transition:      'background 100ms',
                  }}
                  onMouseEnter={(e) => {
                    if (onRowClick) (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f5f7ff'
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'white'
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={String(col.key)}
                      style={{ padding: '11px 12px', verticalAlign: 'middle' }}
                    >
                      {col.render
                        ? col.render(getVal(row, col.key), row)
                        : <span style={{ fontSize: 13, color: '#0f1629' }}>{String(getVal(row, col.key) ?? '')}</span>
                      }
                    </td>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
