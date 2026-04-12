import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { Layers, Layout, Plus, Trash2 } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { PageContainer } from '@/components/PageContainer'
import { toast } from 'sonner'
import { GET_CI_TYPES, GET_BASE_CI_TYPE, GET_ENUM_TYPES } from '@/graphql/queries'
import {
  CREATE_CI_TYPE, UPDATE_CI_TYPE, DELETE_CI_TYPE,
  ADD_CI_FIELD, REMOVE_CI_FIELD,
  ADD_CI_RELATION, REMOVE_CI_RELATION,
} from '@/graphql/mutations'
import { EmptyState } from '@/components/EmptyState'
import { CIIcon } from '@/lib/ciIcon'
import { CIDynamicForm } from '@/components/CIDynamicForm'
import type { CITypeDef, CIFieldDef, CIRelationDef } from '@/contexts/MetamodelContext'
import { CITypeList } from './citype/CITypeList'
import { CIFieldEditor, fieldToForm } from './citype/CIFieldEditor'
import type { FieldForm } from './citype/CIFieldEditor'
import { CIRelationEditor, CIRelationTable } from './citype/CIRelationEditor'
import type { RelationForm } from './citype/CIRelationEditor'
import {
  inputS, selectS, textareaS,
  btnPrimary, btnDanger,
} from './shared/designerStyles'
import type { EnumTypeRef } from './shared/designerStyles'
import { DesignerFieldRow } from './shared/DesignerFieldRow'
import { CIFieldInlineEditor, FormField } from './citype/CIFieldInlineEditor'
import { CreateTypeDialog } from './citype/CreateTypeDialog'
import { FieldRulesPanel } from './shared/FieldRulesPanel'

// ── Style helpers ──────────────────────────────────────────────────────────────

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock']

interface EnumTypeOption extends EnumTypeRef { name: string }

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'settings' | 'fields' | 'relations' | 'rules' | 'preview'

