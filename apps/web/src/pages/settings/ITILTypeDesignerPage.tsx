import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Settings2, Lock, Trash2, Plus, X, Check } from 'lucide-react'
import { toast } from 'sonner'
import { GET_ITIL_TYPES, GET_ENUM_TYPES } from '@/graphql/queries'
import { CREATE_ITIL_FIELD, UPDATE_ITIL_FIELD, DELETE_ITIL_FIELD } from '@/graphql/mutations'

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

// ── Style constants ───────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 13, color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}

const selectS: React.CSSProperties = {
  ...inputS,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}

const labelS: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4,
}

const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: 'none', borderRadius: 6, background: 'var(--color-brand)',
  color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer',
}

const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 13, cursor: 'pointer',
}

const btnDanger: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', border: '1px solid #fecaca', borderRadius: 6, background: '#fff',
  color: '#ef4444', fontSize: 12, cursor: 'pointer',
}

const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'enum'] as const

// ── FieldForm ─────────────────────────────────────────────────────────────────

interface FieldFormState {
  name:        string
  label:       string
  fieldType:   string
  required:    boolean
  enumValues:  string[]
  order:       number
  enumMode:    'reference' | 'inline'
  enumTypeId:  string | null
}

function emptyForm(order: number): FieldFormState {
  return { name: '', label: '', fieldType: 'string', required: false, enumValues: [], order, enumMode: 'inline', enumTypeId: null }
}

function fieldToForm(f: ITILField): FieldFormState {
  const hasRef = f.fieldType === 'enum' && !!f.enumTypeId
  return {
    name:       f.name,
    label:      f.label,
    fieldType:  f.fieldType,
    required:   f.required,
    enumValues: f.enumValues ?? [],
    order:      f.order,
    enumMode:   hasRef ? 'reference' : 'inline',
    enumTypeId: hasRef ? f.enumTypeId : null,
  }
}

// ── EnumValuesEditor ──────────────────────────────────────────────────────────

function EnumValuesEditor({
  values, onChange,
}: { values: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation()
  const [newVal, setNewVal] = useState('')

  return (
    <div>
      <label style={labelS}>{t('itilDesigner.enumValues')}</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {values.map((v, i) => (
          <span
            key={i}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 10px', background: '#f1f5f9', borderRadius: 12,
              fontSize: 12, color: 'var(--color-slate-dark)',
            }}
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#94a3b8', lineHeight: 1 }}
              title={t('itilDesigner.removeEnumValue')}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          style={{ ...inputS, flex: 1 }}
          value={newVal}
          placeholder={t('itilDesigner.addEnumValue')}
          onChange={(e) => setNewVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newVal.trim()) {
              e.preventDefault()
              if (!values.includes(newVal.trim())) {
                onChange([...values, newVal.trim()])
              }
              setNewVal('')
            }
          }}
        />
        <button
          type="button"
          style={{ ...btnSecondary, padding: '7px 12px' }}
          onClick={() => {
            if (newVal.trim() && !values.includes(newVal.trim())) {
              onChange([...values, newVal.trim()])
            }
            setNewVal('')
          }}
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  )
}

// ── FieldEditor ───────────────────────────────────────────────────────────────

interface EnumTypeRef {
  id:     string
  label:  string
  values: string[]
  scope:  string
}

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
          {/* Enum mode toggle */}
          <div style={{ marginBottom: 10 }}>
            <label style={labelS}>Tipo enum</label>
            <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="radio"
                  name="enumMode"
                  value="inline"
                  checked={form.enumMode === 'inline'}
                  onChange={() => setForm((f) => ({ ...f, enumMode: 'inline', enumTypeId: null }))}
                />
                Valori personalizzati
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="radio"
                  name="enumMode"
                  value="reference"
                  checked={form.enumMode === 'reference'}
                  onChange={() => setForm((f) => ({ ...f, enumMode: 'reference', enumValues: [] }))}
                />
                Usa enum esistente
              </label>
            </div>

            {form.enumMode === 'reference' && (
              <div>
                <label htmlFor="enum-ref" style={labelS}>Enum di riferimento</label>
                <select
                  id="enum-ref"
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
                          style={{
                            padding: '2px 8px', background: '#f0f4ff',
                            borderRadius: 12, fontSize: 11, color: 'var(--color-brand)',
                          }}
                        >
                          {v}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            )}

            {form.enumMode === 'inline' && (
              <EnumValuesEditor
                values={form.enumValues}
                onChange={(v) => set('enumValues', v)}
              />
            )}
          </div>
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

// ── FieldRow ──────────────────────────────────────────────────────────────────

function FieldRow({
  field,
  onEdit,
  onDelete,
}: {
  field: ITILField
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', background: '#fff', border: '1px solid #e5e7eb',
        borderRadius: 6, marginBottom: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
        {field.isSystem ? (
          <span title={t('itilDesigner.systemField')}><Lock size={12} color="#94a3b8" style={{ flexShrink: 0 }} /></span>
        ) : (
          <div style={{ width: 12 }} />
        )}
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-slate-dark)' }}>
            {field.label}
            <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6, fontWeight: 400 }}>
              {field.name}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>
            {field.fieldType}
            {field.required && <span style={{ marginLeft: 6, color: '#ef4444' }}>required</span>}
            {field.fieldType === 'enum' && field.enumValues.length > 0 && (
              <span style={{ marginLeft: 6 }}>
                [{field.enumValues.join(', ')}]
              </span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={btnSecondary} onClick={onEdit}>{t('common.edit')}</button>
        {!field.isSystem && (
          <button style={btnDanger} onClick={onDelete}>
            <Trash2 size={12} />
          </button>
        )}
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
    // Auto-select first type
    setSelectedTypeId(selectedType.id)
  }

  const handleSaveField = (typeId: string, fieldId: string | null, form: FieldFormState) => {
    const isRef = form.fieldType === 'enum' && form.enumMode === 'reference' && !!form.enumTypeId

    const variables = {
      typeId,
      input: {
        name:       form.name,
        label:      form.label,
        fieldType:  form.fieldType,
        required:   form.required,
        // Send inline values only when not using an enum reference
        enumValues: form.fieldType === 'enum' && !isRef ? form.enumValues : [],
        // Send enumTypeId when in reference mode (backend creates USES_ENUM)
        enumTypeId: isRef ? form.enumTypeId : null,
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
        <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
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
                    border: isSelected ? '1px solid var(--color-brand)' : '1px solid #e5e7eb',
                    borderRadius: 8, background: isSelected ? '#f0f9ff' : '#fff',
                    color: isSelected ? 'var(--color-brand)' : 'var(--color-slate-dark)',
                    fontWeight: isSelected ? 600 : 400, fontSize: 14,
                    cursor: 'pointer', marginBottom: 4,
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                >
                  <Settings2 size={14} style={{ flexShrink: 0 }} />
                  {itilType.label}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94a3b8' }}>
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
                          <FieldRow
                            key={f.id}
                            field={f}
                            onEdit={() => setEditingFieldId(f.id)}
                            onDelete={() => handleDeleteField(selectedType.id, f.id)}
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
                          <FieldRow
                            key={f.id}
                            field={f}
                            onEdit={() => setEditingFieldId(f.id)}
                            onDelete={() => handleDeleteField(selectedType.id, f.id)}
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
