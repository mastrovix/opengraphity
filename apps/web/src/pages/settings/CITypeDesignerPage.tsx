import { Pill } from '@/components/ui/Pill'
import { Button } from '@/components/Button'
import { useId, useState } from 'react'
import { useCIBaseEnums } from '@/lib/ciEnums'
import { useCILabels } from '@/hooks/useCILabels'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery, useMutation, useApolloClient } from '@apollo/client/react'
import { Layers, Layout, Plus, Trash2 } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { PageContainer } from '@/components/PageContainer'
import { toast } from 'sonner'
import { useLingue } from '@/hooks/useLingue'
import { GET_CI_TYPES, GET_BASE_CI_TYPE, GET_ENUM_TYPES, GET_CI_TYPE_DELETION_IMPACT, GET_CI_FIELD_VALUE_COUNT } from '@/graphql/queries'
import {
  CREATE_CI_TYPE, UPDATE_CI_TYPE, DELETE_CI_TYPE,
  ADD_CI_FIELD, UPDATE_CI_FIELD, REMOVE_CI_FIELD,
  ADD_CI_RELATION, REMOVE_CI_RELATION,
} from '@/graphql/mutations'
import { EmptyState } from '@/components/EmptyState'
import { CIIcon } from '@/lib/ciIcon'
import { CI_ICON_KEYS } from '@/lib/ciIconPaths'
import { CIDynamicForm } from '@/components/CIDynamicForm'
import type { CITypeDef, CIFieldDef, CIRelationDef } from '@/contexts/MetamodelContext'
import { CITypeList } from './citype/CITypeList'
import { CITypeDeletionImpact, type CITypeDeletionImpactData } from './citype/CITypeDeletionImpact'
import { showError, errorMessage } from '@/lib/showError'
import { CIFieldEditor, fieldToForm } from './citype/CIFieldEditor'
import type { FieldForm } from './citype/CIFieldEditor'
import { CIRelationEditor, CIRelationTable } from './citype/CIRelationEditor'
import type { RelationForm } from './citype/CIRelationEditor'
import { Input, Select, Textarea } from '@/components/ui/FormControls'
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
import { ColorField } from '@/components/ui/ColorField'
import { DetailLayout } from '@/components/ui/DetailLayout'

/**
 * I ruoli che un tipo può dichiarare per la mappa di un servizio (ondata 6 ·
 * A-10). `entry` non è fra questi: nella mappa lo prende sempre il livello 1,
 * qualunque sia il tipo. Stesso vocabolario dell'API
 * (`SETTABLE_SERVICE_NODE_ROLES`), che rifiuta tutto il resto.
 */
const SERVICE_ROLES = ['component', 'infrastructure', 'certificate'] as const

interface EnumTypeOption extends EnumTypeRef { name: string }

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'settings' | 'fields' | 'relations' | 'rules' | 'preview'

/** The look of an action a shipped type does not allow. */
const readOnlyIf = (on: boolean) => (on ? { opacity: 0.5, cursor: 'not-allowed' as const } : {})