export function CITypeDesignerPage() {
  const { t } = useTranslation()
  const { data, loading, refetch } = useQuery<{ ciTypes: CITypeDef[] }>(GET_CI_TYPES)
  const { data: baseData, refetch: refetchBase } = useQuery<{ baseCIType: CITypeDef }>(GET_BASE_CI_TYPE)
  const { data: enumData } = useQuery<{ enumTypes: EnumTypeOption[] }>(GET_ENUM_TYPES, {
    fetchPolicy: 'cache-and-network',
  })
  const ciTypes: CITypeDef[] = data?.ciTypes ?? []
  const baseType: CITypeDef | null = baseData?.baseCIType ?? null
  const enumTypes = enumData?.enumTypes ?? []

  const [selectedId, setSelectedId]     = useState<string | null>(null)
  const [selectedBase, setSelectedBase] = useState(false)
  const [showCreate, setShowCreate]     = useState(false)
  const [activeTab, setActiveTab]       = useState<Tab>('settings')

  // Inline field editing state (fields tab)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [addingField, setAddingField]       = useState(false)

  // Base type field editing (still modal for base type)
  const [showBaseFieldModal, setShowBaseFieldModal] = useState(false)
  const [editingBaseField, setEditingBaseField]     = useState<CIFieldDef | null>(null)

  const [showRelModal, setShowRelModal] = useState(false)

  const [settingsForm, setSettingsForm] = useState<{ label: string; icon: string; color: string; validationScript: string; chainFamilies: string[] } | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)

  const selected = ciTypes.find((t) => t.id === selectedId) ?? null

  const selectType = (t: CITypeDef) => {
    setSelectedBase(false)
    setSelectedId(t.id)
    setActiveTab('settings')
    setEditingFieldId(null)
    setAddingField(false)
    setSettingsForm({ label: t.label, icon: t.icon ?? 'box', color: t.color ?? 'var(--color-brand)', validationScript: t.validationScript ?? '', chainFamilies: t.chainFamilies ?? [] })
  }

  const [createType]    = useMutation(CREATE_CI_TYPE,    { onCompleted: () => { void refetch(); toast.success('Tipo creato') } })
  const [updateType]    = useMutation(UPDATE_CI_TYPE,    { onCompleted: () => { void refetch(); toast.success('Salvato') } })
  const [deleteType]    = useMutation(DELETE_CI_TYPE,    { onCompleted: () => { void refetch(); setSelectedId(null); toast.success('Tipo eliminato') } })
  const [addField]      = useMutation(ADD_CI_FIELD,      { onCompleted: () => { void refetch();     setAddingField(false); setEditingFieldId(null); toast.success('Campo aggiunto') } })
  const [addBaseField]  = useMutation(ADD_CI_FIELD,      { onCompleted: () => { void refetchBase(); setShowBaseFieldModal(false); toast.success('Campo base aggiunto') } })
  const [removeField]   = useMutation(REMOVE_CI_FIELD,   { onCompleted: () => { void refetch(); toast.success('Campo rimosso') } })
  const [addRelation]   = useMutation(ADD_CI_RELATION,   { onCompleted: () => { void refetch(); setShowRelModal(false); toast.success('Relazione aggiunta') } })
  const [removeRelation] = useMutation(REMOVE_CI_RELATION, { onCompleted: () => { void refetch(); toast.success('Relazione rimossa') } })

  const handleSaveField = async (form: FieldForm) => {
    const targetId = selectedBase ? baseType?.id : selected?.id
    if (!targetId) return
    const input = {
      name:             form.name,
      label:            form.label,
      fieldType:        form.fieldType,
      required:         form.required,
      defaultValue:     form.defaultValue || null,
      enumTypeId:       form.fieldType === 'enum' ? form.enumTypeId : null,
      order:            form.order,
      validationScript: form.validationScript || null,
      visibilityScript: form.visibilityScript || null,
      defaultScript:    form.defaultScript    || null,
    }
    if (selectedBase) {
      await addBaseField({ variables: { typeId: targetId, input } })
    } else {
      await addField({ variables: { typeId: targetId, input } })
    }
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Layers size={22} color="#38bdf8" />}>
          CI Type Designer
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 0 }}>
          Definisci e gestisci i tipi di Configuration Item e i loro campi
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'start' }}>

        {/* Left: type list */}
        <CITypeList
          ciTypes={ciTypes}
          selectedId={selectedId}
          selectedBase={selectedBase}
          loading={loading}
          onSelectType={selectType}
          onSelectBase={() => { setSelectedBase(true); setSelectedId(null) }}
          onNew={() => setShowCreate(true)}
        />

        {/* Right: type editor */}
        <div>
          {selectedBase && baseType ? (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                <Layout size={20} color="var(--color-brand)" />
                <div>
                  <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>Campi Base</div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>Ereditati da tutti i tipi CI</div>
                </div>
              </div>
              <div style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em' }}>CAMPI DI SISTEMA</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', marginTop: 2 }}>{baseType.fields.length} campi — non eliminabili</div>
                  </div>
                  <button style={btnPrimary} onClick={() => { setEditingBaseField(null); setShowBaseFieldModal(true) }}>
                    <Plus size={13} /> Aggiungi campo base
                  </button>
                </div>
                {[...baseType.fields].sort((a, b) => a.order - b.order).map((f) => (
                  <DesignerFieldRow
                    key={f.id}
                    field={{ ...f, enumValues: (f as unknown as { enumValues?: string[] }).enumValues ?? [] }}
                    onEdit={() => { setEditingBaseField(f); setShowBaseFieldModal(true) }}
                    onDelete={() => {}}
                    editLabel="Modifica"
                    systemFieldLabel="Campo di sistema"
                  />
                ))}
              </div>
            </div>

          ) : !selected ? (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 40 }}>
              <EmptyState icon={<Layers size={32} color="#94a3b8" />} title="Seleziona un tipo per modificarlo" />
            </div>

          ) : (
            <>
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              {/* Type header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CIIcon icon={selected.icon} size={20} color={selected.color ?? 'var(--color-brand)'} />
                  <div>
                    <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{selected.label}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>{selected.name}</div>
                  </div>
                  <button
                    onClick={() => updateType({ variables: { id: selected.id, input: { active: !selected.active } } })}
                    style={{ marginLeft: 8, padding: '3px 10px', border: '1px solid #e5e7eb', borderRadius: 100, fontSize: 'var(--font-size-body)', cursor: 'pointer', background: selected.active ? '#dcfce7' : '#f3f4f6', color: selected.active ? '#16a34a' : '#94a3b8', fontWeight: 500 }}>
                    {selected.active ? '● active' : '○ inactive'}
                  </button>
                </div>
                <button style={btnDanger}
                  onClick={() => {
                    if (!confirm(`Eliminare il tipo "${selected.label}"? Questa azione è irreversibile.`)) return
                    void deleteType({ variables: { id: selected.id } })
                  }}>
                  <Trash2 size={12} /> Elimina tipo
                </button>
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 20px' }}>
                {(['settings', 'fields', 'relations', 'rules', 'preview'] as Tab[]).map((tab) => (
                  <button key={tab} onClick={() => { setActiveTab(tab); setEditingFieldId(null); setAddingField(false) }}
                    style={{ padding: '10px 14px', border: 'none', borderBottom: activeTab === tab ? '2px solid var(--color-brand)' : '2px solid transparent', marginBottom: -1, background: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer', color: activeTab === tab ? 'var(--color-brand)' : 'var(--color-slate)', fontWeight: activeTab === tab ? 600 : 400 }}>
                    {tab === 'settings' ? 'Impostazioni' : tab === 'fields' ? 'Campi' : tab === 'relations' ? 'Relazioni CI' : tab === 'rules' ? 'Regole' : 'Preview'}
                  </button>
                ))}
              </div>

              <div style={{ padding: '20px 24px' }}>

                {/* Tab: Impostazioni */}
                {activeTab === 'settings' && settingsForm && (
                  <div style={{ maxWidth: 480 }}>
                    <FormField label="Label">
                      <input style={inputS} value={settingsForm.label}
                        onChange={(e) => setSettingsForm((p) => p && ({ ...p, label: e.target.value }))} />
                    </FormField>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
                      <FormField label="Icona">
                        <select style={selectS} value={settingsForm.icon}
                          onChange={(e) => setSettingsForm((p) => p && ({ ...p, icon: e.target.value }))}>
                          {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
                        </select>
                      </FormField>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 20 }}>
                        <CIIcon icon={settingsForm.icon} size={24} color={settingsForm.color} />
                      </div>
                    </div>
                    <FormField label="Colore">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="color" value={settingsForm.color}
                          onChange={(e) => setSettingsForm((p) => p && ({ ...p, color: e.target.value }))}
                          style={{ width: 36, height: 36, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }} />
                        <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{settingsForm.color}</span>
                      </div>
                    </FormField>
                    {/* Chain Families */}
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', marginBottom: 6 }}>{t('ciTypeDesigner.chainFamilies')}</label>
                      <div style={{ display: 'flex', gap: 16 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                          <input type="checkbox"
                            checked={settingsForm.chainFamilies.includes('Application')}
                            onChange={e => {
                              const next = e.target.checked
                                ? [...settingsForm.chainFamilies, 'Application']
                                : settingsForm.chainFamilies.filter(f => f !== 'Application')
                              setSettingsForm({ ...settingsForm, chainFamilies: next })
                            }}
                          />
                          {t('ciTypeDesigner.chainApplication')}
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                          <input type="checkbox"
                            checked={settingsForm.chainFamilies.includes('Infrastructure')}
                            onChange={e => {
                              const next = e.target.checked
                                ? [...settingsForm.chainFamilies, 'Infrastructure']
                                : settingsForm.chainFamilies.filter(f => f !== 'Infrastructure')
                              setSettingsForm({ ...settingsForm, chainFamilies: next })
                            }}
                          />
                          {t('ciTypeDesigner.chainInfrastructure')}
                        </label>
                      </div>
                      <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 4 }}>{t('ciTypeDesigner.chainFamiliesTooltip')}</p>
                    </div>

                    <FormField label="Validation script (opzionale)">
                      <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', margin: '0 0 6px' }}>
                        Variabili: <code>input</code>. Usa <code>throw 'msg'</code> per errore globale.
                      </p>
                      <textarea style={{ ...textareaS, minHeight: 100 }} value={settingsForm.validationScript}
                        onChange={(e) => setSettingsForm((p) => p && ({ ...p, validationScript: e.target.value }))}
                        placeholder={"// Esempio: validazione cross-field\nif (input.env === 'production' && !input.owner) throw 'Ambiente production richiede un owner'"} />
                    </FormField>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button style={{ ...btnPrimary, opacity: settingsSaving ? 0.6 : 1 }} disabled={settingsSaving}
                        onClick={async () => {
                          setSettingsSaving(true)
                          try {
                            await updateType({ variables: { id: selected.id, input: {
                              label: settingsForm.label, icon: settingsForm.icon,
                              color: settingsForm.color, validationScript: settingsForm.validationScript || null,
                              chainFamilies: settingsForm.chainFamilies,
                            } } })
                          } finally { setSettingsSaving(false) }
                        }}>
                        {settingsSaving ? 'Salvataggio…' : 'Salva impostazioni'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Tab: Campi — inline editing (same pattern as ITIL) */}
                {activeTab === 'fields' && (() => {
                  const sortedFields   = [...selected.fields].sort((a, b) => a.order - b.order)
                  const systemFields   = sortedFields.filter((f) => f.isSystem)
                  const specificFields = sortedFields.filter((f) => !f.isSystem)
                  return (
                    <div>
                      {/* Base / inherited fields (read-only rows) */}
                      {systemFields.length > 0 && (
                        <div style={{ marginBottom: 20 }}>
                          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em', marginBottom: 8 }}>
                            CAMPI BASE ({systemFields.length}) — Ereditati da __base__ — non modificabili
                          </div>
                          {systemFields.map((f) => (
                            <DesignerFieldRow
                              key={f.id}
                              field={{ ...f, enumValues: (f as unknown as { enumValues?: string[] }).enumValues ?? [] }}
                              onEdit={() => {}}
                              onDelete={() => {}}
                              editLabel=""
                              systemFieldLabel="Campo base"
                            />
                          ))}
                        </div>
                      )}

                      {/* Specific fields — inline editing */}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: '#94a3b8', letterSpacing: '0.06em' }}>
                            CAMPI SPECIFICI ({specificFields.length})
                          </div>
                          <button style={btnPrimary} onClick={() => { setAddingField(true); setEditingFieldId(null) }} disabled={addingField}>
                            <Plus size={13} /> Aggiungi campo
                          </button>
                        </div>

                        {addingField && (
                          <CIFieldInlineEditor
                            initial={null}
                            existingCount={specificFields.length}
                            isSystem={false}
                            onSave={async (form) => { await handleSaveField(form) }}
                            onCancel={() => setAddingField(false)}
                            enumTypes={enumTypes}
                          />
                        )}

                        {specificFields.map((f) => (
                          editingFieldId === f.id ? (
                            <CIFieldInlineEditor
                              key={f.id}
                              initial={fieldToForm(f)}
                              existingCount={specificFields.length}
                              isSystem={false}
                              onSave={async (form) => { await handleSaveField(form) }}
                              onCancel={() => setEditingFieldId(null)}
                              enumTypes={enumTypes}
                            />
                          ) : (
                            <DesignerFieldRow
                              key={f.id}
                              field={{ ...f, enumValues: (f as unknown as { enumValues?: string[] }).enumValues ?? [] }}
                              onEdit={() => { setEditingFieldId(f.id); setAddingField(false) }}
                              onDelete={() => {
                                if (!confirm(`Eliminare il campo "${f.name}"?`)) return
                                void removeField({ variables: { typeId: selected.id, fieldId: f.id } })
                              }}
                              editLabel="Modifica"
                              systemFieldLabel="Campo di sistema"
                            />
                          )
                        ))}

                        {specificFields.length === 0 && !addingField && (
                          <div style={{ padding: '32px 16px', textAlign: 'center', color: '#94a3b8', fontSize: 'var(--font-size-body)', border: '1px dashed #e5e7eb', borderRadius: 8 }}>
                            Nessun campo specifico. Clicca "+ Aggiungi campo" per crearne uno.
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Tab: Relazioni */}
                {activeTab === 'relations' && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                      <button style={btnPrimary} onClick={() => setShowRelModal(true)}>
                        <Plus size={13} /> Aggiungi relazione
                      </button>
                    </div>
                    <CIRelationTable
                      relations={selected.relations}
                      onRemove={(r: CIRelationDef) => void removeRelation({ variables: { typeId: selected.id, relationId: r.id } })}
                    />
                  </div>
                )}

                {/* Tab: Regole */}
                {activeTab === 'rules' && (
                  <FieldRulesPanel
                    flat
                    entityType={selected.name}
                    fields={selected.fields.map((f) => ({
                      name:       f.name,
                      label:      f.label,
                      fieldType:  f.fieldType,
                      enumValues: f.enumValues,
                    }))}
                    workflowSteps={[]}
                  />
                )}

                {/* Tab: Preview */}
                {activeTab === 'preview' && (
                  <div style={{ maxWidth: 520 }}>
                    <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', marginBottom: 16 }}>
                      Anteprima del form di creazione CI — campi specifici del tipo.
                    </p>
                    {selected.fields.length === 0
                      ? <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>Nessun campo specifico. Aggiungi campi nella tab "Campi".</p>
                      : <CIDynamicForm ciType={selected} onSubmit={async () => { toast.info('Preview — nessun dato salvato') }} onCancel={() => setActiveTab('fields')} />
                    }
                  </div>
                )}
              </div>
            </div>
            </>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <CreateTypeDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSave={async (form) => { await createType({ variables: { input: form } }) }}
      />

      {/* Modal only for base type fields */}
      <CIFieldEditor
        open={showBaseFieldModal}
        onClose={() => setShowBaseFieldModal(false)}
        initial={editingBaseField ? fieldToForm(editingBaseField) : null}
        existingCount={baseType?.fields.length ?? 0}
        onSave={handleSaveField}
      />

      <CIRelationEditor
        open={showRelModal}
        onClose={() => setShowRelModal(false)}
        allTypes={ciTypes}
        onSave={async (form: RelationForm) => {
          if (!selected) return
          await addRelation({
            variables: {
              typeId: selected.id,
              input: { name: form.name, label: form.label, relationshipType: form.relationshipType, targetType: form.targetType, cardinality: form.cardinality, direction: form.direction, order: form.order },
            },
          })
        }}
      />
    </PageContainer>
  )
}
