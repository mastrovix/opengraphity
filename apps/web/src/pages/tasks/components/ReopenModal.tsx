/**
 * Prompt modal for the admin "reopen task" flow. Asks for a reason
 * (min 10 chars) before invoking the parent-provided callback.
 */
import { useState } from 'react'
import { inputStyle } from './shared'

export function ReopenModal({ onConfirm, onCancel }: {
  onConfirm: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 440, width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>Riapri task</h3>
        <p style={{ margin: '0 0 12px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Inserisci il motivo della riapertura (min 10 caratteri).</p>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', marginBottom: 16 }}
          placeholder="Motivo della riapertura..."
          autoFocus
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onCancel} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Annulla</button>
          <button
            type="button"
            disabled={reason.trim().length < 10}
            onClick={() => onConfirm(reason.trim())}
            style={{
              padding: '8px 16px', borderRadius: 6, border: 'none',
              background: '#eab308', color: '#fff', fontWeight: 600,
              cursor: reason.trim().length >= 10 ? 'pointer' : 'not-allowed',
              opacity: reason.trim().length >= 10 ? 1 : 0.5,
              fontSize: 'var(--font-size-body)',
            }}
          >
            Conferma riapertura
          </button>
        </div>
      </div>
    </div>
  )
}
