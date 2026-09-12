import { useId, useState } from 'react'
import { X, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  inputS, selectS, textareaS, labelS,
  btnPrimary, btnSecondary,
  FIELD_TYPES, enumOptionLabel,
} from '../shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import type { EnumTypeRef } from '../shared/designerStyles'
import type { FieldForm } from './CIFieldEditor'
import { colors, palette } from '@/lib/tokens'
import { checkCIFieldName } from '@/lib/ciTypeNames'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnumTypeOption extends EnumTypeRef { name: string }

// ── FormField ─────────────────────────────────────────────────────────────────

/**
 * Etichetta + controllo. Passa `htmlFor` (con lo stesso `id` sul controllo) quando il
 * figlio è un singolo input; senza `htmlFor` il testo è reso come intestazione di gruppo.
 */
export function FormField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {htmlFor
        ? <label htmlFor={htmlFor} style={labelS}>{label}</label>
        : <div style={labelS}>{label}</div>}
      {children}
    </div>
  )
}

// ── CIFieldInlineEditor ────────────────────────────────────────────────────────

export function CIFieldInlineEditor({
  initial, existingCount, isSystem, onSave, onCancel, enumTypes,
  existingFieldNames = [], typeLabel,
}: {
  initial:       FieldForm | null
  existingCount: number
  isSystem:      boolean
  onSave:        (f: FieldForm) => void
  onCancel:      () => void
  enumTypes:     EnumTypeOption[]
  /** I campi già presenti sul tipo (compresi quelli di `__base__`): A-12. */
  existingFieldNames?: readonly string[]
  typeLabel?:    string
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<FieldForm>(
    initial ?? {
      name: '', label: '', fieldType: 'string', required: false,
      defaultValue: '', enumTypeId: null, validationScript: '',
      visibilityScript: '', defaultScript: '', order: existingCount,
    }
  )
  const [scriptTab, setScriptTab] = useState<'validation' | 'visibility' | 'default'>('validation')
  const id = useId()
  const set = (k: keyof FieldForm, v: unknown) => setForm((p) => ({ ...p, [k]: v }))
  const selectedEnum = form.enumTypeId ? enumTypes.find((e) => e.id === form.enumTypeId) : null

  // A-12: il nome del campo diventa una proprietà Neo4j (`costCenter` →
  // `cost_center`). Un campo chiamato `tenantId` scriverebbe `tenant_id`, che è
  // il cliente proprietario del CI: il CI nascerebbe nel cliente scelto da chi
  // chiama l'API. La difesa vera è nell'API; qui si dice subito.
  // Su un campo esistente il nome è bloccato, quindi non si valida.
  const nameError = !initial && form.name
    ? checkCIFieldName(form.name, { existingFieldNames, typeLabel })
    : null

  return (
    <div style={{ background: 'var(--color-slate-bg)', border: `1px solid ${colors.border}`, borderRadius: 8, padding: 16, marginBottom: 8 }}>
      {/* name + label */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label htmlFor={`${id}-name`} style={labelS}>name (camelCase) *</label>
          <input
            id={`${id}-name`}
            style={{ ...inputS, background: isSystem || !!initial ? colors.slateBg : colors.white }}
            value={form.name}
            disabled={isSystem || !!initial}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${id}-name-error` : undefined}
            // A-12: camelCase, senza trattini basso — `costCenter` e
            // `cost_center` finirebbero sulla stessa proprietà Neo4j.
            onChange={(e) => set('name', e.target.value.replace(/[^A-Za-z0-9]/g, ''))}
            placeholder="costCenter"
          />
          {nameError && (
            <p id={`${id}-name-error`} role="alert" style={{ margin: '6px 0 0', fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' }}>
              {nameError}
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-label`} style={labelS}>label *</label>
          <Input id={`${id}-label`} style={inputS} value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="Field Label" />
        </div>
      </div>

      {/* type + order + required */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px auto', gap: 12, marginBottom: 12 }}>
        <div>
          <label htmlFor={`${id}-type`} style={labelS}>Tipo</label>
          <Select
            id={`${id}-type`}
            style={{ ...selectS, background: isSystem ? colors.slateBg : colors.white }}
            value={form.fieldType}
            disabled={isSystem}
            onChange={(e) => { set('fieldType', e.target.value); if (e.target.value !== 'enum') set('enumTypeId', null) }}
          >
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor={`${id}-order`} style={labelS}>Order</label>
          <Input id={`${id}-order`} style={inputS} type="number" value={form.order} onChange={(e) => set('order', Number(e.target.value))} />
        </div>
        <div style={{ paddingTop: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: isSystem ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={form.required} disabled={isSystem} onChange={(e) => set('required', e.target.checked)} />
            Obbligatorio
          </label>
        </div>
      </div>

      {/* enum dropdown */}
      {form.fieldType === 'enum' && (
        <div style={{ marginBottom: 12 }}>
          <label htmlFor={`${id}-enum`} style={labelS}>Enum di riferimento *</label>
          <Select
            id={`${id}-enum`}
            style={selectS}
            value={form.enumTypeId ?? ''}
            onChange={(e) => set('enumTypeId', e.target.value || null)}
          >
            <option value="">— Seleziona enum —</option>
            {enumTypes.map((e) => (
              <option key={e.id} value={e.id}>{enumOptionLabel(e, t)}</option>
            ))}
          </Select>
          {selectedEnum && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {selectedEnum.values.map((v) => (
                <Pill key={v} bg={palette.info.bg} color="var(--color-brand)" radius={12} style={{ fontWeight: 400 }}>
                  {v}
                </Pill>
              ))}
            </div>
          )}
        </div>
      )}

      {/* default value */}
      <div style={{ marginBottom: 12 }}>
        <label htmlFor={`${id}-default`} style={labelS}>Valore di default</label>
        <Input id={`${id}-default`} style={inputS} value={form.defaultValue} onChange={(e) => set('defaultValue', e.target.value)} />
      </div>

      {/* scripts (collapsible) */}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer', userSelect: 'none', marginBottom: 8 }}>
          Script avanzati (validazione, visibilità, default)
        </summary>
        <div style={{ paddingTop: 8 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {(['validation', 'visibility', 'default'] as const).map((tab) => (
              <button type="button" key={tab} onClick={() => setScriptTab(tab)}
                style={{ padding: '4px 12px', borderRadius: 4, border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer',
                  background: scriptTab === tab ? 'var(--color-brand-light)' : colors.slateBg,
                  color: scriptTab === tab ? 'var(--color-brand)' : 'var(--color-slate)',
                  fontWeight: scriptTab === tab ? 600 : 400 }}>
                {tab}Script
              </button>
            ))}
          </div>
          {scriptTab === 'validation' && (
            <div>
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
                Variabili: <code>value</code>, <code>input</code>. Usa <code>throw 'msg'</code> per errore.
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.validationScript}
                onChange={(e) => set('validationScript', e.target.value)}
                placeholder={"// Esempio:\nif (!value.startsWith('http')) throw 'URL non valido'"} />
            </div>
          )}
          {scriptTab === 'visibility' && (
            <div>
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
                Variabili: <code>input</code>. Ritorna <code>true/false</code>.
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.visibilityScript}
                onChange={(e) => set('visibilityScript', e.target.value)}
                placeholder={"// Mostra solo se altro campo valorizzato:\nreturn !!input.instanceType"} />
            </div>
          )}
          {scriptTab === 'default' && (
            <div>
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
                Variabili: <code>input</code>. Ritorna il valore di default.
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.defaultScript}
                onChange={(e) => set('defaultScript', e.target.value)}
                placeholder={"// Esempio:\nreturn input.instanceType === 'PostgreSQL' ? 5432 : 3306"} />
            </div>
          )}
        </div>
      </details>

      {/* actions */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" style={btnSecondary} onClick={onCancel}>
          <X size={13} /> Annulla
        </button>
        <button type="button" style={{ ...btnPrimary, opacity: nameError ? 0.6 : 1 }} disabled={!!nameError}
          onClick={() => onSave(form)}>
          <Check size={13} /> Salva
        </button>
      </div>
    </div>
  )
}
