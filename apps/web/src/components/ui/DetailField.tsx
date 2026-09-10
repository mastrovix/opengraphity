import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { colors } from '@/lib/tokens'

interface DetailFieldProps {
  label: string
  value?: string | ReactNode | null
  mono?: boolean
  editable?: boolean
  onSave?: (value: string) => void
}

export function DetailField({ label, value, mono, editable, onSave }: DetailFieldProps) {
  const { t } = useTranslation()
  const labelId = useId()
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
        <div id={labelId} style={{
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
            aria-label={`${t('common.edit')}: ${label}`}
            style={{ fontSize: 'var(--font-size-label)', padding: '1px 7px', borderRadius: 4, border: `1px solid ${colors.border}`, background: 'transparent', cursor: 'pointer', color: 'var(--color-slate-light)' }}
          >
            {t('common.edit')}
          </button>
        )}
      </div>

      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={3}
            aria-labelledby={labelId}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- editor inline montato dopo il click su "Modifica": il focus deve seguire l'azione dell'utente
            autoFocus
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: `1px solid ${colors.brand}`, borderRadius: 6, fontSize: 'var(--font-size-body)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", resize: 'vertical', outline: 'none', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" onClick={handleSave} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', backgroundColor: 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: 'pointer' }}>
              {t('common.save')}
            </button>
            <button type="button" onClick={() => setEditing(false)} style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${colors.border}`, background: 'transparent', fontSize: 'var(--font-size-body)', cursor: 'pointer', color: 'var(--color-slate)' }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div style={{
          fontSize:   'var(--font-size-body)',
          color:      value ? 'var(--color-slate-dark)' : colors.slateLight,
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
