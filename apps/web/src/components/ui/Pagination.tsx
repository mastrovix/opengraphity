interface PaginationProps {
  currentPage: number
  totalPages: number
  onPrev: () => void
  onNext: () => void
}

const btnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '4px 12px',
  fontSize: 'var(--font-size-body)',
  border: '1px solid #e5e7eb',
  borderRadius: 4,
  background: disabled ? '#f9fafb' : '#fff',
  color: disabled ? '#c4c9d4' : 'var(--color-slate)',
  cursor: disabled ? 'not-allowed' : 'pointer',
})

export function Pagination({ currentPage, totalPages, onPrev, onNext }: PaginationProps) {
  if (totalPages <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
      <button disabled={currentPage <= 1} onClick={onPrev} style={btnStyle(currentPage <= 1)}>
        Prev
      </button>
      <span style={{ padding: '4px 8px' }}>
        {currentPage} / {totalPages}
      </span>
      <button disabled={currentPage >= totalPages} onClick={onNext} style={btnStyle(currentPage >= totalPages)}>
        Next
      </button>
    </div>
  )
}
