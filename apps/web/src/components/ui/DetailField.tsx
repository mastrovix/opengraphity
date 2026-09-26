import { Textarea } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
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
          <Button variant="secondary" size="xs"
            onClick={startEdit}
            aria-label={`${t('common.edit')}: ${label}`}
          >
            {t('common.edit')}
          </Button>
        )}
      </div>

      {editing ? (
        <div>
          <Textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={3}
            aria-labelledby={labelId}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- editor inline montato dopo il click su "Modifica": il focus deve seguire l'azione dell'utente
            autoFocus
            style={{ resize: 'vertical', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <Button variant="primary" onClick={handleSave}>
              {t('common.save')}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div style={{
          fontSize:   'var(--font-size-body)',
          color:      value ? 'var(--color-slate-dark)' : colors.slateLight,
          // I DUE token, non due elenchi scritti a mano: `mono` prendeva il
          // monospace del browser (un carattere che non e del prodotto, e si
          // vedeva su ogni «ID» delle schede di dettaglio) e l'altro ramo
          // ricopiava la pila di caratteri invece di leggerla da index.css.
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
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
