/**
 * Confirmed / Rejected buttons for the post-deploy review task.
 */
import { useTranslation } from 'react-i18next'
import { REVIEW_RESULT } from '@/lib/taskStatus'
import { colors } from '@/lib/tokens'

export function ReviewTaskForm({ canEdit, onComplete }: {
  canEdit: boolean
  onComplete: (result: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('pages.tasks.review.intro')}
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="button" disabled={!canEdit} onClick={() => onComplete(REVIEW_RESULT.CONFIRMED)} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: colors.white, fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>{t('pages.tasks.review.confirmed')}</button>
        <button type="button" disabled={!canEdit} onClick={() => onComplete(REVIEW_RESULT.REJECTED)} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-danger)', color: colors.white, fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>{t('pages.tasks.review.rejected')}</button>
      </div>
    </div>
  )
}
