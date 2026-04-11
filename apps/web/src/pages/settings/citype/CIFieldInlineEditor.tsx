import { useState } from 'react'
import { X, Check } from 'lucide-react'
import {
  inputS, selectS, textareaS, labelS,
  btnPrimary, btnSecondary,
  FIELD_TYPES,
} from '../shared/designerStyles'
import type { EnumTypeRef } from '../shared/designerStyles'
import type { FieldForm } from './CIFieldEditor'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnumTypeOption extends EnumTypeRef { name: string }

// ── FormField ─────────────────────────────────────────────────────────────────

export function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelS}>{label}</label>
      {children}
    </div>
  )
}

// ── CIFieldInlineEditor ────────────────────────────────────────────────────────

export function CIFieldInlineEditor({
  initial, existingCount, isSystem, onSave, onCancel, enumTypes,
}: {
  initial:       FieldForm | null
  existingCount: number
  isSystem:      boolean
  onSave:        (f: FieldForm) => void
  onCancel:      () => void
  enumTypes:     EnumTypeOption[]
}) {
  const [form, setForm] = useState<FieldForm>(
    initial ?? {
      name: '', label: '', fieldType: 'string', required: false,
      defaultValue: '', enumTypeId: null, validationScript: '',
      visibilityScript: '', defaultScript: '', order: existingCount,
    }
  )
  const [scriptTab, setScriptTab] = useState<'validation' | 'visibility' | 'default'>('validation')
  const set = (k: keyof FieldForm, v: unknown) => setForm((p) => ({ ...p, [k]: v }))
  const selectedEnum = form.enumTypeId ? enumTypes.find((e) => e.id === form.enumTypeId) : null

  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, marginBottom: 8 }}>
      {/* name + label */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelS}>name (slug) *</label>
          <input
            style={{ ...inputS, background: isSystem || !!initial ? '#f1f5f9' : '#fff' }}
            value={form.name}
            disabled={isSystem || !!initial}
            onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
            placeholder="field_name"
          />
        </div>
        <div>
          <label style={labelS}>label *</label>
          <input style={inputS} value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="Field Label" />
        </div>
      </div>

      {/* type + order + required */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px auto', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelS}>Tipo</label>
          <select
            style={{ ...selectS, background: isSystem ? '#f1f5f9' : '#fff' }}
            value={form.fieldType}
            disabled={isSystem}
            onChange={(e) => { set('fieldType', e.target.value); if (e.target.value !== 'enum') set('enumTypeId', null) }}
          >
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label style={labelS}>Order</label>
          <input style={inputS} type="number" value={form.order} onChange={(e) => set('order', Number(e.target.value))} />
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
          <label style={labelS}>Enum di riferimento *</label>
          <select
            style={selectS}
            value={form.enumTypeId ?? ''}
            onChange={(e) => set('enumTypeId', e.target.value || null)}
          >
            <option value="">— Seleziona enum —</option>
            {enumTypes.map((e) => (
              <option key={e.id} value={e.id}>{e.label} ({e.scope})</option>
            ))}
          </select>
          {selectedEnum && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {selectedEnum.values.map((v) => (
                <span key={v} style={{ padding: '2px 8px', background: '#f0f4ff', borderRadius: 12, fontSize: 'var(--font-size-table)', color: 'var(--color-brand)' }}>
                  {v}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* default value */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelS}>Valore di default</label>
        <input style={inputS} value={form.defaultValue} onChange={(e) => set('defaultValue', e.target.value)} />
      </div>

      {/* scripts (collapsible) */}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', cursor: 'pointer', userSelect: 'none', marginBottom: 8 }}>
          Script avanzati (validazione, visibilità, default)
        </summary>
        <div style={{ paddingTop: 8 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {(['validation', 'visibility', 'default'] as const).map((tab) => (
              <button key={tab} onClick={() => setScriptTab(tab)}
                style={{ padding: '4px 12px', borderRadius: 4, border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer',
                  background: scriptTab === tab ? 'var(--color-brand-light)' : '#f1f5f9',
                  color: scriptTab === tab ? 'var(--color-brand)' : 'var(--color-slate)',
                  fontWeight: scriptTab === tab ? 600 : 400 }}>
                {tab}Script
              </button>
            ))}
          </div>
          {scriptTab === 'validation' && (
            <div>
              <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', margin: '0 0 6px' }}>
                Variabili: <code>value</code>, <code>input</code>. Usa <code>throw 'msg'</code> per errore.
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.validationScript}
                onChange={(e) => set('validationScript', e.target.value)}
                placeholder={"// Esempio:\nif (!value.startsWith('http')) throw 'URL non valido'"} />
            </div>
          )}
          {scriptTab === 'visibility' && (
            <div>
              <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', margin: '0 0 6px' }}>
                Variabili: <code>input</code>. Ritorna <code>true/false</code>.
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.visibilityScript}
                onChange={(e) => set('visibilityScript', e.target.value)}
                placeholder={"// Mostra solo se altro campo valorizzato:\nreturn !!input.instanceType"} />
            </div>
          )}
          {scriptTab === 'default' && (
            <div>
              <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', margin: '0 0 6px' }}>
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
        <button style={btnSecondary} onClick={onCancel}>
          <X size={13} /> Annulla
        </button>
        <button style={btnPrimary} onClick={() => onSave(form)}>
          <Check size={13} /> Salva
        </button>
      </div>
    </div>
  )
}
