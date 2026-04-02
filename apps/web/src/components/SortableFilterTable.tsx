import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { SkeletonLine } from '@/components/SkeletonLoader'
import { colors } from '@/lib/tokens'

export interface ColumnDef<T> {
  key:      keyof T
  label:    string
  sortable?: boolean
  width?:   string
  render?:  (value: unknown, row: T) => React.ReactNode
}

interface Props<T> {
  columns:         ColumnDef<T>[]
  data:            T[]
  onRowClick?:     (row: T) => void
  loading?:        boolean
  emptyMessage?:   string
  emptyComponent?: React.ReactNode
  /** Server-side sort: when provided, sorting is delegated to the caller */
  onSort?:         (field: string, direction: 'asc' | 'desc') => void
  sortField?:      string | null
  sortDir?:        'asc' | 'desc'
}

const thStyle: React.CSSProperties = {
  background:    '#f9fafb',
  borderBottom:  `2px solid ${colors.border}`,
  padding:       '8px 12px 6px',
  textAlign:     'left',
  whiteSpace:    'nowrap',
  userSelect:    'none',
  boxSizing:     'border-box',
}

export function SortableFilterTable<T extends object>({
  columns,
  data,
  onRowClick,
  loading = false,
  emptyMessage,
  emptyComponent,
  onSort,
  sortField: controlledSortField,
  sortDir: controlledSortDir,
}: Props<T>) {
  const { t } = useTranslation()
  const resolvedEmptyMessage = emptyMessage ?? t('common.noResults')

  // Uncontrolled (client-side) sort state — only used when onSort is not provided
  const [localSortKey, setLocalSortKey] = useState<keyof T | null>(null)
  const [localSortDir, setLocalSortDir] = useState<'asc' | 'desc'>('asc')

  const isControlled = onSort != null
  const activeSortKey = isControlled ? controlledSortField ?? null : localSortKey ? String(localSortKey) : null
  const activeSortDir = isControlled ? (controlledSortDir ?? 'asc') : localSortDir

  const handleSort = (key: keyof T) => {
    const keyStr = String(key)
    if (isControlled) {
      const newDir = activeSortKey === keyStr && activeSortDir === 'asc' ? 'desc' : 'asc'
      onSort(keyStr, newDir)
    } else {
      if (localSortKey === key) {
        setLocalSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setLocalSortKey(key)
        setLocalSortDir('asc')
      }
    }
  }

  const getRawVal = (row: T, key: keyof T): unknown =>
    (row as Record<string, unknown>)[String(key)]

  const getSortVal = (row: T, key: keyof T): unknown => {
    const v = getRawVal(row, key)
    if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v)
      return (v as { name: string }).name
    return v
  }

  // Only sort client-side when in uncontrolled mode
  const sorted = isControlled || localSortKey == null
    ? data
    : [...data].sort((a, b) => {
        const av = getSortVal(a, localSortKey)
        const bv = getSortVal(b, localSortKey)
        if (av == null) return 1
        if (bv == null) return -1
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
        return localSortDir === 'asc' ? cmp : -cmp
      })

  return (
    <div className="card-border" style={{ overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <colgroup>
          {columns.map((col) => (
            <col key={String(col.key)} style={{ width: col.width }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {columns.map((col) => {
              const isActive = activeSortKey === String(col.key)
              return (
                <th key={String(col.key)} style={thStyle}>
                  <div
                    style={{
                      display:       'flex',
                      alignItems:    'center',
                      gap:           4,
                      fontSize:      11,
                      fontWeight:    500,
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      color:         isActive ? colors.brand : colors.slateDark,
                      cursor:        col.sortable ? 'pointer' : 'default',
                    }}
                    onClick={() => col.sortable && handleSort(col.key)}
                  >
                    {col.label}
                    {col.sortable && (
                      <span style={{ opacity: isActive ? 1 : 0.3, color: isActive ? colors.brand : colors.slateDark, display: 'flex' }}>
                        {isActive && activeSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </span>
                    )}
                  </div>
                </th>
              )
            })}
          </tr>
        </thead>

        <tbody>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                {columns.map((col, ci) => (
                  <td key={String(col.key)} style={{ padding: '12px', borderBottom: '1px solid #f1f3f9' }}>
                    <SkeletonLine width={ci === 0 ? '80%' : ci % 2 === 0 ? '60%' : '70%'} />
                  </td>
                ))}
              </tr>
            ))
          ) : sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                {emptyComponent ?? (
                  <div style={{ textAlign: 'center', color: colors.slateLight, padding: '40px 20px', fontSize: 12 }}>
                    {resolvedEmptyMessage}
                  </div>
                )}
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
                    backgroundColor: colors.white,
                    transition:      'background-color 0.15s, color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#3d4856'
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.backgroundColor = colors.white
                  }}
                >
                  {columns.map((col) => (
                    <td
                      key={String(col.key)}
                      className="sft-td"
                      style={{ padding: '11px 12px', verticalAlign: 'middle' }}
                    >
                      {col.render
                        ? col.render(getRawVal(row, col.key), row)
                        : String(getRawVal(row, col.key) ?? '')
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
