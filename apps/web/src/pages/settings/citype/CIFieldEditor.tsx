import { useState } from 'react'
import { Check, X, Plus } from 'lucide-react'
import { Modal } from '@/components/Modal'
import type { CIFieldDef } from '@/contexts/MetamodelContext'

// ── Style constants ────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 14, color: 'var(--color-slate-dark)', outline: 'none',
  backgroundColor: '#fff', boxSizing: 'border-box',
}

const selectS: React.CSSProperties = {
  ...inputS,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}

const textareaS: React.CSSProperties = {
  ...inputS, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 12, resize: 'vertical', minHeight: 80,
}

const labelS: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4,
}

const btnPrimary: React.CSSProperties = {
  padding: '8px 16px', border: 'none', borderRadius: 6, background: 'var(--color-brand)',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
}

const btnSecondary: React.CSSProperties = {
  padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 14, cursor: 'pointer',
}

const btnDanger: React.CSSProperties = {
  padding: '6px 12px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff',
  color: 'var(--color-trigger-sla-breach)', fontSize: 12, cursor: 'pointer',
}

const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'enum']

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelS}>{label}</label>
      {children}
    </div>
  )
}

// ── FieldModal ────────────────────────────────────────────────────────────────

export interface FieldForm {
  name: string; label: string; fieldType: string
  required: boolean; defaultValue: string; enumValues: string
  validationScript: string; visibilityScript: string; defaultScript: string
  order: number
}

export const emptyFieldForm = (): FieldForm => ({
  name: '', label: '', fieldType: 'string', required: false,
  defaultValue: '', enumValues: '[]', validationScript: '',
  visibilityScript: '', defaultScript: '', order: 0,
})

export function fieldToForm(f: CIFieldDef): FieldForm {
  return {
    name: f.name, label: f.label, fieldType: f.fieldType,
    required: f.required, defaultValue: '',
    enumValues: JSON.stringify(f.enumValues ?? []),
    validationScript: f.validationScript ?? '',
    visibilityScript: f.visibilityScript ?? '',
    defaultScript: f.defaultScript ?? '',
    order: f.order,
  }
}

interface FieldModalProps {
  open: boolean
  onClose: () => void
  onSave: (form: FieldForm) => Promise<void>
  initial: FieldForm | null
  existingCount: number
}

