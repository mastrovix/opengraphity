import { useState, type ReactNode } from 'react'

interface DetailFieldProps {
  label: string
  value?: string | ReactNode | null
  mono?: boolean
  editable?: boolean
  onSave?: (value: string) => void
}

export function DetailField({ label, value, mono, editable, onSave }: DetailFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function startEdit() {
    setDraft(typeof value === 'string' ? value : '')
    setEditing(true)
  }

  function handleSave() {
    onSave?.(draft)
    setEditing(false)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <div style={{
          fontSize:       'var(--font-size-label)',
          fontWeight:     500,
          color:          'var(--color-slate-light)',
          textTransform:  'uppercase',
          letterSpacing:  '0.5px',
        }}>
          {label}
        </div>
        {editable && !editing && (
          <button
            type="button"
            onClick={startEdit}
            style={{ fontSize: 'var(--font-size-label)', padding: '1px 7px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}
          >
            Modifica
          </button>
        )}
      </div>

      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={3}
            autoFocus
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #0284c7', borderRadius: 6, fontSize: 'var(--font-size-body)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'vertical', outline: 'none', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" onClick={handleSave} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', backgroundColor: 'var(--color-brand)', color: '#fff', fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: 'pointer' }}>
              Salva
            </button>
            <button type="button" onClick={() => setEditing(false)} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', fontSize: 'var(--font-size-body)', cursor: 'pointer', color: 'var(--color-slate)' }}>
              Annulla
            </button>
          </div>
        </div>
      ) : (
        <div style={{
          fontSize:   'var(--font-size-body)',
          color:      value ? 'var(--color-slate-dark)' : '#c4c9d4',
          fontFamily: mono ? 'monospace' : "'Plus Jakarta Sans', system-ui, sans-serif",
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
          wordBreak:  mono ? 'break-all' : undefined,
        }}>
          {value || '—'}
        </div>
      )}
    </div>
  )
}
