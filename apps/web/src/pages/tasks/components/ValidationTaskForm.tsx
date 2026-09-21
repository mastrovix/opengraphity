/**
 * Pass / Fail buttons for the validation task.
 */
import { useTranslation } from 'react-i18next'
import { VALIDATION_RESULT } from '@/lib/taskStatus'
import { colors } from '@/lib/tokens'

export function ValidationTaskForm({ canEdit, onComplete }: {
  canEdit: boolean
  onComplete: (result: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('pages.tasks.validation.intro')}
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="button" disabled={!canEdit} onClick={() => onComplete(VALIDATION_RESULT.PASS)} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: colors.white, fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>{t('pages.tasks.validation.pass')}</button>
        <button type="button" disabled={!canEdit} onClick={() => onComplete(VALIDATION_RESULT.FAIL)} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-danger)', color: colors.white, fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>{t('pages.tasks.validation.fail')}</button>
      </div>
    </div>
  )
}
