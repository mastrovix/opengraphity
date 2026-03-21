import { useState } from 'react'

interface DetailFieldProps {
  label: string
  value?: string | null
  mono?: boolean
  editable?: boolean
  onSave?: (value: string) => void
}

export function DetailField({ label, value, mono, editable, onSave }: DetailFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function startEdit() {
    setDraft(value ?? '')
    setEditing(true)
  }

  function handleSave() {
    onSave?.(draft)
    setEditing(false)
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{
          fontSize: 11, fontWeight: 600,
          color: '#8892a4', textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {label}
        </div>
        {editable && !editing && (
          <button
            type="button"
            onClick={startEdit}
            style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, border: '1px solid #e2e6f0', background: 'transparent', cursor: 'pointer', color: '#8892a4' }}
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
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #4f46e5', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              onClick={handleSave}
              style={{ padding: '5px 14px', borderRadius: 6, border: 'none', backgroundColor: '#4f46e5', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              Salva
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #e2e6f0', background: 'transparent', fontSize: 12, cursor: 'pointer', color: '#6b7280' }}
            >
              Annulla
            </button>
          </div>
        </div>
      ) : (
        <div style={{
          fontSize: 13,
          color: value ? '#111827' : '#c4c9d4',
          fontFamily: mono ? 'monospace' : 'inherit',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
        }}>
          {value || '—'}
        </div>
      )}
    </div>
  )
}
