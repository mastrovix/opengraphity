import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X, Check } from 'lucide-react'
import { DesignerFieldRow } from './shared/DesignerFieldRow'
import {
  inputS, selectS, textareaS, labelS, btnPrimary, btnSecondary, FIELD_TYPES,
} from './shared/designerStyles'
import type { EnumTypeRef } from './shared/designerStyles'
import type { ITILField, FieldFormState, EnumTypeOption } from './useITILTypeDesigner'
import { emptyForm, fieldToForm } from './useITILTypeDesigner'

// ── FieldEditor (inline) ──────────────────────────────────────────────────────

function FieldEditor({
  field, isSystem, onSave, onCancel, enumTypesData,
}: {
  field:         FieldFormState
  isSystem:      boolean
  onSave:        (f: FieldFormState) => void
  onCancel:      () => void
  enumTypesData: { enumTypes: EnumTypeRef[] } | undefined
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<FieldFormState>(field)
  const [scriptTab, setScriptTab] = useState<'validation' | 'visibility' | 'default'>('validation')
  const set = (key: keyof FieldFormState, val: unknown) =>
    setForm((f) => ({ ...f, [key]: val }))

  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, marginBottom: 8 }}>
      {/* name + label */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelS}>{t('itilDesigner.fieldName')}</label>
          <input
            style={{ ...inputS, background: isSystem || !!field.name ? '#f1f5f9' : '#fff' }}
            value={form.name}
            disabled={isSystem || !!field.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="field_name"
          />
        </div>
        <div>
          <label style={labelS}>{t('itilDesigner.fieldLabel')}</label>
          <input
            style={inputS}
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="Field Label"
          />
        </div>
      </div>

      {/* type + order + required */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px auto', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelS}>{t('itilDesigner.fieldType')}</label>
          <select
            style={{ ...selectS, background: isSystem ? '#f1f5f9' : '#fff' }}
            value={form.fieldType}
            disabled={isSystem}
            onChange={(e) => { set('fieldType', e.target.value); if (e.target.value !== 'enum') set('enumTypeId', null) }}
          >
            {FIELD_TYPES.map((ft) => (
              <option key={ft} value={ft}>{ft}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelS}>Order</label>
          <input style={inputS} type="number" value={form.order} onChange={(e) => set('order', Number(e.target.value))} />
        </div>
        <div style={{ paddingTop: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: isSystem ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={form.required}
              disabled={isSystem}
              onChange={(e) => set('required', e.target.checked)}
            />
            {t('itilDesigner.required')}
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
            onChange={(e) => setForm((f) => ({ ...f, enumTypeId: e.target.value || null }))}
          >
            <option value="">— Seleziona enum —</option>
            {(enumTypesData?.enumTypes ?? []).map((e) => (
              <option key={e.id} value={e.id}>{e.label} ({e.scope})</option>
            ))}
          </select>
        </div>
      )}

      {/* scripts (collapsible) */}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 12, color: 'var(--color-slate)', cursor: 'pointer', userSelect: 'none', marginBottom: 8 }}>
          Script avanzati (validazione, visibilità, default)
        </summary>
        <div style={{ paddingTop: 8 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {(['validation', 'visibility', 'default'] as const).map((tab) => (
              <button key={tab} onClick={() => setScriptTab(tab)}
                style={{ padding: '4px 12px', borderRadius: 4, border: 'none', fontSize: 12, cursor: 'pointer',
                  background: scriptTab === tab ? 'var(--color-brand-light)' : '#f1f5f9',
                  color:      scriptTab === tab ? 'var(--color-brand)' : 'var(--color-slate)',
                  fontWeight: scriptTab === tab ? 600 : 400 }}>
                {tab}Script
              </button>
            ))}
          </div>
          {scriptTab === 'validation' && (
            <div>
              <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 6px' }}>
                Variabili: <code>value</code>, <code>input</code>. Usa <code>throw 'msg'</code> per errore.
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.validationScript}
                onChange={(e) => set('validationScript', e.target.value)}
                placeholder={"// Esempio:\nif (!value || value.length < 3) throw 'Minimo 3 caratteri'"} />
            </div>
          )}
          {scriptTab === 'visibility' && (
            <div>
              <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 6px' }}>
                Variabili: <code>input</code>. Ritorna <code>true/false</code>.
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.visibilityScript}
                onChange={(e) => set('visibilityScript', e.target.value)}
                placeholder={"// Mostra solo se severity = 'critical':\nreturn input.severity === 'critical'"} />
            </div>
          )}
          {scriptTab === 'default' && (
            <div>
              <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 6px' }}>
                Variabili: <code>input</code>. Ritorna il valore di default.
              </p>
              <textarea style={{ ...textareaS, minHeight: 90 }} value={form.defaultScript}
                onChange={(e) => set('defaultScript', e.target.value)}
                placeholder={"// Esempio:\nreturn input.priority === 'critical' ? 'immediata' : 'normale'"} />
            </div>
          )}
        </div>
      </details>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btnSecondary} onClick={onCancel}>
          <X size={13} /> {t('common.cancel')}
        </button>
        <button style={btnPrimary} onClick={() => onSave(form)}>
          <Check size={13} /> {t('itilDesigner.save')}
        </button>
      </div>
    </div>
  )
}

