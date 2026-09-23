/**
 * Pass / Fail buttons for the validation task. While the completion is in
 * flight both wait, and the pressed one says so (D24).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VALIDATION_RESULT } from '@/lib/taskStatus'
import { ResultButton } from './shared'

export function ValidationTaskForm({ canEdit, onComplete, busyLabel = null }: {
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
        {t('pages.tasks.validation.intro')}
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <ResultButton label={t('pages.tasks.validation.pass')} tone="success" disabled={!canEdit} busyLabel={busyLabel} pressed={pressed === VALIDATION_RESULT.PASS} onClick={() => choose(VALIDATION_RESULT.PASS)} />
        <ResultButton label={t('pages.tasks.validation.fail')} tone="danger" disabled={!canEdit} busyLabel={busyLabel} pressed={pressed === VALIDATION_RESULT.FAIL} onClick={() => choose(VALIDATION_RESULT.FAIL)} />
      </div>
    </div>
  )
}
