/**
 * Single "Conferma Deploy" button for the deployment task.
 */
export function DeploymentTaskForm({ canEdit, onComplete }: {
  canEdit: boolean
  onComplete: () => void
}) {
  return (
    <div>
      <p style={{ marginBottom: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        Conferma che il deploy in produzione è stato completato.
      </p>
      <button
        type="button" disabled={!canEdit} onClick={onComplete}
        style={{ padding: '12px 32px', borderRadius: 8, border: 'none', background: 'var(--color-success)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: canEdit ? 'pointer' : 'not-allowed', opacity: canEdit ? 1 : 0.5 }}
      >
        Conferma Deploy
      </button>
    </div>
  )
}
