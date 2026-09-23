/**
 * Confirmed / Rejected buttons for the post-deploy review task. While the
 * completion is in flight both wait, and the pressed one says so (D24).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { REVIEW_RESULT } from '@/lib/taskStatus'
import { ResultButton } from './shared'

export function ReviewTaskForm({ canEdit, onComplete, busyLabel = null }: {
  canEdit: boolean
  onComplete: (result: string) => void
  /** A completion is in flight: the buttons wait (D24). */
  busyLabel?: string | null
}) {
  const { t } = useTranslation()
  const [pressed, setPressed] = useState<string | null>(null)
  const choose = (result: string) => { setPressed(result); onComplete(result) }
  return (
    <div>
      <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('pages.tasks.review.intro')}
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <ResultButton label={t('pages.tasks.review.confirmed')} tone="success" disabled={!canEdit} busyLabel={busyLabel} pressed={pressed === REVIEW_RESULT.CONFIRMED} onClick={() => choose(REVIEW_RESULT.CONFIRMED)} />
        <ResultButton label={t('pages.tasks.review.rejected')} tone="danger" disabled={!canEdit} busyLabel={busyLabel} pressed={pressed === REVIEW_RESULT.REJECTED} onClick={() => choose(REVIEW_RESULT.REJECTED)} />
      </div>
    </div>
  )
}
