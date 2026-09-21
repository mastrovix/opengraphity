/**
 * Single "Conferma Deploy" button for the deployment task.
 */
import { useTranslation } from 'react-i18next'
import { colors } from '@/lib/tokens'

export function DeploymentTaskForm({ canEdit, onComplete }: {
  canEdit: boolean
  onComplete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('changeTasks.deployConfirmHint')}
      </p>
      <button
        type="button" disabled={!canEdit} onClick={onComplete}
        style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: colors.white, fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}
      >
        {t('changeTasks.deployConfirm')}
      </button>
    </div>
  )
}
