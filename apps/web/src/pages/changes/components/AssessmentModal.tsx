/**
 * Read-only modal showing the assessment responses for a single role
 * (functional / technical) on a single CI.
 */
import { useTranslation } from 'react-i18next'
import type { AssessmentTaskData } from '@/types/change'
import { ModalOverlay } from './shared'
import { colors } from '@/lib/tokens'

export function AssessmentModal({ task, ciName, roleLabel, bothAssessDone, onClose }: {
  task: AssessmentTaskData
  ciName: string
  roleLabel: string
  bothAssessDone: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <ModalOverlay title={t('pages.changes.assessment.answersTitle', { role: roleLabel, ci: ciName })} onClose={onClose}>
      {!bothAssessDone ? (
        <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: '16px 0' }}>
          {t('pages.changes.assessment.hiddenUntilBoth')}
        </p>
      ) : (
        <>
          {task.responses.map((r, i) => (
            <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border-light)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', flex: 1 }}>{r.question.text}</span>
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 4, backgroundColor: colors.slateBg, color: 'var(--color-slate)', whiteSpace: 'nowrap', flexShrink: 0 }}>W:{r.selectedOption.score}</span>
              </div>
              <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500 }}>
                {r.selectedOption.label} ({r.selectedOption.score})
              </div>
            </div>
          ))}
          <div style={{ marginTop: 12, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            {t('changeTasks.score')}: {task.score ?? '—'}
          </div>
        </>
      )}
    </ModalOverlay>
  )
}
