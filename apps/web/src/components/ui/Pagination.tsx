import { useTranslation } from 'react-i18next'

interface PaginationProps {
  currentPage: number
  totalPages: number
  onPrev: () => void
  onNext: () => void
}

const btnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '4px 12px',
  fontSize: 'var(--font-size-body)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: disabled ? 'var(--color-slate-bg)' : '#fff',
  color: disabled ? '#c4c9d4' : 'var(--color-slate)',
  cursor: disabled ? 'not-allowed' : 'pointer',
})

export function Pagination({ currentPage, totalPages, onPrev, onNext }: PaginationProps) {
  const { t } = useTranslation()
  if (totalPages <= 1) return null
  const prevDisabled = currentPage <= 1
  const nextDisabled = currentPage >= totalPages
  return (
    <nav aria-label={t('pagination.label')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
      <button type="button" disabled={prevDisabled} onClick={onPrev} style={btnStyle(prevDisabled)}>
        {t('common.prev')}
      </button>
      <span style={{ padding: '4px 8px' }} aria-current="page">
        {currentPage} / {totalPages}
      </span>
      <button type="button" disabled={nextDisabled} onClick={onNext} style={btnStyle(nextDisabled)}>
        {t('common.next')}
      </button>
    </nav>
  )
}