export function CITypeDesignerPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const apollo = useApolloClient()
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

  const [settingsForm, setSettingsForm] = useState<{ label: string; labels: Record<string, string>; icon: string; color: string; validationScript: string; chainFamilies: string[]; serviceRole: string; statusesExcluded: string[] } | null>(null)
  // The status vocabulary: the type says which of its values it does not offer (G35).
  const ciBaseEnums = useCIBaseEnums()
  const { statusLabel } = useCILabels()
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
  // Le lingue in cui il cliente scrive le sue etichette (hooks/useLingue).
  const lingue = useLingue()
  const shippedNote = selected ? t('citypeDesigner.shippedNote', { type: selected.label }) : ''

  const selectType = (t: CITypeDef) => {
    setSelectedBase(false)
    setSelectedId(t.id)
    setActiveTab('settings')
    setEditingFieldId(null)
    setAddingField(false)
    setSettingsForm({ label: t.label, labels: Object.fromEntries((t.labels ?? []).map((l) => [l.language, l.label])), icon: t.icon ?? 'box', color: t.color ?? 'var(--color-brand)', validationScript: t.validationScript ?? '', chainFamilies: t.chainFamilies ?? [], serviceRole: t.serviceRole ?? '', statusesExcluded: t.statusesExcluded ?? [] })
  }

  const [createType]    = useMutation(CREATE_CI_TYPE,    { onCompleted: () => { void refetch(); toast.success(t('toast.citype.typeCreated')) }, onError: (e) => showError(e) })
  const [updateType]    = useMutation(UPDATE_CI_TYPE,    { onCompleted: () => { void refetch(); toast.success(t('toast.citype.saved')) }, onError: (e) => showError(e) })
  const [deleteType]    = useMutation(DELETE_CI_TYPE,    { onCompleted: () => { void refetch(); setSelectedId(null); toast.success(t('toast.citype.typeDeleted')) }, onError: (e) => showError(e) })
  const [addField]      = useMutation(ADD_CI_FIELD,      { onCompleted: () => { void refetch();     setAddingField(false); setEditingFieldId(null); toast.success(t('toast.citype.fieldAdded')) }, onError: (e) => showError(e) })
  const [addBaseField]  = useMutation(ADD_CI_FIELD,      { onCompleted: () => { void refetchBase(); setShowBaseFieldModal(false); toast.success(t('toast.citype.baseFieldAdded')) }, onError: (e) => showError(e) })
  const [removeField]   = useMutation(REMOVE_CI_FIELD,   { onCompleted: () => { void refetch(); toast.success(t('toast.citype.fieldRemoved')) }, onError: (e) => showError(e) })
  // Revisione delle otto ondate · A·3.1: il pulsante «Modifica» chiamava
  // `addCIField`, che la porta sui nomi rifiutava sempre («Il campo esiste
  // già»). Ora esiste la mutation che serve.
  const [updateField]   = useMutation(UPDATE_CI_FIELD,   { onCompleted: () => { void refetch();     setEditingFieldId(null); toast.success(t('toast.citype.fieldSaved')) }, onError: (e) => showError(e) })
  const [updateBaseField] = useMutation(UPDATE_CI_FIELD, { onCompleted: () => { void refetchBase(); setEditingFieldId(null); toast.success(t('toast.citype.fieldSaved')) }, onError: (e) => showError(e) })
  const [addRelation]   = useMutation(ADD_CI_RELATION,   { onCompleted: () => { void refetch(); setShowRelModal(false); toast.success(t('toast.citype.relationAdded')) }, onError: (e) => showError(e) })
  const [removeRelation] = useMutation(REMOVE_CI_RELATION, { onCompleted: () => { void refetch(); toast.success(t('toast.citype.relationRemoved')) }, onError: (e) => showError(e) })

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
      // Refused: its onError has said why, and the editor stays open (only onCompleted closes it).
      try { await run({ variables: { typeId: targetId, fieldId, input: patch } }) } catch { /* said by onError */ }
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
    // A refused save rejects after its onError has said why (Apollo 4): the
    // editor stays open, since only onCompleted closes it.
    try {
      if (selectedBase) await addBaseField({ variables: { typeId: targetId, input } })
      else await addField({ variables: { typeId: targetId, input } })
    } catch { /* said by the mutation's onError */ }
  }

  return (
    <PageContainer>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Layers size={22} color="var(--color-icon-accent)" />}>
          {t('sidebar.ciTypeDesigner')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
          {t('citypeDesigner.subtitle')}
        </p>
      </div>

      <DetailLayout sideWidth={220} sideFirst gap={20}>

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
                  <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{t('citypeDesigner.baseFields')}</div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('citypeDesigner.baseFieldsHint')}</div>
                </div>
              </div>
              <div style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em' }}>{t('citypeDesigner.systemFields')}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 2 }}>{t('citypeDesigner.fieldsNotDeletable', { count: baseType.fields.length })}</div>
                  </div>
                  <Button variant="primary" onClick={() => { setEditingBaseField(null); setShowBaseFieldModal(true) }}>
                    <Plus size={13} /> {t('citypeDesigner.addBaseField')}
                  </Button>
                </div>
                {[...baseType.fields].sort((a, b) => a.order - b.order).map((f) => (
                  <DesignerFieldRow
                    key={f.id}
                    field={{ ...f, enumValues: (f as unknown as { enumValues?: string[] }).enumValues ?? [] }}
                    onEdit={() => { setEditingBaseField(f); setShowBaseFieldModal(true) }}
                    onDelete={() => {}}
                    editLabel={t('common.edit')}
                    systemFieldLabel={t('itilDesigner.systemField')}
                  />
                ))}
              </div>
            </div>

          ) : !selected ? (
            <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, padding: 40 }}>
              <EmptyState icon={<Layers size={32} color={colors.slateLight} />} title={t('citypeDesigner.selectAType')} />
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
                    {selected.active ? `● ${t('common.active')}` : `○ ${t('common.inactive')}`}
                  </button>
                  {shipped && (
                    <Pill bg="var(--color-slate-bg)" color="var(--color-slate)" radius={20} style={{ gap: 4, fontSize: 'var(--font-size-table)', fontWeight: 500 }}>
                      <Package size={10} aria-hidden="true" /> {t('ciTypeDesigner.shippedBadge')}
                    </Pill>
                  )}
                </div>
                <Button variant="danger" size="xs"
                  disabled={shipped}
                  title={shipped ? shippedNote : undefined}
                  onClick={async () => {
                    // Regola del 15 set 2026: blocca solo un ticket; il resto va via
                    // col tipo, quindi la conferma lo elenca prima.
                    let impact: CITypeDeletionImpactData
                    try {
                      const res = await apollo.query<{ ciTypeDeletionImpact: CITypeDeletionImpactData }>({ query: GET_CI_TYPE_DELETION_IMPACT, variables: { id: selected.id }, fetchPolicy: 'network-only' })
                      if (!res.data) throw new Error('ciTypeDeletionImpact returned no data')
                      impact = res.data.ciTypeDeletionImpact
                    } catch (e) {
                      showError(e, t('ciTypeDesigner.deleteImpact.unavailable', { error: errorMessage(e) }))
                      return
                    }
                    if (impact.ticketCIs > 0) {
                      toast.error(t('ciTypeDesigner.deleteImpact.blocked', { label: selected.label, cis: impact.ticketCIs, tickets: impact.tickets }))
                      return
                    }
                    // U-16: una mappa di servizio che segue una relazione del tipo lo blocca (SV-6): detto prima della conferma.
                    if (impact.blockingServiceMaps.length > 0) {
                      toast.error(t('ciTypeDesigner.deleteImpact.blockedByServiceMaps', { label: selected.label, count: impact.blockingServiceMaps.length, maps: impact.blockingServiceMaps.join(', ') }))
                      return
                    }
                    if (!(await confirm({ title: t('ciTypeDesigner.deleteTypeTitle', { label: selected.label }), body: <CITypeDeletionImpact impact={impact} t={t} />, danger: true }))) return
                    void deleteType({ variables: { id: selected.id } })
                  }}
                >
                  <Trash2 size={12} /> {t('citypeDesigner.deleteType')}
                </Button>
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
                    { key: 'settings',  label: t('citypeDesigner.tab.settings') },
                    { key: 'fields',    label: t('citypeDesigner.tab.fields') },
                    { key: 'relations', label: t('citypeDesigner.tab.relations') },
                    { key: 'rules',     label: t('citypeDesigner.tab.rules') },
                    { key: 'preview',   label: t('citypeDesigner.tab.preview') },
                  ]}
                  value={activeTab}
                  onChange={(tab) => { setActiveTab(tab); setEditingFieldId(null); setAddingField(false) }}
                />
              </div>

              <div style={{ padding: '20px 24px' }}>

                {/* Tab: Impostazioni */}
                {activeTab === 'settings' && settingsForm && (
                  <div style={{ maxWidth: 480 }}>
                    <FormField label={t('common.label')}>
                      <Input value={settingsForm.label}
                        onChange={(e) => setSettingsForm((p) => p && ({ ...p, label: e.target.value }))} />
                    </FormField>
                    {/*
                      * IL NOME DEL TIPO PER LINGUA (20 set 2026). Il tipo
                      * aveva una sola etichetta, e quelli spediti col
                      * prodotto ce l'hanno in inglese: il web rimediava con
                      * una tabella di traduzioni cablate, che ignorava i tipi
                      * del cliente. Ora la lingua è dato, e si scrive qui —
                      * come le etichette dei valori nel Dizionario. Vuoto =
                      * vale l'etichetta qui sopra.
                      */}
                    {lingue.map(({ codice, nome }) => (
                      <FormField key={codice} label={t('citypeDesigner.labelForLanguage', { language: nome })}>
                        <Input value={settingsForm.labels[codice] ?? ''}
                          placeholder={settingsForm.label}
                          disabled={shipped}
                          onChange={(e) => setSettingsForm((p) => p && ({ ...p, labels: { ...p.labels, [codice]: e.target.value } }))} />
                      </FormField>
                    ))}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 14 }}>
                      <FormField label={t('citypeDesigner.icon')}>
                        <Select value={settingsForm.icon}
                          onChange={(e) => setSettingsForm((p) => p && ({ ...p, icon: e.target.value }))}>
                          {CI_ICON_KEYS.map((i) => <option key={i} value={i}>{i}</option>)}
                        </Select>
                      </FormField>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 20 }}>
                        <CIIcon icon={settingsForm.icon} size={24} color={settingsForm.color} />
                      </div>
                    </div>
                    <FormField label={t('citypeDesigner.color')}>
                      <ColorField label={t('citypeDesigner.color')} value={settingsForm.color} onChange={(hex) => setSettingsForm((p) => p && ({ ...p, color: hex }))} />
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

                    {/* The statuses this type does not offer (tour of 24 Sep 2026, G35). */}
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', marginBottom: 6 }}>{t('ciTypeDesigner.statusesOffered')}</div>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        {ciBaseEnums.statuses.map((st) => (
                          <label key={st} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: shipped ? 'not-allowed' : 'pointer' }}>
                            <input type="checkbox" disabled={shipped}
                              checked={!settingsForm.statusesExcluded.includes(st)}
                              onChange={(e) => setSettingsForm((p) => p && ({ ...p, statusesExcluded: e.target.checked ? p.statusesExcluded.filter((x) => x !== st) : [...p.statusesExcluded, st] }))}
                            />
                            {statusLabel(st)}
                          </label>
                        ))}
                      </div>
                      <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 4 }}>{t('ciTypeDesigner.statusesOfferedHint')}</p>
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

                    <FormField label={t('citypeDesigner.validationScript')}>
                      <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: '0 0 6px' }}>
                        <Trans i18nKey="citypeDesigner.validationScriptHint" components={{ code: <code /> }} />
                      </p>
                      <Textarea
                        aria-label={t('citypeDesigner.validationScriptPlaceholder')}
                        value={settingsForm.validationScript}
                        onChange={(e) => setSettingsForm((p) => p && ({ ...p, validationScript: e.target.value }))}
                        placeholder={t('citypeDesigner.validationScriptPlaceholder')}
                        style={{ minHeight: 100 }}
                      />
                    </FormField>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button variant="primary"
                        disabled={settingsSaving || shipped}
                        title={shipped ? shippedNote : undefined}
                        aria-describedby={shipped ? 'citype-shipped-note' : undefined}
                        onClick={async () => {
                          setSettingsSaving(true)
                          try {
                            await updateType({ variables: { id: selected.id, input: {
                              label: settingsForm.label,
                              // Le etichette per lingua si sostituiscono in
                              // blocco: le vuote non si mandano.
                              labels: Object.entries(settingsForm.labels)
                                .filter(([, v]) => v.trim() !== '')
                                .map(([language, label]) => ({ language, label })),
                              icon: settingsForm.icon,
                              color: settingsForm.color, validationScript: settingsForm.validationScript || null,
                              chainFamilies: settingsForm.chainFamilies,
                              // A-10: stringa vuota = «non dichiarato», cioè
                              // `null`: il ruolo torna a essere proposto dal
                              // prodotto invece di restare quello di prima.
                              serviceRole: settingsForm.serviceRole || null,
                              statusesExcluded: settingsForm.statusesExcluded,
                            } } })
                          } catch { /* said by the mutation's onError */ } finally { setSettingsSaving(false) }
                        }}
                      >
                        {settingsSaving ? t('common.saving') : t('citypeDesigner.saveSettings')}
                      </Button>
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
                            {t('citypeDesigner.baseFieldsHeader', { count: systemFields.length })}
                          </div>
                          {systemFields.map((f) => (
                            <DesignerFieldRow
                              key={f.id}
                              field={{ ...f, enumValues: (f as unknown as { enumValues?: string[] }).enumValues ?? [] }}
                              onEdit={() => {}}
                              onDelete={() => {}}
                              editLabel=""
                              systemFieldLabel={t('citypeDesigner.baseFieldLabel')}
                            />
                          ))}
                        </div>
                      )}

                      {/* Specific fields — inline editing */}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 600, color: 'var(--color-slate-light)', letterSpacing: '0.06em' }}>
                            {t('citypeDesigner.specificFieldsHeader', { count: specificFields.length })}
                          </div>
                          <Button variant="primary"
                            onClick={() => { setAddingField(true); setEditingFieldId(null) }}
                            disabled={addingField || shipped}
                            title={shipped ? shippedNote : undefined}
                            aria-describedby={shipped ? 'citype-shipped-note' : undefined}
                          >
                            <Plus size={13} /> {t('citypeDesigner.addField')}
                          </Button>
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
                                // Secondo giro UI · V-15: i valori se ne vanno col campo (CM-4): la conferma dice su quanti CI.
                                let count: number
                                try {
                                  const res = await apollo.query<{ ciFieldValueCount: number }>({ query: GET_CI_FIELD_VALUE_COUNT, variables: { typeId: selected.id, fieldId: f.id }, fetchPolicy: 'network-only' })
                                  if (res.data == null) throw new Error('ciFieldValueCount returned no data')
                                  count = res.data.ciFieldValueCount
                                } catch (e) {
                                  showError(e, t('ciTypeDesigner.deleteFieldCountFailed', { error: errorMessage(e) }))
                                  return
                                }
                                const body = count > 0 ? t('ciTypeDesigner.deleteFieldValues', { count }) : t('ciTypeDesigner.deleteFieldNoValues')
                                if (!(await confirm({ title: t('ciTypeDesigner.deleteFieldTitle', { name: f.name }), body, danger: true }))) return
                                void removeField({ variables: { typeId: selected.id, fieldId: f.id } })
                              }}
                              editLabel={shipped ? '' : t('common.edit')}
                              systemFieldLabel={shipped ? t('ciTypeDesigner.shippedFieldLabel') : t('itilDesigner.systemField')}
                            />
                          )
                        ))}

                        {specificFields.length === 0 && !addingField && (
                          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', border: '1px dashed var(--border)', borderRadius: 8 }}>
                            {t('citypeDesigner.noSpecificFields')}
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
                      <Button variant="primary"
                        onClick={() => setShowRelModal(true)}
                        disabled={shipped}
                        title={shipped ? shippedNote : undefined}
                        aria-describedby={shipped ? 'citype-shipped-note' : undefined}
                      >
                        <Plus size={13} /> {t('citypeDesigner.addRelation')}
                      </Button>
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
                      enumTypeName: f.enumTypeName ?? null,
                    }))}
                    workflowSteps={[]}
                  />
                )}

                {/* Tab: Preview */}
                {activeTab === 'preview' && (
                  <div style={{ maxWidth: 520 }}>
                    <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 16 }}>
                      {t('citypeDesigner.previewNote')}
                    </p>
                    {selected.fields.length === 0
                      ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('citypeDesigner.previewNoFields')}</p>
                      : <CIDynamicForm ciType={selected} onSubmit={async () => { toast.info(t('toast.citype.previewNoSave')) }} onCancel={() => setActiveTab('fields')} />
                    }
                  </div>
                )}
              </div>
            </div>
            </>
          )}
        </div>
      </DetailLayout>

      {/* Dialogs */}
      <CreateTypeDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        // A-12: i nomi già presi, dal metamodello vivo.
        existingTypes={ciTypes}
        // A refused creation REJECTS (Apollo 4, after onError has said why): the
        // dialog catches it and stays open instead of pretending the type exists.
        onSave={async (form) => { await createType({ variables: { input: form } }) }}
      />

      {/* Modal only for base type fields */}
      {/* Revisione totale · G-4: «Modifica» di un campo base salvava sempre
          come «aggiungi» (l'id del campo non arrivava a handleSaveField) e il
          form partiva vuoto. */}
      <CIFieldEditor
        open={showBaseFieldModal}
        onClose={() => { setShowBaseFieldModal(false); setEditingBaseField(null) }}
        initial={editingBaseField ? fieldToForm(editingBaseField) : null}
        existingCount={baseType?.fields.length ?? 0}
        onSave={async (form) => { await handleSaveField(form, editingBaseField?.id) }}
      />

      <CIRelationEditor
        open={showRelModal}
        onClose={() => setShowRelModal(false)}
        allTypes={ciTypes}
        onSave={async (form: RelationForm) => {
          if (!selected) return
          try {
            await addRelation({
              variables: {
                typeId: selected.id,
                input: { name: form.name, label: form.label, relationshipType: form.relationshipType, targetType: form.targetType, cardinality: form.cardinality, direction: form.direction, order: form.order },
              },
            })
          } catch { /* said by the mutation's onError: the dialog stays open, only onCompleted closes it */ }
        }}
      />
    </PageContainer>
  )
}
