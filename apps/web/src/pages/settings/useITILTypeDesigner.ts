import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { GET_ITIL_TYPES, GET_ENUM_TYPES, GET_CI_TYPES, GET_ITIL_CI_RELATION_RULES, GET_WORKFLOW_LIST } from '@/graphql/queries'
import {
  CREATE_ITIL_FIELD, UPDATE_ITIL_FIELD, DELETE_ITIL_FIELD, UPDATE_ITIL_TYPE,
  CREATE_ITIL_CI_RELATION_RULE, DELETE_ITIL_CI_RELATION_RULE,
} from '@/graphql/mutations'
import type { EnumTypeRef } from './shared/designerStyles'

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

export interface ITILCIRelationRule {
  id:           string
  itilType:     string
  ciType:       string
  relationType: string
  direction:    string
  description:  string | null
}

export interface EnumTypeOption extends EnumTypeRef { name: string }

export type Tab = 'settings' | 'fields' | 'relations' | 'rules' | 'preview'

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
}

export function emptyForm(order: number): FieldFormState {
  return { name: '', label: '', fieldType: 'string', required: false, order, enumTypeId: null, validationScript: '', visibilityScript: '', defaultScript: '' }
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
  }
}

export interface SettingsFormState {
  label:            string
  icon:             string
  color:            string
  validationScript: string
}

export interface RelFormState {
  ciType:       string
  relationType: string
  direction:    string
  description:  string
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useITILTypeDesigner() {
  const { t } = useTranslation()

  // ── State ───────────────────────────────────────────────────────────────────
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [addingField, setAddingField]       = useState(false)
  const [activeTab, setActiveTab]           = useState<Tab>('settings')
  const [settingsForm, setSettingsForm]     = useState<SettingsFormState | null>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [showRelForm, setShowRelForm]       = useState(false)
  const [relForm, setRelForm]               = useState<RelFormState>({ ciType: '', relationType: '', direction: 'outgoing', description: '' })

  // ── Queries ─────────────────────────────────────────────────────────────────
  const { data, loading, refetch } = useQuery<{ itilTypes: ITILType[] }>(GET_ITIL_TYPES, {
    fetchPolicy: 'cache-and-network',
  })

  const { data: wfData } = useQuery<{ workflowDefinitions: { entityType: string; category: string | null; steps: { name: string }[] }[] }>(GET_WORKFLOW_LIST, { fetchPolicy: 'cache-first' })
  const ITIL_WORKFLOW_STEPS: Record<string, string[]> = {}
  for (const wf of wfData?.workflowDefinitions ?? []) {
    if (!wf.category) ITIL_WORKFLOW_STEPS[wf.entityType] = wf.steps.map(s => s.name)
  }

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

  // ── Mutations ───────────────────────────────────────────────────────────────
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

  // ── Computed ────────────────────────────────────────────────────────────────
  const itilTypes    = data?.itilTypes ?? []
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

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleSelectType = (itilType: ITILType) => {
    setSelectedTypeId(itilType.id)
    setActiveTab('settings')
    setEditingFieldId(null)
    setAddingField(false)
    setShowRelForm(false)
    setSettingsForm({
      label:            itilType.label,
      icon:             itilType.icon  ?? '',
      color:            itilType.color ?? '#0284c7',
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

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    setEditingFieldId(null)
    setAddingField(false)
  }

  const handleCreateRule = (variables: { itilType: string; ciType: string; relationType: string; direction: string; description: string | null }) => {
    void createRule({ variables })
  }

  const handleDeleteRule = (id: string) => {
    if (!confirm(t('itilDesigner.ciRelations.confirmDelete'))) return
    void deleteRule({ variables: { id } })
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
    showRelForm,
    setShowRelForm,
    relForm,
    setRelForm,

    // Data
    loading,
    itilTypes,
    selectedType,
    enumTypesData,
    ciTypesData,
    ciRulesData,
    ITIL_WORKFLOW_STEPS,
    t,

    // Handlers
    handleSelectType,
    handleSaveSettings,
    handleSaveField,
    handleDeleteField,
    handleTabChange,
    handleCreateRule,
    handleDeleteRule,
  }
}

export type UseITILTypeDesignerReturn = ReturnType<typeof useITILTypeDesigner>
