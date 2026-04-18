/**
 * Pass / Fail buttons for the validation task.
 */
import { VALIDATION_RESULT } from '@/lib/taskStatus'

export function ValidationTaskForm({ canEdit, onComplete }: {
  canEdit: boolean
  onComplete: (result: string) => void
}) {
  return (
    <div>
      <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        Verifica il CI in ambiente pre-produzione e registra l'esito.
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="button" disabled={!canEdit} onClick={() => onComplete(VALIDATION_RESULT.PASS)} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Pass</button>
        <button type="button" disabled={!canEdit} onClick={() => onComplete(VALIDATION_RESULT.FAIL)} style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-danger)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}>Fail</button>
      </div>
    </div>
  )
}
