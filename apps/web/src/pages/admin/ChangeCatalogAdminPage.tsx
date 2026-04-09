import { useState, useMemo, useRef } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import {
  BookOpen, Plus, Pencil, Trash2, X, ToggleLeft, ToggleRight,
  Shield, Server, Key, Code, Wifi, Database, Globe, Settings,
  HardDrive, Monitor, Lock, RefreshCw, Upload, Download, Zap,
  ArrowLeft,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FilterGroup, type FieldConfig } from '@/components/FilterBuilder'
import {
  GET_CHANGE_CATALOG_CATEGORIES,
  GET_STANDARD_CHANGE_CATALOG,
  GET_WORKFLOW_LIST,
} from '@/graphql/queries'
import { GET_CI_TYPES } from '@/graphql/queries'
import {
  CREATE_CHANGE_CATALOG_CATEGORY,
  UPDATE_CHANGE_CATALOG_CATEGORY,
  DELETE_CHANGE_CATALOG_CATEGORY,
  CREATE_STANDARD_CHANGE_CATALOG_ENTRY,
  UPDATE_STANDARD_CHANGE_CATALOG_ENTRY,
  DELETE_STANDARD_CHANGE_CATALOG_ENTRY,
} from '@/graphql/mutations'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogCategory {
  id: string; name: string; description: string | null; icon: string | null
  color: string | null; order: number; enabled: boolean; entryCount: number
}

interface CatalogEntry {
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

interface WorkflowDef {
  id: string; name: string; entityType: string; category: string | null; active: boolean; changeSubtype: string | null
}

interface CIType { name: string; label: string }

interface ChecklistItem { order: number; title: string; description: string }

type CategoryForm = { name: string; description: string; icon: string; color: string; enabled: boolean }
type EntryForm = {
  categoryId: string; name: string; description: string; riskLevel: string
  impact: string; defaultTitleTemplate: string; defaultDescriptionTemplate: string
  defaultPriority: string; ciTypes: string[]; checklist: ChecklistItem[]
  estimatedDurationHours: number; requiresDowntime: boolean
  rollbackProcedure: string; icon: string; color: string
  workflowId: string; ciRequired: boolean; maintenanceWindow: string
  notifyTeam: boolean; requireCompletionConfirm: boolean
}

const EMPTY_CATEGORY: CategoryForm = { name: '', description: '', icon: '', color: '#0284c7', enabled: true }
const EMPTY_ENTRY: EntryForm = {
  categoryId: '', name: '', description: '', riskLevel: 'low', impact: 'low',
  defaultTitleTemplate: '', defaultDescriptionTemplate: '', defaultPriority: 'medium',
  ciTypes: [], checklist: [], estimatedDurationHours: 0, requiresDowntime: false,
  rollbackProcedure: '', icon: '', color: '#0284c7',
  workflowId: '', ciRequired: false, maintenanceWindow: '',
  notifyTeam: true, requireCompletionConfirm: false,
}

// ── Icon map ──────────────────────────────────────────────────────────────────

const ICON_OPTIONS: { value: string; label: string; Icon: React.FC<{ size?: number }> }[] = [
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

// ── Styles ────────────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 13, color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}
const selectS: React.CSSProperties = {
  ...inputS, appearance: 'none' as const,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}
const labelS: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4 }
const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', border: 'none', borderRadius: 6, background: '#38bdf8',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms',
}
const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 13, cursor: 'pointer',
}
const badgeS = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: bg, color: fg,
})

const tabS = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px', fontSize: 13, fontWeight: active ? 600 : 400, cursor: 'pointer',
  borderBottom: active ? '2px solid var(--color-brand)' : '2px solid transparent',
  color: active ? 'var(--color-brand)' : 'var(--color-slate)',
  background: 'none', border: 'none', borderBottomStyle: 'solid', borderBottomWidth: 2,
  borderBottomColor: active ? 'var(--color-brand)' : 'transparent',
})

// ── Page ──────────────────────────────────────────────────────────────────────

