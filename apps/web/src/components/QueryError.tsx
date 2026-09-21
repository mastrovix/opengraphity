import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { colors, palette } from '@/lib/tokens'

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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '40px 20px', backgroundColor: colors.white, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}>
      <AlertTriangle size={28} color={colors.danger} />
      <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
        {t('queryError.title')}
      </div>
      {message && (
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', maxWidth: 480, wordBreak: 'break-word' }}>
          {message}
        </div>
      )}
      {onRetry && (
        <button type="button"
          onClick={onRetry}
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '7px 16px', backgroundColor: colors.white, border: `1px solid ${palette.neutral.borderStrong}`, borderRadius: 6, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)' }}
        >
          <RotateCw size={13} />
          {t('queryError.retry')}
        </button>
      )}
    </div>
  )
}
