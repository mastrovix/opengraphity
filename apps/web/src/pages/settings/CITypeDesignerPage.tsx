import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { Layers, Layout, Plus, Trash2 } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { PageContainer } from '@/components/PageContainer'
import { toast } from 'sonner'
import { GET_CI_TYPES, GET_BASE_CI_TYPE, GET_ENUM_TYPES } from '@/graphql/queries'
import {
  CREATE_CI_TYPE, UPDATE_CI_TYPE, DELETE_CI_TYPE,
  ADD_CI_FIELD, UPDATE_CI_FIELD, REMOVE_CI_FIELD,
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
import { Input, Select } from '@/components/ui/FormControls'
import { Tabs } from '@/components/ui/Tabs'
import type { EnumTypeRef } from './shared/designerStyles'
import { DesignerFieldRow } from './shared/DesignerFieldRow'
import { CIFieldInlineEditor, FormField } from './citype/CIFieldInlineEditor'
import { CreateTypeDialog } from './citype/CreateTypeDialog'
import { FieldRulesPanel } from './shared/FieldRulesPanel'
import { useConfirm } from '@/hooks/useConfirm'
import { colors, palette } from '@/lib/tokens'
import { isShippedType } from '@/lib/ciTypeNames'
import { Package } from 'lucide-react'

/**
 * I ruoli che un tipo può dichiarare per la mappa di un servizio (ondata 6 ·
 * A-10). `entry` non è fra questi: nella mappa lo prende sempre il livello 1,
 * qualunque sia il tipo. Stesso vocabolario dell'API
 * (`SETTABLE_SERVICE_NODE_ROLES`), che rifiuta tutto il resto.
 */
const SERVICE_ROLES = ['component', 'infrastructure', 'certificate'] as const

// ── Style helpers ──────────────────────────────────────────────────────────────

const ICONS = ['box', 'database', 'server', 'shield', 'hard-drive', 'cloud', 'globe', 'cpu', 'network', 'monitor', 'lock']

interface EnumTypeOption extends EnumTypeRef { name: string }

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'settings' | 'fields' | 'relations' | 'rules' | 'preview'

export function CITypeDesignerPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
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
  const ids = { serviceRole: useId() }

  const [settingsForm, setSettingsForm] = useState<{ label: string; icon: string; color: string; validationScript: string; chainFamilies: string[]; serviceRole: string } | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)

  const selected = ciTypes.find((t) => t.id === selectedId) ?? null

  // A-6 — DI CHI è il tipo. Un tipo spedito col prodotto (`scope` diverso da
  // `tenant`) è UN nodo per tutti i clienti: `updateCIType`, `addCIRelation`,
  // `removeCIRelation`, `removeCIField` e `deleteCIType` hanno tutte
  // `WHERE t.scope = 'tenant'`, quindi su questi tipi eseguivano ZERO righe
  // senza lanciare — e il toast su `onCompleted` diceva «Salvato». Ora l'API
  // rifiuta a voce alta, e qui le azioni sono disattivate con il perché:
  // meglio non farle nemmeno provare.
  const shipped = selected ? isShippedType(selected) : false
  const shippedNote = selected
    ? `«${selected.label}» è spedito col prodotto: è un solo tipo per tutti i clienti, quindi etichetta, campi e relazioni ` +
      `sono in sola lettura. Per un tipo con le tue etichette e i tuoi campi, creane uno tuo.`
    : ''
  const readOnlyIf = (on: boolean) => (on ? { opacity: 0.5, cursor: 'not-allowed' as const } : {})

  const selectType = (t: CITypeDef) => {
    setSelectedBase(false)
    setSelectedId(t.id)
    setActiveTab('settings')
    setEditingFieldId(null)
    setAddingField(false)
    setSettingsForm({ label: t.label, icon: t.icon ?? 'box', color: t.color ?? 'var(--color-brand)', validationScript: t.validationScript ?? '', chainFamilies: t.chainFamilies ?? [], serviceRole: t.serviceRole ?? '' })
  }

  const [createType]    = useMutation(CREATE_CI_TYPE,    { onCompleted: () => { void refetch(); toast.success(t('toast.citype.typeCreated')) }, onError: (e) => toast.error(e.message) })
  const [updateType]    = useMutation(UPDATE_CI_TYPE,    { onCompleted: () => { void refetch(); toast.success(t('toast.citype.saved')) }, onError: (e) => toast.error(e.message) })
  const [deleteType]    = useMutation(DELETE_CI_TYPE,    { onCompleted: () => { void refetch(); setSelectedId(null); toast.success(t('toast.citype.typeDeleted')) }, onError: (e) => toast.error(e.message) })
  const [addField]      = useMutation(ADD_CI_FIELD,      { onCompleted: () => { void refetch();     setAddingField(false); setEditingFieldId(null); toast.success(t('toast.citype.fieldAdded')) }, onError: (e) => toast.error(e.message) })
  const [addBaseField]  = useMutation(ADD_CI_FIELD,      { onCompleted: () => { void refetchBase(); setShowBaseFieldModal(false); toast.success(t('toast.citype.baseFieldAdded')) }, onError: (e) => toast.error(e.message) })
  const [removeField]   = useMutation(REMOVE_CI_FIELD,   { onCompleted: () => { void refetch(); toast.success(t('toast.citype.fieldRemoved')) }, onError: (e) => toast.error(e.message) })
  // Revisione delle otto ondate · A·3.1: il pulsante «Modifica» chiamava
  // `addCIField`, che la porta sui nomi rifiutava sempre («Il campo esiste
  // già»). Ora esiste la mutation che serve.
  const [updateField]   = useMutation(UPDATE_CI_FIELD,   { onCompleted: () => { void refetch();     setEditingFieldId(null); toast.success(t('toast.citype.fieldSaved')) }, onError: (e) => toast.error(e.message) })
  const [updateBaseField] = useMutation(UPDATE_CI_FIELD, { onCompleted: () => { void refetchBase(); setEditingFieldId(null); toast.success(t('toast.citype.fieldSaved')) }, onError: (e) => toast.error(e.message) })
  const [addRelation]   = useMutation(ADD_CI_RELATION,   { onCompleted: () => { void refetch(); setShowRelModal(false); toast.success(t('toast.citype.relationAdded')) }, onError: (e) => toast.error(e.message) })
  const [removeRelation] = useMutation(REMOVE_CI_RELATION, { onCompleted: () => { void refetch(); toast.success(t('toast.citype.relationRemoved')) }, onError: (e) => toast.error(e.message) })

  /**
   * `fieldId` presente = si sta MODIFICANDO un campo esistente: nome e tipo
   * non si toccano (il nome è la proprietà sui nodi, il tipo descrive i valori
   * già scritti), quindi non vanno nemmeno nell'input.
   */
  const handleSaveField = async (form: FieldForm, fieldId?: string) => {
    const targetId = selectedBase ? baseType?.id : selected?.id
    if (!targetId) return
    if (fieldId) {
      const patch = {
        label:            form.label,
        required:         form.required,
        defaultValue:     form.defaultValue || null,
        enumTypeId:       form.fieldType === 'enum' ? form.enumTypeId : null,
        order:            form.order,
        validationScript: form.validationScript || null,
        visibilityScript: form.visibilityScript || null,
        defaultScript:    form.defaultScript    || null,
      }
      const run = selectedBase ? updateBaseField : updateField
      await run({ variables: { typeId: targetId, fieldId, input: patch } })
      return
    }
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
        <PageTitle icon={<Layers size={22} color="var(--color-icon-accent)" />}>
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
            <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                <Layout size={20} color="var(--color-brand)" />
                <div>
                  <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>Campi Base</div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>Ereditati da tutti i tipi CI</div>
                </div>
              </div>
              <div style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em' }}>CAMPI DI SISTEMA</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 2 }}>{baseType.fields.length} campi — non eliminabili</div>
                  </div>
                  <button type="button" style={btnPrimary} onClick={() => { setEditingBaseField(null); setShowBaseFieldModal(true) }}>
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
            <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, padding: 40 }}>
              <EmptyState icon={<Layers size={32} color={colors.slateLight} />} title="Seleziona un tipo per modificarlo" />
            </div>

          ) : (
            <>
            <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              {/* Type header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CIIcon icon={selected.icon} size={20} color={selected.color ?? 'var(--color-brand)'} />
                  <div>
                    <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{selected.label}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{selected.name}</div>
                  </div>
                  <button type="button"
                    disabled={shipped}
                    title={shipped ? shippedNote : undefined}
                    onClick={() => updateType({ variables: { id: selected.id, input: { active: !selected.active } } })}
                    style={{ marginLeft: 8, padding: '3px 10px', border: '1px solid var(--border)', borderRadius: 100, fontSize: 'var(--font-size-body)', cursor: shipped ? 'not-allowed' : 'pointer', background: selected.active ? palette.success.tint : 'var(--color-border-light)', color: selected.active ? 'var(--color-success)' : 'var(--color-slate-light)', fontWeight: 500, ...readOnlyIf(shipped) }}>
                    {selected.active ? '● active' : '○ inactive'}
                  </button>
                  {shipped && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-table)', background: 'var(--color-slate-bg)', color: 'var(--color-slate)', padding: '2px 8px', borderRadius: 20, fontWeight: 500 }}>
                      <Package size={10} aria-hidden="true" /> {t('ciTypeDesigner.shippedBadge')}
                    </span>
                  )}
                </div>
                <button type="button" style={{ ...btnDanger, ...readOnlyIf(shipped) }}
                  disabled={shipped}
                  title={shipped ? shippedNote : undefined}
                  onClick={async () => {
                    if (!(await confirm({ title: t('ciTypeDesigner.deleteTypeTitle', { label: selected.label }), danger: true }))) return
                    void deleteType({ variables: { id: selected.id } })
                  }}>
                  <Trash2 size={12} /> Elimina tipo
                </button>
              </div>

              {/* A-6: il perché, non solo i bottoni grigi. */}
              {shipped && (
                <p id="citype-shipped-note" style={{ margin: 0, padding: '10px 20px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', background: 'var(--color-slate-bg)', borderBottom: '1px solid var(--border)' }}>
                  {shippedNote}
                </p>
              )}

              {/* Tabs */}
              <div style={{ padding: '0 20px' }}>
                <Tabs<Tab>
                  ariaLabel={t('sidebar.ciTypeDesigner')}
                  items={[
                    { key: 'settings',  label: 'Impostazioni' },
                    { key: 'fields',    label: 'Campi' },
                    { key: 'relations', label: 'Relazioni CI' },
                    { key: 'rules',     label: 'Regole' },
                    { key: 'preview',   label: 'Preview' },
                  ]}
                  value={activeTab}
                  onChange={(tab) => { setActiveTab(tab); setEditingFieldId(null); setAddingField(false) }}
                />
              </div>

              <div style={{ padding: '20px 24px' }}>

                {/* Tab: Impostazioni */}
                {activeTab === 'settings' && settingsForm && (
                  <div style={{ maxWidth: 480 }}>
                    <FormField label="Label">
                      <Input style={inputS} value={settingsForm.label}
                        onChange={(e) => setSettingsForm((p) => p && ({ ...p, label: e.target.value }))} />
                    </FormField>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
                      <FormField label="Icona">
                        <Select style={selectS} value={settingsForm.icon}
                          onChange={(e) => setSettingsForm((p) => p && ({ ...p, icon: e.target.value }))}>
                          {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
                        </Select>
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

                    {/* A-10 — Ruolo nella mappa di un servizio. Prima era una
                        tabella per etichetta nel codice dell'API: un tipo
                        creato dal cliente non aveva ruolo, e quindi non poteva
                        entrare in nessuna mappa. */}
                    <FormField label={t('ciTypeDesigner.serviceRole')} htmlFor={ids.serviceRole}>
                      <Select id={ids.serviceRole} value={settingsForm.serviceRole} disabled={shipped}
                        title={shipped ? shippedNote : undefined}
                        onChange={(e) => setSettingsForm((p) => p && ({ ...p, serviceRole: e.target.value }))}>
                        <option value="">{t('ciTypeDesigner.serviceRoleAuto')}</option>
                        {SERVICE_ROLES.map((r) => (
                          <option key={r} value={r}>{t(`ciTypeDesigner.serviceRoles.${r}`)}</option>
                        ))}
                      </Select>
                      <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 4 }}>{t('ciTypeDesigner.serviceRoleHint')}</p>
                    </FormField>

                    <FormField label="Validation script (opzionale)">
                      <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
                        Variabili: <code>input</code>. Usa <code>throw 'msg'</code> per errore globale.
                      </p>
                      <textarea style={{ ...textareaS, minHeight: 100 }} value={settingsForm.validationScript}
                        onChange={(e) => setSettingsForm((p) => p && ({ ...p, validationScript: e.target.value }))}
                        placeholder={"// Esempio: validazione cross-field\nif (input.env === 'production' && !input.owner) throw 'Ambiente production richiede un owner'"} />
                    </FormField>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button type="button" style={{ ...btnPrimary, opacity: settingsSaving || shipped ? 0.6 : 1 }}
                        disabled={settingsSaving || shipped}
                        title={shipped ? shippedNote : undefined}
                        aria-describedby={shipped ? 'citype-shipped-note' : undefined}
                        onClick={async () => {
                          setSettingsSaving(true)
                          try {
                            await updateType({ variables: { id: selected.id, input: {
                              label: settingsForm.label, icon: settingsForm.icon,
                              color: settingsForm.color, validationScript: settingsForm.validationScript || null,
                              chainFamilies: settingsForm.chainFamilies,
                              // A-10: stringa vuota = «non dichiarato», cioè
                              // `null`: il ruolo torna a essere proposto dal
                              // prodotto invece di restare quello di prima.
                              serviceRole: settingsForm.serviceRole || null,
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
                          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em', marginBottom: 8 }}>
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
                          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em' }}>
                            CAMPI SPECIFICI ({specificFields.length})
                          </div>
                          <button type="button" style={{ ...btnPrimary, ...readOnlyIf(shipped) }}
                            onClick={() => { setAddingField(true); setEditingFieldId(null) }}
                            disabled={addingField || shipped}
                            title={shipped ? shippedNote : undefined}
                            aria-describedby={shipped ? 'citype-shipped-note' : undefined}>
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
                            // A-12: i nomi già presi su questo tipo (compresi
                            // quelli ereditati da __base__).
                            existingFieldNames={[...selected.fields.map((f) => f.name), ...(baseType?.fields ?? []).map((f) => f.name)]}
                            typeLabel={selected.label}
                          />
                        )}

                        {specificFields.map((f) => (
                          editingFieldId === f.id ? (
                            <CIFieldInlineEditor
                              key={f.id}
                              initial={fieldToForm(f)}
                              existingCount={specificFields.length}
                              isSystem={false}
                              onSave={async (form) => { await handleSaveField(form, f.id) }}
                              onCancel={() => setEditingFieldId(null)}
                              enumTypes={enumTypes}
                            />
                          ) : (
                            <DesignerFieldRow
                              key={f.id}
                              field={{ ...f, enumValues: (f as unknown as { enumValues?: string[] }).enumValues ?? [], isSystem: f.isSystem || shipped }}
                              onEdit={() => { setEditingFieldId(f.id); setAddingField(false) }}
                              onDelete={async () => {
                                if (!(await confirm({ title: t('ciTypeDesigner.deleteFieldTitle', { name: f.name }), danger: true }))) return
                                void removeField({ variables: { typeId: selected.id, fieldId: f.id } })
                              }}
                              editLabel={shipped ? '' : 'Modifica'}
                              systemFieldLabel={shipped ? t('ciTypeDesigner.shippedFieldLabel') : 'Campo di sistema'}
                            />
                          )
                        ))}

                        {specificFields.length === 0 && !addingField && (
                          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', border: '1px dashed var(--border)', borderRadius: 8 }}>
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
                      <button type="button" style={{ ...btnPrimary, ...readOnlyIf(shipped) }}
                        onClick={() => setShowRelModal(true)}
                        disabled={shipped}
                        title={shipped ? shippedNote : undefined}
                        aria-describedby={shipped ? 'citype-shipped-note' : undefined}>
                        <Plus size={13} /> Aggiungi relazione
                      </button>
                    </div>
                    <CIRelationTable
                      relations={selected.relations}
                      readOnly={shipped}
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
                    <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 16 }}>
                      Anteprima del form di creazione CI — campi specifici del tipo.
                    </p>
                    {selected.fields.length === 0
                      ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>Nessun campo specifico. Aggiungi campi nella tab "Campi".</p>
                      : <CIDynamicForm ciType={selected} onSubmit={async () => { toast.info(t('toast.citype.previewNoSave')) }} onCancel={() => setActiveTab('fields')} />
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
        // A-12: i nomi già presi, dal metamodello vivo.
        existingTypes={ciTypes}
        onSave={async (form) => {
          const res = await createType({ variables: { input: form } })
          // Con onError la promise si risolve anche in caso di fallimento:
          // senza dati la creazione è fallita e il dialog non deve chiudersi.
          if (!res.data) throw new Error('Creazione tipo fallita')
        }}
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
