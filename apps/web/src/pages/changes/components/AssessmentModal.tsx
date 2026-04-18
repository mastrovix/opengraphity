/**
 * Read-only modal showing the assessment responses for a single role
 * (functional / technical) on a single CI.
 */
import type { AssessmentTaskData } from '@/types/change'
import { ModalOverlay } from './shared'

export function AssessmentModal({ task, ciName, roleLabel, bothAssessDone, onClose }: {
  task: AssessmentTaskData
  ciName: string
  roleLabel: string
  bothAssessDone: boolean
  onClose: () => void
}) {
  return (
    <ModalOverlay title={`Risposte ${roleLabel} — ${ciName}`} onClose={onClose}>
      {!bothAssessDone ? (
        <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: '16px 0' }}>
          Le risposte saranno visibili quando entrambi gli assessment saranno completati.
        </p>
      ) : (
        <>
          {task.responses.map((r, i) => (
            <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', flex: 1 }}>{r.question.text}</span>
                <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '1px 6px', borderRadius: 4, backgroundColor: '#f1f5f9', color: 'var(--color-slate)', whiteSpace: 'nowrap', flexShrink: 0 }}>W:{r.selectedOption.score}</span>
              </div>
              <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', fontWeight: 500 }}>
                {r.selectedOption.label} ({r.selectedOption.score})
              </div>
            </div>
          ))}
          <div style={{ marginTop: 12, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            Score: {task.score ?? '—'}
          </div>
        </>
      )}
    </ModalOverlay>
  )
}
