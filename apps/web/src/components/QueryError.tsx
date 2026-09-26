import { Button } from '@/components/Button'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { colors, palette } from '@/lib/tokens'
import { currentLocale } from '@/lib/datetime'

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
        <Button variant="secondary"
          onClick={onRetry}
          style={{ marginTop: 6 }}
        >
          <RotateCw size={13} />
          {t('queryError.retry')}
        </Button>
      )}
    </div>
  )
}

interface StaleProps {
  /** The error of the latest read. */
  message: string
  /** When the data shown was read (ms since the epoch); unknown → the banner says it may be out of date. */
  readAt?: number | null
  onRetry?: () => void
}

/**
 * The latest read failed but older data is still on screen (review of
 * 23 Sep 2026). Apollo keeps the previous result when a poll or a refetch
 * fails, and pages that showed the error only «when there is no data» went on
 * showing green dots and old rows as if they were current. This says it,
 * above the data, instead of replacing it.
 */
export function StaleDataBanner({ message, readAt, onRetry }: StaleProps) {
  const { t } = useTranslation()
  const text = readAt
    ? t('queryError.stale', { message, time: new Date(readAt).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })
    : t('queryError.staleNoTime', { message })
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginBottom: 12, background: palette.warning.bg, border: `1px solid ${palette.warning.border}`, borderRadius: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
      <AlertTriangle size={16} color={palette.warning.strong} aria-hidden="true" />
      <span style={{ flex: 1, wordBreak: 'break-word' }}>{text}</span>
      {onRetry && (
        <Button variant="secondary" size="xs"
          onClick={onRetry}
        >
          <RotateCw size={13} aria-hidden="true" />
          {t('queryError.retry')}
        </Button>
      )}
    </div>
  )
}

