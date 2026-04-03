import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Settings2, Plus, X, Check } from 'lucide-react'
import { toast } from 'sonner'
import { GET_ITIL_TYPES, GET_ENUM_TYPES } from '@/graphql/queries'
import { CREATE_ITIL_FIELD, UPDATE_ITIL_FIELD, DELETE_ITIL_FIELD } from '@/graphql/mutations'
import {
  inputS, selectS, labelS, btnPrimary, btnSecondary, FIELD_TYPES,
  activeCardStyle, inactiveCardStyle,
} from './shared/designerStyles'
import type { EnumTypeRef } from './shared/designerStyles'
import { DesignerFieldRow } from './shared/DesignerFieldRow'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ITILField {
  id:           string
  name:         string
  label:        string
  fieldType:    string
  required:     boolean
  enumValues:   string[]
  order:        number
  isSystem:     boolean
  enumTypeId:   string | null
  enumTypeName: string | null
}

interface ITILType {
  id:     string
  name:   string
  label:  string
  active: boolean
  fields: ITILField[]
}

// ── FieldForm ─────────────────────────────────────────────────────────────────

interface FieldFormState {
  name:       string
  label:      string
  fieldType:  string
  required:   boolean
  order:      number
  enumTypeId: string | null
}

function emptyForm(order: number): FieldFormState {
  return { name: '', label: '', fieldType: 'string', required: false, order, enumTypeId: null }
}

function fieldToForm(f: ITILField): FieldFormState {
  return {
    name:       f.name,
    label:      f.label,
    fieldType:  f.fieldType,
    required:   f.required,
    order:      f.order,
    enumTypeId: f.enumTypeId ?? null,
  }
}

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
  const set = (key: keyof FieldFormState, val: unknown) =>
    setForm((f) => ({ ...f, [key]: val }))

  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, marginBottom: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelS}>{t('itilDesigner.fieldName')}</label>
          <input
            style={{ ...inputS, background: isSystem ? '#f1f5f9' : '#fff' }}
            value={form.name}
            disabled={isSystem}
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelS}>{t('itilDesigner.fieldType')}</label>
          <select
            style={{ ...selectS, background: isSystem ? '#f1f5f9' : '#fff' }}
            value={form.fieldType}
            disabled={isSystem}
            onChange={(e) => set('fieldType', e.target.value)}
          >
            {FIELD_TYPES.map((ft) => (
              <option key={ft} value={ft}>{ft}</option>
            ))}
          </select>
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

      {form.fieldType === 'enum' && (
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="itil-enum-ref" style={labelS}>Enum di riferimento *</label>
          <select
            id="itil-enum-ref"
            style={selectS}
            value={form.enumTypeId ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, enumTypeId: e.target.value || null }))}
          >
            <option value="">— Seleziona enum —</option>
            {(enumTypesData?.enumTypes ?? []).map((e) => (
              <option key={e.id} value={e.id}>{e.label} ({e.scope})</option>
            ))}
          </select>
          {form.enumTypeId && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {(enumTypesData?.enumTypes ?? [])
                .find((e) => e.id === form.enumTypeId)
                ?.values.map((v) => (
                  <span
                    key={v}
                    style={{ padding: '2px 8px', background: '#f0f4ff', borderRadius: 12, fontSize: 11, color: 'var(--color-brand)' }}
                  >
                    {v}
                  </span>
                ))}
            </div>
          )}
        </div>
      )}

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

// ── Main page ─────────────────────────────────────────────────────────────────

