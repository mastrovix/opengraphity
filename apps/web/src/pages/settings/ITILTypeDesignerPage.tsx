import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { Settings2, Plus, X, Check, AlertCircle, Search, GitPullRequest, Inbox } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { CIIcon } from '@/lib/ciIcon'
import { CIDynamicForm } from '@/components/CIDynamicForm'
import type { CITypeDef } from '@/contexts/MetamodelContext'
import { GET_ITIL_TYPES, GET_ENUM_TYPES, GET_CI_TYPES, GET_ITIL_CI_RELATION_RULES } from '@/graphql/queries'
import {
  CREATE_ITIL_FIELD, UPDATE_ITIL_FIELD, DELETE_ITIL_FIELD, UPDATE_ITIL_TYPE,
  CREATE_ITIL_CI_RELATION_RULE, DELETE_ITIL_CI_RELATION_RULE,
} from '@/graphql/mutations'
import {
  inputS, selectS, textareaS, labelS, btnPrimary, btnSecondary, FIELD_TYPES,
} from './shared/designerStyles'
import type { EnumTypeRef } from './shared/designerStyles'
import { DesignerFieldRow } from './shared/DesignerFieldRow'
import { FieldRulesPanel } from './shared/FieldRulesPanel'
import { FormField } from './citype/CIFieldInlineEditor'

// ── Constants ─────────────────────────────────────────────────────────────────

const ITIL_TYPE_ICONS: Record<string, LucideIcon> = {
  incident:        AlertCircle,
  problem:         Search,
  change:          GitPullRequest,
  service_request: Inbox,
}

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock', 'alert-circle', 'bug', 'git-pull-request', 'inbox']

