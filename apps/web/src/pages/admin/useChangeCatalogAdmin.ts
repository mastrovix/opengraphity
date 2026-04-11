import { useState, useMemo, useRef } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  GET_CHANGE_CATALOG_CATEGORIES,
  GET_STANDARD_CHANGE_CATALOG,
  GET_WORKFLOW_LIST,
  GET_CI_TYPES,
} from '@/graphql/queries'
import {
  CREATE_CHANGE_CATALOG_CATEGORY,
  UPDATE_CHANGE_CATALOG_CATEGORY,
  DELETE_CHANGE_CATALOG_CATEGORY,
  CREATE_STANDARD_CHANGE_CATALOG_ENTRY,
  UPDATE_STANDARD_CHANGE_CATALOG_ENTRY,
  DELETE_STANDARD_CHANGE_CATALOG_ENTRY,
} from '@/graphql/mutations'
import type { FilterGroup, FieldConfig } from '@/components/FilterBuilder'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CatalogCategory {
  id: string; name: string; description: string | null; icon: string | null
  color: string | null; order: number; enabled: boolean; entryCount: number
}

export interface CatalogEntry {
  id: string; name: string; description: string; categoryId: string
  riskLevel: string; impact: string; defaultTitleTemplate: string
  defaultDescriptionTemplate: string; defaultPriority: string
  ciTypes: string[] | null; checklist: string | null
  estimatedDurationHours: number | null; requiresDowntime: boolean
  rollbackProcedure: string | null; icon: string | null; color: string | null
  usageCount: number; enabled: boolean; createdBy: string | null
  createdAt: string; updatedAt: string | null
  workflowId: string | null; ciRequired: boolean; maintenanceWindow: string | null
  notifyTeam: boolean; requireCompletionConfirm: boolean
  category: { id: string; name: string; icon: string | null; color: string | null } | null
  workflow: { id: string; name: string; category: string | null } | null
}

export interface WorkflowDef {
  id: string; name: string; entityType: string; category: string | null; active: boolean; changeSubtype: string | null
}

export interface CIType { name: string; label: string }

export interface ChecklistItem { order: number; title: string; description: string }

export type CategoryForm = { name: string; description: string; icon: string; color: string; enabled: boolean }
export type EntryForm = {
  categoryId: string; name: string; description: string; riskLevel: string
  impact: string; defaultTitleTemplate: string; defaultDescriptionTemplate: string
  defaultPriority: string; ciTypes: string[]; checklist: ChecklistItem[]
  estimatedDurationHours: number; requiresDowntime: boolean
  rollbackProcedure: string; icon: string; color: string
  workflowId: string; ciRequired: boolean; maintenanceWindow: string
  notifyTeam: boolean; requireCompletionConfirm: boolean
}

export const EMPTY_CATEGORY: CategoryForm = { name: '', description: '', icon: '', color: '#0284c7', enabled: true }
export const EMPTY_ENTRY: EntryForm = {
  categoryId: '', name: '', description: '', riskLevel: 'low', impact: 'low',
  defaultTitleTemplate: '', defaultDescriptionTemplate: '', defaultPriority: 'medium',
  ciTypes: [], checklist: [], estimatedDurationHours: 0, requiresDowntime: false,
  rollbackProcedure: '', icon: '', color: '#0284c7',
  workflowId: '', ciRequired: false, maintenanceWindow: '',
  notifyTeam: true, requireCompletionConfirm: false,
}

// ── Icon map ──────────────────────────────────────────────────────────────────

import {
  Shield, Server, Key, Code, Wifi, Database, Globe, Settings,
  HardDrive, Monitor, Lock, RefreshCw, Upload, Download, Zap,
} from 'lucide-react'

export const ICON_OPTIONS: { value: string; label: string; Icon: React.FC<{ size?: number }> }[] = [
  { value: 'Shield', label: 'Shield', Icon: Shield },
  { value: 'Server', label: 'Server', Icon: Server },
  { value: 'Key', label: 'Key', Icon: Key },
  { value: 'Code', label: 'Code', Icon: Code },
  { value: 'Wifi', label: 'Wifi', Icon: Wifi },
  { value: 'Database', label: 'Database', Icon: Database },
  { value: 'Globe', label: 'Globe', Icon: Globe },
  { value: 'Settings', label: 'Settings', Icon: Settings },
  { value: 'HardDrive', label: 'HardDrive', Icon: HardDrive },
  { value: 'Monitor', label: 'Monitor', Icon: Monitor },
  { value: 'Lock', label: 'Lock', Icon: Lock },
  { value: 'RefreshCw', label: 'RefreshCw', Icon: RefreshCw },
  { value: 'Upload', label: 'Upload', Icon: Upload },
  { value: 'Download', label: 'Download', Icon: Download },
  { value: 'Zap', label: 'Zap', Icon: Zap },
]

// ── Hook: Categories ─────────────────────────────────────────────────────────

