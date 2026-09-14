/**
 * I campi personalizzati nel dettaglio di un ticket (ondata 4): si leggono con
 * le etichette del Dizionario e si modificano sul posto. Se il tipo non ha
 * campi del cliente la scheda non c'è.
 */
import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { SectionCard } from '@/components/ui/SectionCard'
import { SET_TICKET_CUSTOM_FIELDS } from '@/graphql/mutations'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { colors } from '@/lib/tokens'
import { CustomFieldsForm } from './CustomFieldsForm'
import {
  customFieldDisplay, customFieldValuesMap, customFieldsInput, missingCustomFields,
  type CustomFieldValueView, type TicketEntityType,
} from './customFields'

interface Props {
  entityType: TicketEntityType
  ticketId:   string
  fields:     readonly CustomFieldValueView[]
  canEdit:    boolean
  /** Dopo il salvataggio: di solito il refetch del dettaglio. */
  onSaved?:   () => void
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4,
}
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
  border: `1px solid ${colors.border}`, fontSize: 'var(--font-size-body)', background: colors.white, color: 'var(--color-slate-dark)',
}

export function CustomFieldsCard({ entityType, ticketId, fields, canEdit, onSaved }: Props) {
  const { t } = useTranslation()
  const { labelOf } = useDomainVocabularies()
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [save, { loading }] = useMutation(SET_TICKET_CUSTOM_FIELDS, {
    onCompleted: () => { toast.success(t('customFields.saved')); setEditing(false); onSaved?.() },
  })

  if (fields.length === 0) return null

  const startEdit = () => { setValues(customFieldValuesMap(fields)); setErrors({}); setEditing(true) }
  const submit = () => {
    const missing = missingCustomFields(fields, values)
    if (missing.length > 0) {
      setErrors(Object.fromEntries(missing.map((m) => [m, t('forms.fieldRequired')])))
      return
    }
    void save({ variables: { entityType, id: ticketId, values: customFieldsInput(fields, values) } })
  }

  return (
    <SectionCard
      title={t('customFields.title')}
      count={fields.filter((f) => f.value != null && f.value !== '').length}
      defaultOpen
      headerRight={canEdit && !editing ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); startEdit() }}
          aria-label={t('customFields.edit')}
          title={t('customFields.edit')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand)', fontSize: 'var(--font-size-body)', fontWeight: 600 }}
        >
          <Pencil size={13} aria-hidden="true" /> {t('customFields.edit')}
        </button>
      ) : undefined}
    >
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <CustomFieldsForm
            defs={fields} values={values} errors={errors} gap={14}
            onChange={(name, value) => { setValues((v) => ({ ...v, [name]: value })); setErrors((e) => { const n = { ...e }; delete n[name]; return n }) }}
            inputStyle={inputStyle} labelStyle={labelStyle}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setEditing(false)} style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.white, color: 'var(--color-slate)', cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
              {t('common.cancel')}
            </button>
            <button type="button" onClick={submit} disabled={loading} style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--color-brand)', color: colors.white, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1, fontSize: 'var(--font-size-body)', fontWeight: 600 }}>
              {loading ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      ) : (
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px 24px', margin: 0 }}>
          {fields.map((f) => (
            <div key={f.name} style={{ minWidth: 0 }}>
              <dt style={labelStyle}>{f.label}</dt>
              <dd style={{ margin: 0, fontSize: 'var(--font-size-body)', color: f.value ? 'var(--color-slate-dark)' : 'var(--color-slate-light)', overflowWrap: 'anywhere' }}>
                {customFieldDisplay(f, labelOf, t)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </SectionCard>
  )
}
