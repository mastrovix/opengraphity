/**
 * Read-only modal showing the scheduled deploy plan steps for one CI.
 */
import type { DeployStep } from '@/types/change'
import { useTranslation } from 'react-i18next'
import { ModalOverlay } from './shared'
import { formatDateTime } from '@/lib/datetime'

export function PlanModal({ steps, ciName, onClose }: {
  steps: DeployStep[]
  ciName: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <ModalOverlay title={t('pages.planModal.title', { ci: ciName })} onClose={onClose}>
      {steps.map((s, i) => (
        <div key={i} style={{ padding: '10px 0', borderBottom: i < steps.length - 1 ? '1px solid var(--color-border-light)' : 'none' }}>
          <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 4 }}>{t('changeTasks.stepNTitle', { n: i + 1, title: s.title })}</div>
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
            {t('changeTasks.validationWindow', { start: formatDateTime(s.validationWindow.start), end: formatDateTime(s.validationWindow.end) })}
          </div>
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
            {t('changeTasks.releaseWindow', { start: formatDateTime(s.releaseWindow.start), end: formatDateTime(s.releaseWindow.end) })}
          </div>
        </div>
      ))}
      {steps.length === 0 && <p style={{ color: 'var(--color-slate-light)', margin: 0 }}>{t('pages.planModal.empty')}</p>}
    </ModalOverlay>
  )
}
