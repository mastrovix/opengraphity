/**
 * Single "Conferma Deploy" button for the deployment task. While the
 * completion is in flight it waits and says so (D24).
 */
import { useTranslation } from 'react-i18next'
import { ResultButton } from './shared'

export function DeploymentTaskForm({ canEdit, onComplete, busyLabel = null }: {
  canEdit: boolean
  onComplete: () => void
  /** A completion is in flight: the button waits (D24). */
  busyLabel?: string | null
}) {
  const { t } = useTranslation()
  return (
    <div>
      <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        {t('changeTasks.deployConfirmHint')}
      </p>
      <ResultButton label={t('changeTasks.deployConfirm')} tone="success" disabled={!canEdit} busyLabel={busyLabel} pressed onClick={onComplete} />
    </div>
  )
}
