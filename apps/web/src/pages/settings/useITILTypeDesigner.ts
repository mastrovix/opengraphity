import { useState } from 'react'
import { useQuery, useMutation, useApolloClient } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfirm } from '@/hooks/useConfirm'
import { GET_ITIL_TYPES, GET_ENUM_TYPES, GET_CI_TYPES, GET_WORKFLOW_LIST, GET_ITIL_FIELD_VALUE_COUNT } from '@/graphql/queries'
import {
  CREATE_ITIL_FIELD, UPDATE_ITIL_FIELD, DELETE_ITIL_FIELD, UPDATE_ITIL_TYPE,
} from '@/graphql/mutations'
import type { EnumTypeRef } from './shared/designerStyles'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { showError, errorMessage } from '@/lib/showError'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ITILField {
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
  /** Il portale offre il campo all'utente finale (ondata 4). */
  visibleToEndUser?: boolean
}

export interface ITILType {
  id:               string
  name:             string
  label:            string
  icon:             string
  color:            string
  active:           boolean
  validationScript: string | null
  fields:           ITILField[]
}

export interface EnumTypeOption extends EnumTypeRef { name: string }

/** `ciExclusions`: i tipi di CI esclusi per questo tipo di ticket (revisione del 15 set 2026 · CM-8). */
export type Tab = 'settings' | 'fields' | 'ciExclusions' | 'rules' | 'preview'

export interface FieldFormState {
  name:             string
  label:            string
  fieldType:        string
  required:         boolean
  order:            number
  enumTypeId:       string | null
  validationScript: string
  visibilityScript: string
  defaultScript:    string
  visibleToEndUser: boolean
}

export function emptyForm(order: number): FieldFormState {
  return { name: '', label: '', fieldType: 'string', required: false, order, enumTypeId: null, validationScript: '', visibilityScript: '', defaultScript: '', visibleToEndUser: false }
}

export function fieldToForm(f: ITILField): FieldFormState {
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
    visibleToEndUser: f.visibleToEndUser === true,
  }
}

export interface SettingsFormState {
  label:            string
  icon:             string
  color:            string
  validationScript: string
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useITILTypeDesigner() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const apollo = useApolloClient()

  // ── State ───────────────────────────────────────────────────────────────────
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [addingField, setAddingField]       = useState(false)
  const [activeTab, setActiveTab]           = useState<Tab>('settings')
  const [settingsForm, setSettingsForm]     = useState<SettingsFormState | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)

  // ── Queries ─────────────────────────────────────────────────────────────────
  const { data, loading, refetch } = useQuery<{ itilTypes: ITILType[] }>(GET_ITIL_TYPES, {
    fetchPolicy: METAMODEL_FETCH_POLICY,
  })

  const { data: wfData } = useQuery<{ workflowDefinitions: { entityType: string; category: string | null; steps: { name: string }[] }[] }>(GET_WORKFLOW_LIST, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const ITIL_WORKFLOW_STEPS: Record<string, string[]> = {}
  for (const wf of wfData?.workflowDefinitions ?? []) {
    if (!wf.category) ITIL_WORKFLOW_STEPS[wf.entityType] = wf.steps.map(s => s.name)
  }

  const { data: enumTypesData } = useQuery<{ enumTypes: EnumTypeOption[] }>(GET_ENUM_TYPES, {
    fetchPolicy: METAMODEL_FETCH_POLICY,
  })

  const { data: ciTypesData } = useQuery<{ ciTypes: { id: string; name: string; label: string }[] }>(GET_CI_TYPES, {
    fetchPolicy: METAMODEL_FETCH_POLICY,
  })

  // ── Mutations ───────────────────────────────────────────────────────────────
  const [updateType]  = useMutation(UPDATE_ITIL_TYPE, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); setSettingsSaving(false); void refetch() },
    onError:     (e) => { showError(e); setSettingsSaving(false) },
  })

  const [createField] = useMutation(CREATE_ITIL_FIELD, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); setAddingField(false); void refetch() },
    onError: (e) => showError(e),
  })

  const [updateField] = useMutation(UPDATE_ITIL_FIELD, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); setEditingFieldId(null); void refetch() },
    onError: (e) => showError(e),
  })

  const [deleteField] = useMutation(DELETE_ITIL_FIELD, {
    onCompleted: () => { toast.success(t('itilDesigner.saved')); void refetch() },
    onError: (e) => showError(e),
  })

  // ── Computed ────────────────────────────────────────────────────────────────
  const itilTypes    = data?.itilTypes ?? []
  const selectedType = itilTypes.find((t) => t.id === selectedTypeId) ?? (itilTypes[0] ?? null)

  if (!selectedTypeId && itilTypes.length > 0 && selectedType) {
    setSelectedTypeId(selectedType.id)
    setSettingsForm({
      label:            selectedType.label,
      icon:             selectedType.icon  ?? '',
      color:            selectedType.color ?? 'var(--color-trigger-manual)',
      validationScript: selectedType.validationScript ?? '',
    })
  }

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleSelectType = (itilType: ITILType) => {
    setSelectedTypeId(itilType.id)
    setActiveTab('settings')
    setEditingFieldId(null)
    setAddingField(false)
    setSettingsForm({
      label:            itilType.label,
      icon:             itilType.icon  ?? '',
      color:            itilType.color ?? 'var(--color-trigger-manual)',
      validationScript: itilType.validationScript ?? '',
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
      toast.error(t('toast.itil.enumRequired'))
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
        visibleToEndUser: form.visibleToEndUser,
      },
    }
    if (fieldId) {
      void updateField({ variables: { ...variables, fieldId } })
    } else {
      void createField({ variables })
    }
  }

  const handleDeleteField = async (typeId: string, fieldId: string) => {
    // Giro UI del 15 set · U-28: i valori se ne vanno con il campo, quindi la
    // conferma dice PRIMA su quanti ticket.
    let count: number
    try {
      const res = await apollo.query<{ itilFieldValueCount: number }>({ query: GET_ITIL_FIELD_VALUE_COUNT, variables: { typeId, fieldId }, fetchPolicy: 'network-only' })
      if (res.data == null) throw new Error('itilFieldValueCount returned no data')
      count = res.data.itilFieldValueCount
    } catch (e) {
      showError(e, t('itilDesigner.deleteFieldCountFailed', { error: errorMessage(e) }))
      return
    }
    const body = count > 0 ? t('itilDesigner.deleteFieldValues', { count }) : t('itilDesigner.deleteFieldNoValues')
    if (!(await confirm({ title: t('itilDesigner.deleteFieldTitle'), body, danger: true }))) return
    void deleteField({ variables: { typeId, fieldId } })
  }

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    setEditingFieldId(null)
    setAddingField(false)
  }


  return {
    // State
    selectedTypeId,
    editingFieldId,
    setEditingFieldId,
    addingField,
    setAddingField,
    activeTab,
    settingsForm,
    setSettingsForm,
    settingsSaving,

    // Data
    loading,
    itilTypes,
    selectedType,
    enumTypesData,
    ciTypesData,
    ITIL_WORKFLOW_STEPS,
    t,

    // Handlers
    handleSelectType,
    handleSaveSettings,
    handleSaveField,
    handleDeleteField,
    handleTabChange,
  }
}

export type UseITILTypeDesignerReturn = ReturnType<typeof useITILTypeDesigner>