// ── ITILTypeFields component ──────────────────────────────────────────────────

export interface ITILTypeFieldsProps {
  typeId:           string
  fields:           ITILField[]
  editingFieldId:   string | null
  setEditingFieldId: (id: string | null) => void
  addingField:      boolean
  setAddingField:   (v: boolean) => void
  onSaveField:      (typeId: string, fieldId: string | null, form: FieldFormState) => void
  onDeleteField:    (typeId: string, fieldId: string) => void
  enumTypesData:    { enumTypes: EnumTypeOption[] } | undefined
}

export function ITILTypeFields({
  typeId, fields, editingFieldId, setEditingFieldId,
  addingField, setAddingField, onSaveField, onDeleteField,
  enumTypesData,
}: ITILTypeFieldsProps) {
  const { t } = useTranslation()
  const systemFields = fields.filter((f) => f.isSystem).sort((a, b) => a.order - b.order)
  const customFields = fields.filter((f) => !f.isSystem).sort((a, b) => a.order - b.order)

  return (
    <div>
      {/* Inline add-field form */}
      {addingField && (
        <FieldEditor
          field={emptyForm(fields.length + 1)}
          isSystem={false}
          onSave={(form) => onSaveField(typeId, null, form)}
          onCancel={() => setAddingField(false)}
          enumTypesData={enumTypesData}
        />
      )}

      {/* System fields */}
      {systemFields.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em', marginBottom: 8 }}>
            CAMPI DI SISTEMA ({systemFields.length}) — non modificabili
          </div>
          {systemFields.map((f) => (
            editingFieldId === f.id ? (
              <FieldEditor
                key={f.id}
                field={fieldToForm(f)}
                isSystem={true}
                onSave={(form) => onSaveField(typeId, f.id, form)}
                onCancel={() => setEditingFieldId(null)}
                enumTypesData={enumTypesData}
              />
            ) : (
              <DesignerFieldRow
                key={f.id}
                field={f}
                onEdit={() => setEditingFieldId(f.id)}
                onDelete={() => onDeleteField(typeId, f.id)}
                editLabel={t('common.edit')}
                systemFieldLabel={t('itilDesigner.systemField')}
              />
            )
          ))}
        </div>
      )}

      {/* Custom fields */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em' }}>
            CAMPI PERSONALIZZATI ({customFields.length})
          </div>
          <button
            style={btnPrimary}
            onClick={() => { setAddingField(true); setEditingFieldId(null) }}
            disabled={addingField}
          >
            <Plus size={13} /> {t('itilDesigner.addField')}
          </button>
        </div>
        {customFields.map((f) => (
          editingFieldId === f.id ? (
            <FieldEditor
              key={f.id}
              field={fieldToForm(f)}
              isSystem={false}
              onSave={(form) => onSaveField(typeId, f.id, form)}
              onCancel={() => setEditingFieldId(null)}
              enumTypesData={enumTypesData}
            />
          ) : (
            <DesignerFieldRow
              key={f.id}
              field={f}
              onEdit={() => setEditingFieldId(f.id)}
              onDelete={() => onDeleteField(typeId, f.id)}
              editLabel={t('common.edit')}
              systemFieldLabel={t('itilDesigner.systemField')}
            />
          )
        ))}
        {customFields.length === 0 && !addingField && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: '#94a3b8', fontSize: 13, border: '1px dashed #e5e7eb', borderRadius: 8 }}>
            Nessun campo personalizzato. Clicca "+ Aggiungi campo" per aggiungerne uno.
          </div>
        )}
      </div>
    </div>
  )
}