export function ITILTypeDesignerPage() {
  const { t } = useTranslation()
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [addingField, setAddingField] = useState(false)

  const { data, loading, refetch } = useQuery<{ itilTypes: ITILType[] }>(GET_ITIL_TYPES, {
    fetchPolicy: 'cache-and-network',
  })

  const { data: enumTypesData } = useQuery<{ enumTypes: EnumTypeRef[] }>(GET_ENUM_TYPES, {
    fetchPolicy: 'cache-and-network',
  })

  const [createField] = useMutation(CREATE_ITIL_FIELD, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); setAddingField(false); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [updateField] = useMutation(UPDATE_ITIL_FIELD, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); setEditingFieldId(null); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const [deleteField] = useMutation(DELETE_ITIL_FIELD, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const itilTypes = data?.itilTypes ?? []
  const selectedType = itilTypes.find((t) => t.id === selectedTypeId) ?? (itilTypes[0] ?? null)

  if (!selectedTypeId && itilTypes.length > 0 && selectedType) {
    setSelectedTypeId(selectedType.id)
  }

  const handleSaveField = (typeId: string, fieldId: string | null, form: FieldFormState) => {
    if (form.fieldType === 'enum' && !form.enumTypeId) {
      toast.error('Seleziona un enum di riferimento per i campi di tipo enum')
      return
    }
    const variables = {
      typeId,
      input: {
        name:       form.name,
        label:      form.label,
        fieldType:  form.fieldType,
        required:   form.required,
        enumTypeId: form.fieldType === 'enum' ? form.enumTypeId : null,
        order:      form.order,
      },
    }
    if (fieldId) {
      void updateField({ variables: { ...variables, fieldId } })
    } else {
      void createField({ variables })
    }
  }

  const handleDeleteField = (typeId: string, fieldId: string) => {
    if (!confirm(t('common.confirm') + '?')) return
    void deleteField({ variables: { typeId, fieldId } })
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 className="ty-page-title" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <Settings2 size={22} color="var(--color-brand)" />
          {t('itilDesigner.title')}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 0 }}>
          {t('itilDesigner.subtitle')}
        </p>
      </div>

      {loading && (
        <div style={{ color: 'var(--color-slate-light)', fontSize: 13, padding: 16 }}>
          {t('common.loading')}
        </div>
      )}

      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20 }}>
          {/* Left: Type list */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em', marginBottom: 8 }}>
              ENTITÀ ITIL
            </div>
            {itilTypes.map((itilType) => {
              const isSelected = itilType.id === selectedTypeId
              return (
                <button
                  key={itilType.id}
                  onClick={() => { setSelectedTypeId(itilType.id); setEditingFieldId(null); setAddingField(false) }}
                  style={{
                    width: '100%', textAlign: 'left', padding: '10px 14px',
                    ...(isSelected ? activeCardStyle : inactiveCardStyle),
                    fontWeight: isSelected ? 600 : 400, fontSize: 14,
                    cursor: 'pointer', marginBottom: 4, borderRadius: 8,
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                >
                  <Settings2 size={14} style={{ flexShrink: 0 }} />
                  {itilType.label}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>
                    {itilType.fields.length}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Right: Fields panel */}
          {selectedType && (
            <div>
              <div style={{
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
                padding: '20px 24px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                  <div>
                    <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
                      {selectedType.label}
                    </h2>
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: '2px 0 0' }}>
                      {selectedType.fields.length} campi
                    </p>
                  </div>
                  <button
                    style={btnPrimary}
                    onClick={() => { setAddingField(true); setEditingFieldId(null) }}
                    disabled={addingField}
                  >
                    <Plus size={13} /> {t('itilDesigner.addField')}
                  </button>
                </div>

                {/* Add new field form */}
                {addingField && (
                  <FieldEditor
                    field={emptyForm(selectedType.fields.length + 1)}
                    isSystem={false}
                    onSave={(form) => handleSaveField(selectedType.id, null, form)}
                    onCancel={() => setAddingField(false)}
                    enumTypesData={enumTypesData}
                  />
                )}

                {/* System fields */}
                {selectedType.fields.filter((f) => f.isSystem).length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em', marginBottom: 8 }}>
                      CAMPI DI SISTEMA
                    </div>
                    {selectedType.fields
                      .filter((f) => f.isSystem)
                      .sort((a, b) => a.order - b.order)
                      .map((f) => (
                        editingFieldId === f.id ? (
                          <FieldEditor
                            key={f.id}
                            field={fieldToForm(f)}
                            isSystem={true}
                            onSave={(form) => handleSaveField(selectedType.id, f.id, form)}
                            onCancel={() => setEditingFieldId(null)}
                            enumTypesData={enumTypesData}
                          />
                        ) : (
                          <DesignerFieldRow
                            key={f.id}
                            field={f}
                            onEdit={() => setEditingFieldId(f.id)}
                            onDelete={() => handleDeleteField(selectedType.id, f.id)}
                            editLabel={t('common.edit')}
                            systemFieldLabel={t('itilDesigner.systemField')}
                          />
                        )
                      ))}
                  </div>
                )}

                {/* Custom fields */}
                {selectedType.fields.filter((f) => !f.isSystem).length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em', marginBottom: 8 }}>
                      CAMPI PERSONALIZZATI
                    </div>
                    {selectedType.fields
                      .filter((f) => !f.isSystem)
                      .sort((a, b) => a.order - b.order)
                      .map((f) => (
                        editingFieldId === f.id ? (
                          <FieldEditor
                            key={f.id}
                            field={fieldToForm(f)}
                            isSystem={false}
                            onSave={(form) => handleSaveField(selectedType.id, f.id, form)}
                            onCancel={() => setEditingFieldId(null)}
                            enumTypesData={enumTypesData}
                          />
                        ) : (
                          <DesignerFieldRow
                            key={f.id}
                            field={f}
                            onEdit={() => setEditingFieldId(f.id)}
                            onDelete={() => handleDeleteField(selectedType.id, f.id)}
                            editLabel={t('common.edit')}
                            systemFieldLabel={t('itilDesigner.systemField')}
                          />
                        )
                      ))}
                  </div>
                )}

                {selectedType.fields.filter((f) => !f.isSystem).length === 0 && !addingField && (
                  <div style={{
                    padding: '32px 16px', textAlign: 'center',
                    color: 'var(--color-slate-light)', fontSize: 13,
                    border: '1px dashed #e5e7eb', borderRadius: 8,
                  }}>
                    Nessun campo personalizzato. Clicca "+ Aggiungi campo" per aggiungerne uno.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
