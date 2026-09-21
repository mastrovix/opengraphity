/**
 * I campi del cliente nei moduli del portale (ondata 4). Lo stile lo passa chi
 * lo usa, così il nuovo ticket e la richiesta dal catalogo restano coerenti con sé stessi.
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { palette } from '@/lib/tokens'
import type { PortalCustomField } from '@/hooks/usePortalCustomFields'

interface Props {
  fields:     readonly PortalCustomField[]
  values:     Record<string, string>
  onChange:   (name: string, value: string) => void
  errors?:    Record<string, string>
  labelStyle: React.CSSProperties
  inputStyle: React.CSSProperties
  gap?:       number
}

export function PortalCustomFields({ fields, values, onChange, errors = {}, labelStyle, inputStyle, gap = 20 }: Props) {
  const { t } = useTranslation()
  const idBase = useId()
  if (fields.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {fields.map((f) => {
        const id = `${idBase}-${f.name}`
        const value = values[f.name] ?? ''
        const style = { ...inputStyle, ...(errors[f.name] ? { borderColor: palette.danger.strong } : {}) }
        return (
          <div key={f.name}>
            <label htmlFor={id} style={labelStyle}>{f.label}{f.required ? ' *' : ''}</label>
            {f.fieldType === 'enum' || f.fieldType === 'boolean' ? (
              <select id={id} value={value} onChange={(e) => onChange(f.name, e.target.value)} style={style}>
                <option value="">{t('customFields.choose')}</option>
                {(f.fieldType === 'boolean' ? [{ value: 'true', label: t('common.yes') }, { value: 'false', label: t('common.no') }] : f.options)
                  .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input id={id} type={f.fieldType === 'number' ? 'number' : f.fieldType === 'date' ? 'date' : 'text'} value={value}
                onChange={(e) => onChange(f.name, e.target.value)} style={style} />
            )}
            {errors[f.name] && <p role="alert" style={{ margin: '4px 0 0', fontSize: 12, color: palette.danger.strong }}>{errors[f.name]}</p>}
          </div>
        )
      })}
    </div>
  )
}
