import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { Modal } from '@/components/Modal'
import { GET_ENUM_TYPES } from '@/graphql/queries'
import type { CIFieldDef } from '@/contexts/MetamodelContext'
import {
  inputS, selectS, textareaS, labelS,
  btnPrimary, btnSecondary,
  FIELD_TYPES,
} from '../shared/designerStyles'
import type { EnumTypeRef } from '../shared/designerStyles'

// Re-export shared button styles for any remaining consumers
export { btnPrimary, btnSecondary } from '../shared/designerStyles'
export const btnDanger: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff',
  color: '#ef4444', fontSize: 'var(--font-size-body)', cursor: 'pointer',
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnumTypeOption extends EnumTypeRef { name: string }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelS}>{label}</label>
      {children}
    </div>
  )
}

// ── FieldForm ─────────────────────────────────────────────────────────────────

export interface FieldForm {
  name: string; label: string; fieldType: string
  required: boolean; defaultValue: string
  enumTypeId: string | null
  validationScript: string; visibilityScript: string; defaultScript: string
  order: number
}

export const emptyFieldForm = (): FieldForm => ({
  name: '', label: '', fieldType: 'string', required: false,
  defaultValue: '', enumTypeId: null, validationScript: '',
  visibilityScript: '', defaultScript: '', order: 0,
})

export function fieldToForm(f: CIFieldDef): FieldForm {
  return {
    name:             f.name,
    label:            f.label,
    fieldType:        f.fieldType,
    required:         f.required,
    defaultValue:     '',
    enumTypeId:       (f as unknown as { enumTypeId?: string | null }).enumTypeId ?? null,
    validationScript: f.validationScript ?? '',
    visibilityScript: f.visibilityScript ?? '',
    defaultScript:    f.defaultScript ?? '',
    order:            f.order,
  }
}

// ── CIFieldEditor (Modal — used for base type fields) ─────────────────────────

interface FieldModalProps {
  open:          boolean
  onClose:       () => void
  onSave:        (form: FieldForm) => Promise<void>
  initial:       FieldForm | null
  existingCount: number
}

export function CIFieldEditor({ open, onClose, onSave, initial, existingCount }: FieldModalProps) {
  const [form, setForm] = useState<FieldForm>(initial ?? { ...emptyFieldForm(), order: existingCount })
  const [saving, setSaving] = useState(false)
  const [scriptTab, setScriptTab] = useState<'validation' | 'visibility' | 'default'>('validation')

  const { data: enumData } = useQuery<{ enumTypes: EnumTypeOption[] }>(GET_ENUM_TYPES, {
    fetchPolicy: 'cache-and-network',
  })
  const enumTypes = enumData?.enumTypes ?? []

  const set = (k: keyof FieldForm, v: unknown) => setForm((p) => ({ ...p, [k]: v }))
  const selectedEnum = form.enumTypeId ? enumTypes.find((e) => e.id === form.enumTypeId) : null

  return (
    <Modal open={open} onClose={onClose} title={initial ? `Modifica campo: ${initial.name}` : 'Aggiungi campo'} width={560}
      footer={
        <>
          <button style={btnSecondary} onClick={onClose}>Annulla</button>
          <button style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }} disabled={saving}
            onClick={async () => {
              setSaving(true)
              try { await onSave(form) } finally { setSaving(false) }
            }}>
            {saving ? 'Salvataggio…' : 'Salva'}
          </button>
        </>
      }>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        <Field label="name (slug) *">
          <input style={inputS} value={form.name} disabled={!!initial}
            onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        </Field>
        <Field label="label *">
          <input style={inputS} value={form.label} onChange={(e) => set('label', e.target.value)} />
        </Field>
        <Field label="Tipo">
          <select style={selectS} value={form.fieldType} onChange={(e) => {
            set('fieldType', e.target.value)
            if (e.target.value !== 'enum') set('enumTypeId', null)
          }}>
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Order">
          <input style={inputS} type="number" value={form.order} onChange={(e) => set('order', Number(e.target.value))} />
        </Field>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <input type="checkbox" id="req" checked={form.required} onChange={(e) => set('required', e.target.checked)} style={{ cursor: 'pointer' }} />
        <label htmlFor="req" style={{ fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>Obbligatorio</label>
      </div>

      {form.fieldType === 'enum' && (
        <Field label="Enum di riferimento *">
          <select style={selectS} value={form.enumTypeId ?? ''} onChange={(e) => set('enumTypeId', e.target.value || null)}>
            <option value="">— Seleziona enum —</option>
            {enumTypes.map((e) => (
              <option key={e.id} value={e.id}>{e.label} ({e.scope})</option>
            ))}
          </select>
          {selectedEnum && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {selectedEnum.values.map((v) => (
                <span key={v} style={{ padding: '2px 8px', background: '#f0f4ff', borderRadius: 12, fontSize: 'var(--font-size-table)', color: 'var(--color-brand)' }}>
                  {v}
                </span>
              ))}
            </div>
          )}
        </Field>
      )}

      <Field label="Valore di default">
        <input style={inputS} value={form.defaultValue} onChange={(e) => set('defaultValue', e.target.value)} />
      </Field>

      {/* Script tabs */}
      <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 8, paddingTop: 16 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {(['validation', 'visibility', 'default'] as const).map((tab) => (
            <button key={tab} onClick={() => setScriptTab(tab)}
              style={{ padding: '4px 12px', borderRadius: 4, border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer',
                background: scriptTab === tab ? 'var(--color-brand-light)' : '#f9fafb',
                color: scriptTab === tab ? 'var(--color-brand)' : 'var(--color-slate)',
                fontWeight: scriptTab === tab ? 600 : 400 }}>
              {tab}Script
            </button>
          ))}
        </div>

        {scriptTab === 'validation' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', margin: '0 0 6px' }}>
              Variabili: <code>value</code>, <code>input</code>. Usa <code>throw 'messaggio'</code> per errore.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.validationScript}
              onChange={(e) => set('validationScript', e.target.value)}
              placeholder={"// Esempio:\nif (!value.startsWith('http')) throw 'URL non valido'"} />
          </div>
        )}
        {scriptTab === 'visibility' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', margin: '0 0 6px' }}>
              Variabili: <code>input</code>. Ritorna <code>true/false</code>.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.visibilityScript}
              onChange={(e) => set('visibilityScript', e.target.value)}
              placeholder={"// Mostra solo se altro campo è valorizzato:\nreturn !!input.instanceType"} />
          </div>
        )}
        {scriptTab === 'default' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', margin: '0 0 6px' }}>
              Variabili: <code>input</code>. Ritorna il valore di default.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.defaultScript}
              onChange={(e) => set('defaultScript', e.target.value)}
              placeholder={"// Esempio:\nreturn input.instanceType === 'PostgreSQL' ? 5432 : 3306"} />
          </div>
        )}
      </div>
    </Modal>
  )
}

// Re-export for legacy consumers
export { Plus } from 'lucide-react'