export function ChangeCatalogAdminPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'categories' | 'entries'>('categories')

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <PageTitle icon={<BookOpen size={22} color="var(--color-brand)" />}>
          {t('pages.changeCatalogAdmin.title')}
        </PageTitle>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        <button style={tabS(tab === 'categories')} onClick={() => setTab('categories')}>
          {t('pages.changeCatalogAdmin.categories')}
        </button>
        <button style={tabS(tab === 'entries')} onClick={() => setTab('entries')}>
          {t('pages.changeCatalogAdmin.entries')}
        </button>
      </div>

      {tab === 'categories' ? <CategoriesTab /> : <EntriesTab />}
    </PageContainer>
  )
}

// ── Categories Tab ────────────────────────────────────────────────────────────

function CategoriesTab() {
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

  const columns: ColumnDef<CatalogCategory>[] = [
    { key: 'icon', label: t('pages.changeCatalogAdmin.icon'), width: '60px', render: (v, row) => {
      const found = ICON_OPTIONS.find(io => io.value === v)
      return found
        ? <found.Icon size={18} />
        : <div style={{ width: 24, height: 24, borderRadius: 6, background: row.color || '#e0f2fe' }} />
    }},
    { key: 'name', label: t('pages.changeCatalogAdmin.colName'), sortable: true, render: (v, row) => (
      <div>
        <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{String(v)}</div>
        {row.description && <div style={{ fontSize: 11, color: 'var(--color-slate-light)', marginTop: 2 }}>{row.description}</div>}
      </div>
    )},
    { key: 'entryCount', label: t('pages.changeCatalogAdmin.colEntries'), width: '80px', render: v => <span style={{ fontWeight: 500 }}>{String(v)}</span> },
    { key: 'enabled', label: t('pages.changeCatalogAdmin.colStatus'), width: '80px', render: (_v, row) => (
      <button onClick={e => { e.stopPropagation(); handleToggle(row) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
        {row.enabled ? <ToggleRight size={22} color="var(--color-brand)" /> : <ToggleLeft size={22} color="#cbd5e1" />}
      </button>
    )},
    { key: 'id', label: t('pages.changeCatalogAdmin.colActions'), width: '100px', render: (_v, row) => (
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <button onClick={e => { e.stopPropagation(); openEdit(row) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} title={t('pages.changeCatalogAdmin.editCategory')}><Pencil size={15} color="var(--color-slate)" /></button>
        <button onClick={e => { e.stopPropagation(); setDeleteId(row.id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} title={t('pages.changeCatalogAdmin.delete')}><Trash2 size={15} color="#ef4444" /></button>
      </div>
    )},
  ]

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button style={btnPrimary} onClick={openCreate}><Plus size={15} /> {t('pages.changeCatalogAdmin.newCategory')}</button>
      </div>

      {!loading && categories.length === 0 && (
        <EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.changeCatalogAdmin.noCategories')} />
      )}

      {categories.length > 0 && (
        <SortableFilterTable<CatalogCategory>
          columns={columns}
          data={categories}
          loading={loading}
        />
      )}

      {/* Create/Edit Modal */}
      {modalOpen && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
             onClick={e => { if (e.target === e.currentTarget) setModalOpen(false) }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.22)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f3f4f6' }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
                {editingId ? t('pages.changeCatalogAdmin.editCategory') : t('pages.changeCatalogAdmin.newCategory')}
              </h2>
              <button onClick={() => setModalOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex' }}>
                <X size={20} color="var(--color-slate)" />
              </button>
            </div>
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelS}>{t('pages.changeCatalogAdmin.name')} *</label>
                <input style={inputS} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={t('pages.changeCatalogAdmin.namePlaceholder')} />
              </div>
              <div>
                <label style={labelS}>{t('pages.changeCatalogAdmin.description')}</label>
                <textarea style={{ ...inputS, minHeight: 60, resize: 'vertical' }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelS}>{t('pages.changeCatalogAdmin.icon')}</label>
                  <select style={selectS} value={form.icon} onChange={e => setForm({ ...form, icon: e.target.value })}>
                    <option value="">{t('pages.changeCatalogAdmin.iconNone')}</option>
                    {ICON_OPTIONS.map(io => <option key={io.value} value={io.value}>{io.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelS}>{t('pages.changeCatalogAdmin.color')}</label>
                  <input style={{ ...inputS, padding: 2, height: 36 }} type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} />
                </div>
              </div>
              {editingId && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button onClick={() => setForm({ ...form, enabled: !form.enabled })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                    {form.enabled ? <ToggleRight size={26} color="var(--color-brand)" /> : <ToggleLeft size={26} color="#cbd5e1" />}
                  </button>
                  <span style={{ fontSize: 13, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalogAdmin.enabled')}</span>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 24px', borderTop: '1px solid #f3f4f6' }}>
              <button style={btnSecondary} onClick={() => setModalOpen(false)}>{t('pages.changeCatalogAdmin.cancel')}</button>
              <button style={btnPrimary} onClick={handleSave}>{editingId ? t('pages.changeCatalogAdmin.save') : t('pages.changeCatalogAdmin.create')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Delete Confirmation */}
      {deleteId && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
             onClick={e => { if (e.target === e.currentTarget) setDeleteId(null) }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 400, boxShadow: '0 24px 80px rgba(0,0,0,0.22)', padding: '24px' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalogAdmin.confirmDelete')}</h3>
            <p style={{ fontSize: 13, color: 'var(--color-slate)', margin: '0 0 20px' }}>
              {t('pages.changeCatalogAdmin.confirmDeleteCategory')}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={btnSecondary} onClick={() => setDeleteId(null)}>{t('pages.changeCatalogAdmin.cancel')}</button>
              <button style={{ ...btnPrimary, background: '#ef4444' }} onClick={handleDelete}>{t('pages.changeCatalogAdmin.delete')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

// ── Entries Tab ───────────────────────────────────────────────────────────────

function EntriesTab() {
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

  const columns: ColumnDef<CatalogEntry>[] = [
    { key: 'name', label: t('pages.changeCatalogAdmin.colName'), sortable: true, render: (v) => <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{String(v)}</span> },
    { key: 'categoryId', label: t('pages.changeCatalogAdmin.colCategory'), width: '140px', render: (_v, row) => {
      if (!row.category) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
      return <span style={badgeS(row.category.color || '#e0f2fe', row.category.color ? '#fff' : '#0284c7')}>{row.category.name}</span>
    }},
    { key: 'workflowId', label: t('pages.changeCatalogAdmin.colWorkflow'), width: '140px', render: (_v, row) => (
      <span style={{ fontSize: 12, color: 'var(--color-slate)' }}>{row.workflow?.name ?? t('pages.changeCatalogAdmin.default')}</span>
    )},
    { key: 'riskLevel', label: t('pages.changeCatalogAdmin.colRisk'), width: '100px', sortable: true, render: (v) => {
      const risk = String(v)
      const bgMap: Record<string, string> = { low: '#dcfce7', medium: '#fef3c7', high: '#fee2e2' }
      const fgMap: Record<string, string> = { low: '#15803d', medium: '#92400e', high: '#991b1b' }
      const lMap: Record<string, string> = { low: t('pages.changeCatalogAdmin.low'), medium: t('pages.changeCatalogAdmin.medium'), high: t('pages.changeCatalogAdmin.high') }
      return <span style={badgeS(bgMap[risk] || '#f3f4f6', fgMap[risk] || '#6b7280')}>{lMap[risk] || risk}</span>
    }},
    { key: 'estimatedDurationHours', label: t('pages.changeCatalogAdmin.colDuration'), width: '90px', render: (v) => v ? <span>{String(v)}h</span> : <span style={{ color: 'var(--color-slate-light)' }}>—</span> },
    { key: 'usageCount', label: t('pages.changeCatalogAdmin.colUsage'), width: '80px', sortable: true, render: (v) => <span>{String(v)}</span> },
    { key: 'enabled', label: t('pages.changeCatalogAdmin.colStatus'), width: '80px', render: (_v, row) => (
      <button onClick={e => { e.stopPropagation(); handleToggle(row) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
        {row.enabled ? <ToggleRight size={22} color="var(--color-brand)" /> : <ToggleLeft size={22} color="#cbd5e1" />}
      </button>
    )},
    { key: 'id', label: t('pages.changeCatalogAdmin.colActions'), width: '100px', render: (_v, row) => (
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <button onClick={e => { e.stopPropagation(); openEdit(row) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} title={t('pages.changeCatalogAdmin.editEntry')}><Pencil size={15} color="var(--color-slate)" /></button>
        <button onClick={e => { e.stopPropagation(); setDeleteId(row.id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} title={t('pages.changeCatalogAdmin.delete')}><Trash2 size={15} color="#ef4444" /></button>
      </div>
    )},
  ]

  // ── Full-page entry form ──
  if (formView === 'form') {
    return (
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '24px 28px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <button onClick={() => setFormView('list')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', borderRadius: 6 }}>
            <ArrowLeft size={20} color="var(--color-slate)" />
          </button>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
            {editingId ? t('pages.changeCatalogAdmin.editEntry') : t('pages.changeCatalogAdmin.newEntry')}
          </h2>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* ── Section: Informazioni Base ── */}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-slate-dark)', marginTop: 0, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f3f4f6', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('pages.changeCatalog.sectionBase')}
          </div>

          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.category')} *</label>
            <select style={selectS} value={form.categoryId} onChange={e => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">{t('pages.changeCatalogAdmin.selectCategory')}</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.name')} *</label>
            <input style={inputS} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={t('pages.changeCatalogAdmin.namePlaceholder')} />
          </div>
          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.description')} *</label>
            <textarea style={{ ...inputS, minHeight: 60, resize: 'vertical' }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.workflow')}</label>
            <select style={selectS} value={form.workflowId} onChange={e => setForm({ ...form, workflowId: e.target.value })}>
              <option value="">{t('pages.changeCatalog.defaultWorkflow')}</option>
              {changeWorkflows.map(w => (
                <option key={w.id} value={w.id}>{w.name}{w.category ? ` — ${w.category}` : ''}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelS}>{t('pages.changeCatalogAdmin.riskLevel')} *</label>
              <select style={selectS} value={form.riskLevel} onChange={e => setForm({ ...form, riskLevel: e.target.value })}>
                <option value="low">{t('pages.changeCatalogAdmin.low')}</option>
                <option value="medium">{t('pages.changeCatalogAdmin.medium')}</option>
                <option value="high">{t('pages.changeCatalogAdmin.high')}</option>
              </select>
            </div>
            <div>
              <label style={labelS}>{t('pages.changeCatalogAdmin.impact')} *</label>
              <select style={selectS} value={form.impact} onChange={e => setForm({ ...form, impact: e.target.value })}>
                <option value="low">{t('pages.changeCatalogAdmin.low')}</option>
                <option value="medium">{t('pages.changeCatalogAdmin.medium')}</option>
                <option value="high">{t('pages.changeCatalogAdmin.high')}</option>
              </select>
            </div>
          </div>

          {/* Icon + Color */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelS}>{t('pages.changeCatalogAdmin.icon')}</label>
              <select style={selectS} value={form.icon} onChange={e => setForm({ ...form, icon: e.target.value })}>
                <option value="">{t('pages.changeCatalogAdmin.iconNone')}</option>
                {ICON_OPTIONS.map(io => <option key={io.value} value={io.value}>{io.label}</option>)}
              </select>
            </div>
            <div>
              <label style={labelS}>{t('pages.changeCatalogAdmin.color')}</label>
              <input style={{ ...inputS, padding: 2, height: 36 }} type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} />
            </div>
          </div>

          {/* ── Section: Template Change ── */}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-slate-dark)', marginTop: 20, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f3f4f6', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('pages.changeCatalog.sectionTemplate')}
          </div>

          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.titleTemplate')} *</label>
            <input ref={titleInputRef} style={inputS} value={form.defaultTitleTemplate} onChange={e => setForm({ ...form, defaultTitleTemplate: e.target.value })} placeholder={t('pages.changeCatalogAdmin.titleTemplatePlaceholder')} />
            <div style={{ fontSize: 11, color: 'var(--color-slate-light)', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              <span>{t('pages.changeCatalog.templateVars')}:</span>
              {['{ci_name}', '{date}', '{category}', '{ci_type}', '{ci_environment}', '{operator_name}'].map(v => (
                <button
                  key={v}
                  type="button"
                  style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 4, padding: '1px 6px', fontSize: 11, cursor: 'pointer', color: '#475569', fontFamily: 'monospace' }}
                  onClick={() => {
                    const el = titleInputRef.current
                    if (el) {
                      const start = el.selectionStart ?? form.defaultTitleTemplate.length
                      const end = el.selectionEnd ?? start
                      const updated = form.defaultTitleTemplate.slice(0, start) + v + form.defaultTitleTemplate.slice(end)
                      setForm({ ...form, defaultTitleTemplate: updated })
                      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + v.length, start + v.length) })
                    } else {
                      setForm({ ...form, defaultTitleTemplate: form.defaultTitleTemplate + v })
                    }
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.descTemplate')} *</label>
            <textarea style={{ ...inputS, minHeight: 60, resize: 'vertical' }} value={form.defaultDescriptionTemplate} onChange={e => setForm({ ...form, defaultDescriptionTemplate: e.target.value })} />
          </div>
          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.defaultPriority')} *</label>
            <select style={selectS} value={form.defaultPriority} onChange={e => setForm({ ...form, defaultPriority: e.target.value })}>
              <option value="low">{t('pages.changeCatalogAdmin.low')}</option>
              <option value="medium">{t('pages.changeCatalogAdmin.medium')}</option>
              <option value="high">{t('pages.changeCatalogAdmin.high')}</option>
              <option value="critical">{t('pages.changeCatalogAdmin.critical')}</option>
            </select>
          </div>

          {/* ── Section: CI Impattati ── */}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-slate-dark)', marginTop: 20, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f3f4f6', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('pages.changeCatalog.sectionCI')}
          </div>

          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.ciTypes')} (multi-select)</label>
            <select
              style={{ ...selectS, minHeight: 60 }}
              multiple
              value={form.ciTypes}
              onChange={e => {
                const opts = Array.from(e.target.selectedOptions, o => o.value)
                setForm({ ...form, ciTypes: opts })
              }}
            >
              {ciTypes.map(ct => <option key={ct.name} value={ct.name}>{ct.label || ct.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setForm({ ...form, ciRequired: !form.ciRequired })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
              {form.ciRequired
                ? <ToggleRight size={26} color="var(--color-brand)" />
                : <ToggleLeft size={26} color="#cbd5e1" />}
            </button>
            <span style={{ fontSize: 13, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalog.ciRequired')}</span>
          </div>

          {/* ── Section: Checklist Deploy ── */}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-slate-dark)', marginTop: 20, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f3f4f6', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('pages.changeCatalog.sectionChecklist')}
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ ...labelS, margin: 0 }}>{t('pages.changeCatalogAdmin.checklistLabel')}</label>
              <button style={{ ...btnSecondary, padding: '4px 10px', fontSize: 12 }} onClick={addChecklistItem}>
                <Plus size={12} /> {t('pages.changeCatalogAdmin.addStep')}
              </button>
            </div>
            {form.checklist.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--color-slate-light)', width: 20, flexShrink: 0, textAlign: 'center' }}>{i + 1}</span>
                <input style={{ ...inputS, flex: 1 }} placeholder={t('pages.changeCatalogAdmin.stepTitle')} value={item.title} onChange={e => updateChecklistItem(i, 'title', e.target.value)} />
                <input style={{ ...inputS, flex: 1 }} placeholder={t('pages.changeCatalogAdmin.stepDesc')} value={item.description} onChange={e => updateChecklistItem(i, 'description', e.target.value)} />
                <button onClick={() => removeChecklistItem(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, flexShrink: 0 }}>
                  <X size={14} color="#ef4444" />
                </button>
              </div>
            ))}
          </div>

          {/* ── Section: Informazioni Operative ── */}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-slate-dark)', marginTop: 20, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f3f4f6', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('pages.changeCatalog.sectionOperational')}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelS}>{t('pages.changeCatalogAdmin.duration')}</label>
              <input style={inputS} type="number" min={0} step={0.5} value={form.estimatedDurationHours} onChange={e => setForm({ ...form, estimatedDurationHours: Number(e.target.value) })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'end', gap: 8, paddingBottom: 2 }}>
              <button onClick={() => setForm({ ...form, requiresDowntime: !form.requiresDowntime })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                {form.requiresDowntime
                  ? <ToggleRight size={26} color="var(--color-brand)" />
                  : <ToggleLeft size={26} color="#cbd5e1" />}
              </button>
              <span style={{ fontSize: 13, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalogAdmin.downtime')}</span>
            </div>
          </div>

          {form.requiresDowntime && (
            <div>
              <label style={labelS}>{t('pages.changeCatalog.maintenanceWindow')}</label>
              <input style={inputS} value={form.maintenanceWindow} onChange={e => setForm({ ...form, maintenanceWindow: e.target.value })} placeholder={t('pages.changeCatalogAdmin.maintenanceWindowPlaceholder')} />
            </div>
          )}

          <div>
            <label style={labelS}>{t('pages.changeCatalogAdmin.rollback')}</label>
            <textarea style={{ ...inputS, minHeight: 60, resize: 'vertical' }} value={form.rollbackProcedure} onChange={e => setForm({ ...form, rollbackProcedure: e.target.value })} />
          </div>

          {/* ── Section: Notifiche ── */}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-slate-dark)', marginTop: 20, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f3f4f6', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('pages.changeCatalog.sectionNotifications')}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setForm({ ...form, notifyTeam: !form.notifyTeam })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
              {form.notifyTeam
                ? <ToggleRight size={26} color="var(--color-brand)" />
                : <ToggleLeft size={26} color="#cbd5e1" />}
            </button>
            <span style={{ fontSize: 13, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalog.notifyTeam')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setForm({ ...form, requireCompletionConfirm: !form.requireCompletionConfirm })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
              {form.requireCompletionConfirm
                ? <ToggleRight size={26} color="var(--color-brand)" />
                : <ToggleLeft size={26} color="#cbd5e1" />}
            </button>
            <span style={{ fontSize: 13, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalog.requireConfirm')}</span>
          </div>

        </div>

        {/* Footer buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24, paddingTop: 16, borderTop: '1px solid #f3f4f6' }}>
          <button style={btnSecondary} onClick={() => setFormView('list')}>{t('pages.changeCatalogAdmin.cancel')}</button>
          <button style={btnPrimary} onClick={handleSave}>{editingId ? t('pages.changeCatalogAdmin.save') : t('pages.changeCatalogAdmin.create')}</button>
        </div>
      </div>
    )
  }

  // ── List view ──
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button style={btnPrimary} onClick={openCreate}><Plus size={15} /> {t('pages.changeCatalogAdmin.newEntry')}</button>
      </div>

      <FilterBuilder fields={filterFields} onApply={g => setFilterGroup(g)} />

      <SortableFilterTable<CatalogEntry>
        columns={columns}
        data={entries}
        loading={loading}
        emptyComponent={<EmptyState icon={<BookOpen size={32} color="var(--color-slate-light)" />} title={t('pages.changeCatalogAdmin.noEntries')} />}
        onSort={handleSort}
        sortField={sortField}
        sortDir={sortDir}
      />

      {/* Delete Confirmation */}
      {deleteId && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
             onClick={e => { if (e.target === e.currentTarget) setDeleteId(null) }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 400, boxShadow: '0 24px 80px rgba(0,0,0,0.22)', padding: '24px' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalogAdmin.confirmDelete')}</h3>
            <p style={{ fontSize: 13, color: 'var(--color-slate)', margin: '0 0 20px' }}>
              {t('pages.changeCatalogAdmin.confirmDeleteEntry')}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={btnSecondary} onClick={() => setDeleteId(null)}>{t('pages.changeCatalogAdmin.cancel')}</button>
              <button style={{ ...btnPrimary, background: '#ef4444' }} onClick={handleDelete}>{t('pages.changeCatalogAdmin.delete')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
