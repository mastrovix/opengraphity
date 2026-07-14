import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCw } from 'lucide-react'

interface Props {
  /** Error message shown under the title (optional, technical) */
  message?: string
  /** Called by the retry button — pass the query's refetch */
  onRetry?: () => void
}

/**
 * Inline error state for failed queries. Use next to loading/empty states:
 *   const { data, loading, error, refetch } = useQuery(...)
 *   if (error) return <QueryError message={error.message} onRetry={() => void refetch()} />
 */
export function QueryError({ message, onRetry }: Props) {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '40px 20px', backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, textAlign: 'center' }}>
      <AlertTriangle size={28} color="var(--color-danger, #ef4444)" />
      <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
        {t('queryError.title')}
      </div>
      {message && (
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', maxWidth: 480, wordBreak: 'break-word' }}>
          {message}
        </div>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '7px 16px', backgroundColor: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)' }}
        >
          <RotateCw size={13} />
          {t('queryError.retry')}
        </button>
      )}
    </div>
  )
}
