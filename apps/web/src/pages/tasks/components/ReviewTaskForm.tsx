/**
 * Confirmed / Rejected buttons for the post-deploy review task.
 */
import { REVIEW_RESULT } from '@/lib/taskStatus'

export function ReviewTaskForm({ canEdit, onComplete }: {
  canEdit: boolean
  onComplete: (result: string) => void
}) {
  return (
    <div>
      <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        Verifica l'esito del deploy e conferma o rigetta.
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="button" disabled={!canEdit} onClick={() => onComplete(REVIEW_RESULT.CONFIRMED)} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Confirmed</button>
        <button type="button" disabled={!canEdit} onClick={() => onComplete(REVIEW_RESULT.REJECTED)} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-danger)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Rejected</button>
      </div>
    </div>
  )
}