export function useCategoriesTab() {
  const { t } = useTranslation()
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [form, setForm] = useState<CategoryForm>(EMPTY_CATEGORY)

  const refetchOpts = { refetchQueries: [{ query: GET_CHANGE_CATALOG_CATEGORIES }] }
  const { data, loading } = useQuery<{ changeCatalogCategories: CatalogCategory[] }>(GET_CHANGE_CATALOG_CATEGORIES)
  const [createCat] = useMutation(CREATE_CHANGE_CATALOG_CATEGORY, refetchOpts)
  const [updateCat] = useMutation(UPDATE_CHANGE_CATALOG_CATEGORY, refetchOpts)
  const [deleteCat] = useMutation(DELETE_CHANGE_CATALOG_CATEGORY, refetchOpts)

  const categories = data?.changeCatalogCategories ?? []

  function openCreate() {
    setEditingId(null); setForm(EMPTY_CATEGORY); setModalOpen(true)
  }
  function openEdit(cat: CatalogCategory) {
    setEditingId(cat.id)
    setForm({ name: cat.name, description: cat.description ?? '', icon: cat.icon ?? '', color: cat.color ?? '#0284c7', enabled: cat.enabled })
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error(t('pages.changeCatalogAdmin.nameRequired')); return }
    try {
      if (editingId) {
        await updateCat({ variables: { id: editingId, name: form.name.trim(), description: form.description || null, icon: form.icon || null, color: form.color || null, enabled: form.enabled } })
        toast.success(t('pages.changeCatalogAdmin.categoryUpdated'))
      } else {
        await createCat({ variables: { name: form.name.trim(), description: form.description || null, icon: form.icon || null, color: form.color || null } })
        toast.success(t('pages.changeCatalogAdmin.categoryCreated'))
      }
      setModalOpen(false)
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  async function handleDelete() {
    if (!deleteId) return
    const cat = categories.find(c => c.id === deleteId)
    if (cat && cat.entryCount > 0) {
      toast.error(t('pages.changeCatalogAdmin.deleteBlocked'))
      setDeleteId(null)
      return
    }
    try {
      await deleteCat({ variables: { id: deleteId } })
      toast.success(t('pages.changeCatalogAdmin.categoryDeleted'))
    } catch (e: unknown) { toast.error((e as Error).message) }
    setDeleteId(null)
  }

  async function handleToggle(cat: CatalogCategory) {
    try {
      await updateCat({ variables: { id: cat.id, enabled: !cat.enabled } })
      toast.success(cat.enabled ? t('pages.changeCatalogAdmin.categoryDisabled') : t('pages.changeCatalogAdmin.categoryEnabled'))
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  return {
    categories, loading, modalOpen, setModalOpen, editingId,
    deleteId, setDeleteId, form, setForm,
    openCreate, openEdit, handleSave, handleDelete, handleToggle,
    t,
  }
}

// ── Hook: Entries ─────────────────────────────────────────────────────────────

export function useEntriesTab() {
  const { t } = useTranslation()
  const [formView, setFormView] = useState<'list' | 'form'>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [form, setForm] = useState<EntryForm>(EMPTY_ENTRY)
  const [sortField, setSortField] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filterGroup, setFilterGroup] = useState<FilterGroup | null>(null)
  const handleSort = (f: string, d: 'asc' | 'desc') => { setSortField(f); setSortDir(d) }

  const { data: catData } = useQuery<{ changeCatalogCategories: CatalogCategory[] }>(GET_CHANGE_CATALOG_CATEGORIES)
  const categories = catData?.changeCatalogCategories ?? []

  const { data: ciTypesData } = useQuery<{ ciTypes: CIType[] }>(GET_CI_TYPES)
  const ciTypes = ciTypesData?.ciTypes ?? []

  const { data: wfData } = useQuery<{ workflowDefinitions: WorkflowDef[] }>(GET_WORKFLOW_LIST)
  const changeWorkflows = useMemo(() =>
    (wfData?.workflowDefinitions ?? []).filter(w => w.entityType === 'change' && w.active && w.changeSubtype === 'standard'),
    [wfData],
  )

  const titleInputRef = useRef<HTMLInputElement>(null)

  const refetchOpts = { refetchQueries: [{ query: GET_STANDARD_CHANGE_CATALOG }] }
  const { data, loading } = useQuery<{ standardChangeCatalog: CatalogEntry[] }>(GET_STANDARD_CHANGE_CATALOG, {
    variables: { filters: filterGroup ? JSON.stringify(filterGroup) : null, sortField, sortDirection: sortDir },
    fetchPolicy: 'cache-and-network',
  })
  const [createEntry] = useMutation(CREATE_STANDARD_CHANGE_CATALOG_ENTRY, refetchOpts)
  const [updateEntry] = useMutation(UPDATE_STANDARD_CHANGE_CATALOG_ENTRY, refetchOpts)
  const [deleteEntry] = useMutation(DELETE_STANDARD_CHANGE_CATALOG_ENTRY, refetchOpts)

  const entries = data?.standardChangeCatalog ?? []

  const filterFields: FieldConfig[] = useMemo(() => [
    { key: 'categoryId', label: t('pages.changeCatalogAdmin.colCategory'), type: 'enum', options: categories.map(c => ({ value: c.id, label: c.name })) },
    { key: 'riskLevel', label: t('pages.changeCatalogAdmin.colRisk'), type: 'enum', options: [
      { value: 'low', label: t('pages.changeCatalogAdmin.low') }, { value: 'medium', label: t('pages.changeCatalogAdmin.medium') }, { value: 'high', label: t('pages.changeCatalogAdmin.high') },
    ]},
    { key: 'enabled', label: t('pages.changeCatalogAdmin.colStatus'), type: 'enum', options: [
      { value: 'true', label: t('pages.changeCatalogAdmin.categoryEnabled') }, { value: 'false', label: t('pages.changeCatalogAdmin.categoryDisabled') },
    ]},
  ], [categories, t])

  function openCreate() {
    setEditingId(null); setForm(EMPTY_ENTRY); setFormView('form')
  }
  function openEdit(entry: CatalogEntry) {
    setEditingId(entry.id)
    let checklist: ChecklistItem[] = []
    try { checklist = entry.checklist ? JSON.parse(entry.checklist) : [] } catch { /* empty */ }
    setForm({
      categoryId: entry.categoryId, name: entry.name, description: entry.description,
      riskLevel: entry.riskLevel, impact: entry.impact,
      defaultTitleTemplate: entry.defaultTitleTemplate,
      defaultDescriptionTemplate: entry.defaultDescriptionTemplate,
      defaultPriority: entry.defaultPriority,
      ciTypes: entry.ciTypes ?? [], checklist,
      estimatedDurationHours: entry.estimatedDurationHours ?? 0,
      requiresDowntime: entry.requiresDowntime,
      rollbackProcedure: entry.rollbackProcedure ?? '',
      icon: entry.icon ?? '', color: entry.color ?? '#0284c7',
      workflowId: entry.workflowId ?? '',
      ciRequired: entry.ciRequired ?? false,
      maintenanceWindow: entry.maintenanceWindow ?? '',
      notifyTeam: entry.notifyTeam ?? true,
      requireCompletionConfirm: entry.requireCompletionConfirm ?? false,
    })
    setFormView('form')
  }

  async function handleSave() {
    if (!form.name.trim() || !form.categoryId) { toast.error(t('pages.changeCatalogAdmin.nameAndCategoryRequired')); return }
    const vars = {
      categoryId: form.categoryId, name: form.name.trim(), description: form.description,
      riskLevel: form.riskLevel, impact: form.impact,
      defaultTitleTemplate: form.defaultTitleTemplate,
      defaultDescriptionTemplate: form.defaultDescriptionTemplate,
      defaultPriority: form.defaultPriority,
      ciTypes: form.ciTypes.length > 0 ? form.ciTypes : null,
      checklist: form.checklist.length > 0 ? JSON.stringify(form.checklist) : null,
      estimatedDurationHours: form.estimatedDurationHours || null,
      requiresDowntime: form.requiresDowntime,
      rollbackProcedure: form.rollbackProcedure || null,
      icon: form.icon || null, color: form.color || null,
      workflowId: form.workflowId || null,
      ciRequired: form.ciRequired,
      maintenanceWindow: form.maintenanceWindow || null,
      notifyTeam: form.notifyTeam,
      requireCompletionConfirm: form.requireCompletionConfirm,
    }
    try {
      if (editingId) {
        await updateEntry({ variables: { id: editingId, ...vars } })
        toast.success(t('pages.changeCatalogAdmin.entryUpdated'))
      } else {
        await createEntry({ variables: vars })
        toast.success(t('pages.changeCatalogAdmin.entryCreated'))
      }
      setFormView('list')
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await deleteEntry({ variables: { id: deleteId } })
      toast.success(t('pages.changeCatalogAdmin.entryDeleted'))
    } catch (e: unknown) { toast.error((e as Error).message) }
    setDeleteId(null)
  }

  async function handleToggle(entry: CatalogEntry) {
    try {
      await updateEntry({ variables: { id: entry.id, enabled: !entry.enabled } })
      toast.success(entry.enabled ? t('pages.changeCatalogAdmin.categoryDisabled') : t('pages.changeCatalogAdmin.categoryEnabled'))
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  function addChecklistItem() {
    setForm({
      ...form,
      checklist: [...form.checklist, { order: form.checklist.length + 1, title: '', description: '' }],
    })
  }

  function removeChecklistItem(idx: number) {
    const updated = form.checklist.filter((_, i) => i !== idx).map((item, i) => ({ ...item, order: i + 1 }))
    setForm({ ...form, checklist: updated })
  }

  function updateChecklistItem(idx: number, field: 'title' | 'description', value: string) {
    const updated = form.checklist.map((item, i) => i === idx ? { ...item, [field]: value } : item)
    setForm({ ...form, checklist: updated })
  }

  return {
    formView, setFormView, editingId, deleteId, setDeleteId,
    form, setForm, sortField, sortDir, filterGroup, setFilterGroup,
    handleSort, categories, ciTypes, changeWorkflows, titleInputRef,
    entries, loading, filterFields,
    openCreate, openEdit, handleSave, handleDelete, handleToggle,
    addChecklistItem, removeChecklistItem, updateChecklistItem,
    t,
  }
}