export function CIFieldEditor({ open, onClose, onSave, initial, existingCount }: FieldModalProps) {
  const [form, setForm] = useState<FieldForm>(initial ?? { ...emptyFieldForm(), order: existingCount })
  const [saving, setSaving] = useState(false)
  const [scriptTab, setScriptTab] = useState<'validation' | 'visibility' | 'default'>('validation')

  const set = (k: keyof FieldForm, v: unknown) => setForm(p => ({ ...p, [k]: v }))

  const handleOpen = () => { setForm(initial ?? { ...emptyFieldForm(), order: existingCount }) }

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
      <div onClick={handleOpen} style={{ display: 'none' }} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        <Field label="name (slug) *">
          <input style={inputS} value={form.name} disabled={!!initial}
            onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
        </Field>
        <Field label="label *">
          <input style={inputS} value={form.label} onChange={e => set('label', e.target.value)} />
        </Field>
        <Field label="Tipo">
          <select style={selectS} value={form.fieldType} onChange={e => set('fieldType', e.target.value)}>
            {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Order">
          <input style={inputS} type="number" value={form.order} onChange={e => set('order', Number(e.target.value))} />
        </Field>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <input type="checkbox" id="req" checked={form.required} onChange={e => set('required', e.target.checked)} style={{ cursor: 'pointer' }} />
        <label htmlFor="req" style={{ fontSize: 14, cursor: 'pointer' }}>Obbligatorio</label>
      </div>

      {form.fieldType === 'enum' && (
        <Field label="Valori enum (array JSON)">
          <textarea style={textareaS} value={form.enumValues} onChange={e => set('enumValues', e.target.value)} placeholder='["valore1","valore2"]' />
        </Field>
      )}

      <Field label="Valore di default">
        <input style={inputS} value={form.defaultValue} onChange={e => set('defaultValue', e.target.value)} />
      </Field>

      {/* Script tabs */}
      <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 8, paddingTop: 16 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          {(['validation', 'visibility', 'default'] as const).map(tab => (
            <button key={tab} onClick={() => setScriptTab(tab)}
              style={{ padding: '4px 12px', borderRadius: 4, border: 'none', fontSize: 12, cursor: 'pointer',
                background: scriptTab === tab ? 'var(--color-brand-light)' : '#f9fafb',
                color: scriptTab === tab ? 'var(--color-brand)' : 'var(--color-slate)',
                fontWeight: scriptTab === tab ? 600 : 400 }}>
              {tab}Script
            </button>
          ))}
        </div>

        {scriptTab === 'validation' && (
          <div>
            <p style={{ fontSize: 12, color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
              Variabili: <code>value</code>, <code>input</code>. Usa <code>throw 'messaggio'</code> per errore.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.validationScript}
              onChange={e => set('validationScript', e.target.value)}
              placeholder={"// Esempio:\nif (!value.startsWith('http')) throw 'URL non valido'"} />
          </div>
        )}
        {scriptTab === 'visibility' && (
          <div>
            <p style={{ fontSize: 12, color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
              Variabili: <code>input</code>. Ritorna <code>true/false</code>.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.visibilityScript}
              onChange={e => set('visibilityScript', e.target.value)}
              placeholder={"// Mostra solo se altro campo è valorizzato:\nreturn !!input.instanceType"} />
          </div>
        )}
        {scriptTab === 'default' && (
          <div>
            <p style={{ fontSize: 12, color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
              Variabili: <code>input</code>. Ritorna il valore di default.
            </p>
            <textarea style={{ ...textareaS, minHeight: 100 }} value={form.defaultScript}
              onChange={e => set('defaultScript', e.target.value)}
              placeholder={"// Esempio:\nreturn input.instanceType === 'PostgreSQL' ? 5432 : 3306"} />
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── FieldTable (used inside the editor panels) ────────────────────────────────

interface FieldTableProps {
  fields: CIFieldDef[]
  showActions: boolean
  onEdit?: (f: CIFieldDef) => void
  onRemove?: (f: CIFieldDef) => void
}

export function CIFieldTable({ fields, showActions, onEdit, onRemove }: FieldTableProps) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
          {['#', 'name', 'label', 'tipo', 'req', ''].map(h => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 12, color: 'var(--color-slate-light)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {fields.map(f => (
          <tr key={f.id} style={{ borderBottom: '1px solid #f3f4f6', background: f.isSystem ? '#f9fafb' : 'transparent' }}>
            <td style={{ padding: '8px', color: 'var(--color-slate-light)', fontSize: 12 }}>{f.order}</td>
            <td style={{ padding: '8px' }}>
              <span style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 12 }}>{f.name}</span>
              {f.isSystem && (
                <span style={{ marginLeft: 6, padding: '1px 5px', fontSize: 10, borderRadius: 3, background: '#cffafe', color: 'var(--color-brand)', fontWeight: 600 }}>Sistema</span>
              )}
            </td>
            <td style={{ padding: '8px' }}>{f.label}</td>
            <td style={{ padding: '8px' }}>
              <span style={{ padding: '2px 8px', borderRadius: 4, background: '#f3f4f6', fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>{f.fieldType}</span>
            </td>
            <td style={{ padding: '8px', textAlign: 'center' }}>
              {f.required ? <Check size={14} color="#16a34a" /> : <span style={{ color: '#d1d5db' }}>—</span>}
            </td>
            <td style={{ padding: '8px' }}>
              {showActions && (
                <div style={{ display: 'flex', gap: 4 }}>
                  <button style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}
                    onClick={() => onEdit?.(f)}>
                    Modifica
                  </button>
                  <button style={{ ...btnDanger, padding: '3px 10px' }}
                    aria-label={`Elimina campo ${f.name}`}
                    onClick={() => {
                      if (!confirm(`Eliminare il campo "${f.name}"?`)) return
                      onRemove?.(f)
                    }}>
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              )}
              {!showActions && (
                <button style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}
                  onClick={() => onEdit?.(f)}>
                  Modifica
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// Re-export btn styles for use in parent
export { btnPrimary, btnSecondary, btnDanger, Plus }
