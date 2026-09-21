/**
 * I campi personalizzati in un form di creazione o di modifica (ondata 4).
 * Stile passato da chi lo usa, così ogni pagina resta coerente con sé stessa.
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import type { FieldRules } from '@/hooks/useFormFieldRules'
import type { CustomFieldDefView } from './customFields'

interface Props {
  defs:        readonly CustomFieldDefView[]
  values:      Record<string, string>
  onChange:    (name: string, value: string) => void
  rules?:      Record<string, FieldRules>
  errors?:     Record<string, string>
  inputStyle:  React.CSSProperties
  labelStyle:  React.CSSProperties
  /** Spazio fra un campo e l'altro. */
  gap?:        number
}

export function CustomFieldsForm({ defs, values, onChange, rules = {}, errors = {}, inputStyle, labelStyle, gap = 20 }: Props) {
  const { t } = useTranslation()
  const { labelOf } = useDomainVocabularies()
  const idBase = useId()
  const visible = defs.filter((d) => rules[d.name]?.visible ?? true)
  if (visible.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {visible.map((d) => {
        const id = `${idBase}-${d.name}`
        const required = d.required || rules[d.name]?.required === true
        const error = errors[d.name]
        const style = { ...inputStyle, ...(error ? { borderColor: 'var(--color-trigger-sla-breach)' } : {}) }
        const value = values[d.name] ?? ''
        return (
          <div key={d.name}>
            <label htmlFor={id} style={labelStyle}>
              {d.label}{required && <span style={{ color: 'var(--color-trigger-sla-breach)', marginLeft: 3 }}>*</span>}
            </label>
            {d.fieldType === 'enum' ? (
              <select id={id} value={value} onChange={(e) => onChange(d.name, e.target.value)} style={style}>
                <option value="">{t('customFields.chooseValue')}</option>
                {d.enumValues.map((v) => <option key={v} value={v}>{(d.enumTypeName ? labelOf(d.enumTypeName, v) : null) ?? v}</option>)}
              </select>
            ) : d.fieldType === 'boolean' ? (
              <select id={id} value={value} onChange={(e) => onChange(d.name, e.target.value)} style={style}>
                <option value="">{t('customFields.chooseValue')}</option>
                <option value="true">{t('common.yes')}</option>
                <option value="false">{t('common.no')}</option>
              </select>
            ) : (
              <input
                id={id}
                type={d.fieldType === 'number' ? 'number' : d.fieldType === 'date' ? 'date' : 'text'}
                value={d.fieldType === 'date' ? value.slice(0, 10) : value}
                onChange={(e) => onChange(d.name, e.target.value)}
                style={style}
              />
            )}
            {error && <p role="alert" style={{ margin: '4px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)' }}>{error}</p>}
          </div>
        )
      })}
    </div>
  )
}