const ITIL_WORKFLOW_STEPS: Record<string, string[]> = {
  incident:        ['new', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved', 'closed'],
  problem:         ['open', 'under_investigation', 'deferred', 'change_requested', 'resolved', 'closed'],
  change:          ['draft', 'assessment', 'approval', 'approved', 'scheduled', 'deploying', 'validating', 'implemented'],
  service_request: ['new', 'in_progress', 'pending', 'resolved', 'closed'],
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ITILField {
  id:               string
  name:             string
  label:            string
  fieldType:        string
  required:         boolean
  enumValues:       string[]
  order:            number
  isSystem:         boolean
  enumTypeId:       string | null
  enumTypeName:     string | null
  validationScript: string | null
  visibilityScript: string | null
  defaultScript:    string | null
}

interface ITILType {
  id:               string
  name:             string
  label:            string
  icon:             string
  color:            string
  active:           boolean
  validationScript: string | null
  fields:           ITILField[]
}

interface ITILCIRelationRule {
  id:           string
  itilType:     string
  ciType:       string
  relationType: string
  direction:    string
  description:  string | null
}

interface EnumTypeOption extends EnumTypeRef { name: string }

type Tab = 'settings' | 'fields' | 'relations' | 'rules' | 'preview'

// ── FieldEditor (inline) ──────────────────────────────────────────────────────

interface FieldFormState {
  name:             string
  label:            string
  fieldType:        string
  required:         boolean
  order:            number
  enumTypeId:       string | null
  validationScript: string
  visibilityScript: string
  defaultScript:    string
}

function emptyForm(order: number): FieldFormState {
  return { name: '', label: '', fieldType: 'string', required: false, order, enumTypeId: null, validationScript: '', visibilityScript: '', defaultScript: '' }
}

function fieldToForm(f: ITILField): FieldFormState {
  return {
    name:             f.name,
    label:            f.label,
    fieldType:        f.fieldType,
    required:         f.required,
    order:            f.order,
    enumTypeId:       f.enumTypeId       ?? null,
    validationScript: f.validationScript ?? '',
    visibilityScript: f.visibilityScript ?? '',
    defaultScript:    f.defaultScript    ?? '',
  }
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

      {/* scripts (collapsible) — identical to CIFieldInlineEditor */}
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

// ── Main page ─────────────────────────────────────────────────────────────────

export function ITILTypeDesignerPage() {
  const { t } = useTranslation()
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [addingField, setAddingField]       = useState(false)
  const [activeTab, setActiveTab]           = useState<Tab>('settings')
  const [settingsForm, setSettingsForm]     = useState<{ label: string; icon: string; color: string; validationScript: string } | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [showRelForm, setShowRelForm]       = useState(false)
  const [relForm, setRelForm]               = useState({ ciType: '', relationType: '', direction: 'outgoing', description: '' })

  const { data, loading, refetch } = useQuery<{ itilTypes: ITILType[] }>(GET_ITIL_TYPES, {
    fetchPolicy: 'cache-and-network',
  })

  const { data: enumTypesData } = useQuery<{ enumTypes: EnumTypeOption[] }>(GET_ENUM_TYPES, {
    fetchPolicy: 'cache-and-network',
  })

  const { data: ciTypesData } = useQuery<{ ciTypes: { id: string; name: string; label: string }[] }>(GET_CI_TYPES, {
    fetchPolicy: 'cache-and-network',
  })

  const { data: ciRulesData, refetch: refetchRules } = useQuery<{ itilCIRelationRules: ITILCIRelationRule[] }>(
    GET_ITIL_CI_RELATION_RULES,
    {
      variables:   { itilType: selectedTypeId ? (data?.itilTypes.find((t) => t.id === selectedTypeId)?.name ?? '') : '' },
      skip:        !selectedTypeId || activeTab !== 'relations',
      fetchPolicy: 'cache-and-network',
    },
  )

  const [updateType]  = useMutation(UPDATE_ITIL_TYPE, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); setSettingsSaving(false); void refetch() },
    onError:     (e) => { toast.error(e.message); setSettingsSaving(false) },
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

  const [createRule] = useMutation(CREATE_ITIL_CI_RELATION_RULE, {
    onCompleted: () => {
      toast.success(t('itilDesigner.saved'))
      setShowRelForm(false)
      setRelForm({ ciType: '', relationType: '', direction: 'outgoing', description: '' })
      void refetchRules()
    },
    onError: (e) => toast.error(e.message),
  })

  const [deleteRule] = useMutation(DELETE_ITIL_CI_RELATION_RULE, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); void refetchRules() },
    onError: (e) => toast.error(e.message),
  })

  const itilTypes   = data?.itilTypes ?? []
  const selectedType = itilTypes.find((t) => t.id === selectedTypeId) ?? (itilTypes[0] ?? null)

  if (!selectedTypeId && itilTypes.length > 0 && selectedType) {
    setSelectedTypeId(selectedType.id)
    setSettingsForm({
      label:            selectedType.label,
      icon:             selectedType.icon  ?? '',
      color:            selectedType.color ?? '#0284c7',
      validationScript: selectedType.validationScript ?? '',
    })
  }

  const handleSelectType = (t: ITILType) => {
    setSelectedTypeId(t.id)
    setActiveTab('settings')
    setEditingFieldId(null)
    setAddingField(false)
    setShowRelForm(false)
    setSettingsForm({
      label:            t.label,
      icon:             t.icon  ?? '',
      color:            t.color ?? '#0284c7',
      validationScript: t.validationScript ?? '',
    })
  }

  const handleSaveSettings = async () => {
    if (!selectedType || !settingsForm) return
    setSettingsSaving(true)
    await updateType({ variables: { id: selectedType.id, input: {
      label:            settingsForm.label,
      icon:             settingsForm.icon             || null,
      color:            settingsForm.color            || null,
      validationScript: settingsForm.validationScript || null,
    } } })
  }

  const handleSaveField = (typeId: string, fieldId: string | null, form: FieldFormState) => {
    if (form.fieldType === 'enum' && !form.enumTypeId) {
      toast.error('Seleziona un enum di riferimento per i campi di tipo enum')
      return
    }
    const variables = {
      typeId,
      input: {
        name:             form.name,
        label:            form.label,
        fieldType:        form.fieldType,
        required:         form.required,
        enumTypeId:       form.fieldType === 'enum' ? form.enumTypeId : null,
        order:            form.order,
        validationScript: form.validationScript || null,
        visibilityScript: form.visibilityScript || null,
        defaultScript:    form.defaultScript    || null,
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
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Settings2 size={22} color="var(--color-brand)" />}>
          {t('itilDesigner.title')}
        </PageTitle>
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
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'start' }}>

          {/* Left: Type list */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{
              padding: '5px 16px 4px', fontSize: 10, fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.06em',
              color: '#94a3b8', background: '#f9fafb',
              borderBottom: '1px solid #f3f4f6',
            }}>
              ITIL Types
            </div>
            <div>
              {itilTypes.map((itilType) => {
                const isSelected = itilType.id === selectedTypeId
                const FallbackIcon = ITIL_TYPE_ICONS[itilType.name] ?? Settings2
                return (
                  <button
                    key={itilType.id}
                    onClick={() => handleSelectType(itilType)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '10px 16px',
                      background: isSelected ? '#f0f9ff' : 'transparent',
                      borderLeft: `3px solid ${isSelected ? 'var(--color-brand)' : 'transparent'}`,
                      borderTop: 'none', borderRight: 'none',
                      borderBottom: '1px solid #f3f4f6',
                      cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}
                  >
                    {itilType.icon ? (
                      <CIIcon icon={itilType.icon} size={15} color={isSelected ? 'var(--color-brand)' : '#64748b'} />
                    ) : (
                      <FallbackIcon size={15} color={isSelected ? 'var(--color-brand)' : '#64748b'} style={{ flexShrink: 0 }} />
                    )}
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--color-brand)' : 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {itilType.label}
                    </span>
                    <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
                      {itilType.fields.length} campi
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Right: Type editor */}
          {selectedType && settingsForm && (() => {
            const FallbackIcon = ITIL_TYPE_ICONS[selectedType.name] ?? Settings2
            const systemFields = selectedType.fields.filter((f) => f.isSystem).sort((a, b) => a.order - b.order)
            const customFields = selectedType.fields.filter((f) => !f.isSystem).sort((a, b) => a.order - b.order)

            // Cast to CITypeDef for preview
            const previewType: CITypeDef = {
              id:               selectedType.id,
              name:             selectedType.name,
              label:            selectedType.label,
              icon:             selectedType.icon  || '',
              color:            selectedType.color || '#0284c7',
              active:           selectedType.active,
              validationScript: selectedType.validationScript ?? null,
              relations:        [],
              systemRelations:  [],
              fields:           selectedType.fields.map((f) => ({
                ...f,
                defaultValue:     null,
                validationScript: null,
                visibilityScript: null,
                defaultScript:    null,
              })),
            }

            return (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>

                {/* Card header — identical to CI Designer */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {selectedType.icon ? (
                      <CIIcon icon={selectedType.icon} size={20} color={selectedType.color ?? 'var(--color-brand)'} />
                    ) : (
                      <FallbackIcon size={20} color="var(--color-brand)" style={{ flexShrink: 0 }} />
                    )}
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                        {selectedType.label}
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8' }}>{selectedType.name}</div>
                    </div>
                    <button
                      style={{ marginLeft: 8, padding: '3px 10px', border: '1px solid #e5e7eb', borderRadius: 100, fontSize: 12, cursor: 'default', background: '#dcfce7', color: '#16a34a', fontWeight: 500 }}>
                      ● active
                    </button>
                  </div>
                </div>

                {/* Tabs — identical style to CI Designer */}
                <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 20px' }}>
                  {(['settings', 'fields', 'relations', 'rules', 'preview'] as Tab[]).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => { setActiveTab(tab); setEditingFieldId(null); setAddingField(false) }}
                      style={{ padding: '10px 14px', border: 'none', borderBottom: activeTab === tab ? '2px solid var(--color-brand)' : '2px solid transparent', marginBottom: -1, background: 'none', fontSize: 13, cursor: 'pointer', color: activeTab === tab ? 'var(--color-brand)' : 'var(--color-slate)', fontWeight: activeTab === tab ? 600 : 400 }}
                    >
                      {tab === 'settings' ? 'Impostazioni' : tab === 'fields' ? 'Campi' : tab === 'relations' ? 'Relazioni CI' : tab === 'rules' ? 'Regole' : 'Preview'}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div style={{ padding: '20px 24px' }}>

                  {/* ── Tab: Impostazioni ── */}
                  {activeTab === 'settings' && (
                    <div style={{ maxWidth: 480 }}>
                      <FormField label="Label">
                        <input
                          style={inputS}
                          value={settingsForm.label}
                          onChange={(e) => setSettingsForm((p) => p && ({ ...p, label: e.target.value }))}
                        />
                      </FormField>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
                        <FormField label="Icona">
                          <select
                            style={selectS}
                            value={settingsForm.icon}
                            onChange={(e) => setSettingsForm((p) => p && ({ ...p, icon: e.target.value }))}
                          >
                            <option value="">— nessuna —</option>
                            {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
                          </select>
                        </FormField>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 20 }}>
                          {settingsForm.icon ? (
                            <CIIcon icon={settingsForm.icon} size={24} color={settingsForm.color || 'var(--color-brand)'} />
                          ) : (
                            <FallbackIcon size={24} color={settingsForm.color || 'var(--color-brand)'} />
                          )}
                        </div>
                      </div>

                      <FormField label="Colore">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="color"
                            value={settingsForm.color}
                            onChange={(e) => setSettingsForm((p) => p && ({ ...p, color: e.target.value }))}
                            style={{ width: 36, height: 36, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }}
                          />
                          <span style={{ fontSize: 12, color: 'var(--color-slate)' }}>{settingsForm.color}</span>
                        </div>
                      </FormField>

                      <FormField label="Validation script (opzionale)">
                        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 6px' }}>
                          Variabili: <code>input</code>. Usa <code>throw 'msg'</code> per errore globale.
                        </p>
                        <textarea
                          style={{ ...textareaS, minHeight: 100 }}
                          value={settingsForm.validationScript}
                          onChange={(e) => setSettingsForm((p) => p && ({ ...p, validationScript: e.target.value }))}
                          placeholder={"// Esempio:\nif (!input.title) throw 'Titolo obbligatorio'"}
                        />
                      </FormField>

                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          style={{ ...btnPrimary, opacity: settingsSaving ? 0.6 : 1 }}
                          disabled={settingsSaving}
                          onClick={() => void handleSaveSettings()}
                        >
                          {settingsSaving ? 'Salvataggio…' : 'Salva impostazioni'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ── Tab: Campi ── */}
                  {activeTab === 'fields' && (
                    <div>
                      {/* Inline add-field form */}
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
                        {customFields.length === 0 && !addingField && (
                          <div style={{ padding: '32px 16px', textAlign: 'center', color: '#94a3b8', fontSize: 13, border: '1px dashed #e5e7eb', borderRadius: 8 }}>
                            Nessun campo personalizzato. Clicca "+ Aggiungi campo" per aggiungerne uno.
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── Tab: Relazioni CI ── */}
                  {activeTab === 'relations' && (() => {
                    const rules    = ciRulesData?.itilCIRelationRules ?? []
                    const ciTypes  = ciTypesData?.ciTypes ?? []
                    const usedCITypes = new Set(rules.map((r) => r.ciType.toLowerCase()))
                    const RELATION_SUGGESTIONS = ['IMPACTS', 'AFFECTED_BY', 'MODIFIES', 'TARGETS', 'ROOT_CAUSE', 'DEPENDS_ON', 'HOSTED_ON']

                    return (
                      <div>
                        {/* Add-relation inline form */}
                        {showRelForm ? (
                          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                              <div>
                                <label style={labelS}>{t('itilDesigner.ciRelations.ciType')} *</label>
                                <select style={selectS} value={relForm.ciType}
                                  onChange={(e) => setRelForm((f) => ({ ...f, ciType: e.target.value }))}>
                                  <option value="">{t('itilDesigner.ciRelations.selectCIType')}</option>
                                  {ciTypes
                                    .filter((ct) => !usedCITypes.has(ct.name.toLowerCase()))
                                    .map((ct) => (
                                    <option key={ct.id} value={ct.name}>{ct.label}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label style={labelS}>{t('itilDesigner.ciRelations.relationType')} *</label>
                                <input style={inputS} list="rel-type-suggestions"
                                  value={relForm.relationType}
                                  onChange={(e) => setRelForm((f) => ({ ...f, relationType: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))}
                                  placeholder="IMPACTS" />
                                <datalist id="rel-type-suggestions">
                                  {RELATION_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
                                </datalist>
                                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>{t('itilDesigner.ciRelations.suggestions')}</div>
                              </div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                              <div>
                                <label style={labelS}>{t('itilDesigner.ciRelations.direction')}</label>
                                <select style={selectS} value={relForm.direction}
                                  onChange={(e) => setRelForm((f) => ({ ...f, direction: e.target.value }))}>
                                  <option value="outgoing">{t('itilDesigner.ciRelations.outgoing')}</option>
                                  <option value="incoming">{t('itilDesigner.ciRelations.incoming')}</option>
                                </select>
                              </div>
                              <div>
                                <label style={labelS}>{t('itilDesigner.ciRelations.description')}</label>
                                <input style={inputS} value={relForm.description}
                                  onChange={(e) => setRelForm((f) => ({ ...f, description: e.target.value }))}
                                  placeholder="Es. Server impattati dall'incident" />
                              </div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                              <button style={btnSecondary} onClick={() => setShowRelForm(false)}>
                                <X size={13} /> {t('itilDesigner.ciRelations.cancel')}
                              </button>
                              <button style={btnPrimary}
                                disabled={!relForm.ciType || !relForm.relationType}
                                onClick={() => void createRule({ variables: {
                                  itilType:     selectedType.name,
                                  ciType:       relForm.ciType,
                                  relationType: relForm.relationType,
                                  direction:    relForm.direction,
                                  description:  relForm.description || null,
                                } })}>
                                <Check size={13} /> {t('itilDesigner.ciRelations.add')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                            <button style={btnPrimary} onClick={() => setShowRelForm(true)}>
                              <Plus size={13} /> {t('itilDesigner.ciRelations.addRelation')}
                            </button>
                          </div>
                        )}

                        {/* Rules table */}
                        {rules.length === 0 ? (
                          <p style={{ color: '#94a3b8', fontSize: 13 }}>{t('itilDesigner.ciRelations.empty')}</p>
                        ) : (
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                              <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                                {[
                                  t('itilDesigner.ciRelations.ciType'),
                                  t('itilDesigner.ciRelations.relationType'),
                                  t('itilDesigner.ciRelations.direction'),
                                  t('itilDesigner.ciRelations.description'),
                                  '',
                                ].map((h) => (
                                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {rules.map((rule) => {
                                const ciLabel = ciTypes.find((ct) => ct.name === rule.ciType)?.label ?? rule.ciType
                                return (
                                  <tr key={rule.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                    <td style={{ padding: '8px' }}><span style={{ padding: '2px 8px', borderRadius: 4, background: '#eff6ff', color: '#2563eb', fontSize: 12, fontWeight: 500 }}>{ciLabel}</span></td>
                                    <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-dark)' }}>{rule.relationType}</td>
                                    <td style={{ padding: '8px' }}>
                                      <span style={{ padding: '2px 8px', borderRadius: 4, background: rule.direction === 'outgoing' ? '#f0fdf4' : '#fef9c3', color: rule.direction === 'outgoing' ? '#16a34a' : '#854d0e', fontSize: 11 }}>
                                        {rule.direction === 'outgoing' ? '→' : '←'} {rule.direction}
                                      </span>
                                    </td>
                                    <td style={{ padding: '8px', color: '#64748b', fontSize: 12 }}>{rule.description ?? '—'}</td>
                                    <td style={{ padding: '8px' }}>
                                      <button
                                        style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', color: '#dc2626', fontSize: 12 }}
                                        onClick={() => { if (!confirm(t('itilDesigner.ciRelations.confirmDelete'))) return; void deleteRule({ variables: { id: rule.id } }) }}
                                      ><X size={12} /></button>
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )
                  })()}

                  {/* ── Tab: Regole ── */}
                  {activeTab === 'rules' && (
                    <FieldRulesPanel
                      flat
                      entityType={selectedType.name}
                      fields={selectedType.fields.map((f) => ({
                        name:       f.name,
                        label:      f.label,
                        fieldType:  f.fieldType,
                        enumValues: f.enumValues,
                      }))}
                      workflowSteps={ITIL_WORKFLOW_STEPS[selectedType.name] ?? []}
                    />
                  )}

                  {/* ── Tab: Preview ── */}
                  {activeTab === 'preview' && (
                    <div style={{ maxWidth: 520 }}>
                      <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 16 }}>
                        Anteprima del form — tutti i campi visibili.
                      </p>
                      {selectedType.fields.length === 0
                        ? <p style={{ fontSize: 13, color: '#94a3b8' }}>Nessun campo. Aggiungi campi nella tab "Campi".</p>
                        : <CIDynamicForm
                            ciType={previewType}
                            onSubmit={async () => { toast.info('Preview — nessun dato salvato') }}
                            onCancel={() => setActiveTab('fields')}
                          />
                      }
                    </div>
                  )}

                </div>
              </div>
            )
          })()}
        </div>
      )}

    </PageContainer>
  )
}
