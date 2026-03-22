import { ChevronUp, ChevronDown } from 'lucide-react'
import { colors } from '@/lib/tokens'

interface SortableHeaderProps<T> {
  label:       string
  sortKey:     T
  currentKey:  T
  currentDir:  'asc' | 'desc'
  onSort:      (key: T) => void
}

export function SortableHeader<T>({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
}: SortableHeaderProps<T>) {
  const isActive = sortKey === currentKey

  return (
    <button
      onClick={() => onSort(sortKey)}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        gap:            4,
        background:     'none',
        border:         'none',
        padding:        0,
        cursor:         'pointer',
        fontSize:       11,
        fontWeight:     500,
        color:          isActive ? colors.brand : colors.slateLight,
        textTransform:  'uppercase',
        letterSpacing:  '0.5px',
        whiteSpace:     'nowrap',
      }}
    >
      {label}
      <span style={{ opacity: isActive ? 1 : 0.35, color: isActive ? colors.brand : colors.slateLight }}>
        {isActive && currentDir === 'asc'
          ? <ChevronUp  size={12} />
          : <ChevronDown size={12} />
        }
      </span>
    </button>
  )
}
