import { createPortal } from 'react-dom'
import {
  Plus, Pencil, Trash2, ToggleLeft, ToggleRight, BookOpen,
} from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder } from '@/components/FilterBuilder'
import { useEntriesTab } from '@/pages/admin/useChangeCatalogAdmin'
import type { CatalogEntry } from '@/pages/admin/useChangeCatalogAdmin'
import { EntryForm } from '@/pages/admin/EntryForm'
import { btnPrimary, btnSecondary, badgeS } from '@/pages/admin/catalogAdminStyles'

export function EntryTab() {
  const hook = useEntriesTab()
  const {
    formView, deleteId, setDeleteId,
    sortField, sortDir, setFilterGroup,
    handleSort, entries, loading, filterFields,
    openCreate, openEdit, handleDelete, handleToggle,
    t,
  } = hook

  const columns: ColumnDef<CatalogEntry>[] = [
    { key: 'name', label: t('pages.changeCatalogAdmin.colName'), sortable: true, render: (v) => <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{String(v)}</span> },
    { key: 'categoryId', label: t('pages.changeCatalogAdmin.colCategory'), width: '140px', render: (_v, row) => {
      if (!row.category) return <span style={{ color: 'var(--color-slate-light)' }}>—</span>
      return <span style={badgeS(row.category.color || '#e0f2fe', row.category.color ? '#fff' : '#0284c7')}>{row.category.name}</span>
    }},
    { key: 'workflowId', label: t('pages.changeCatalogAdmin.colWorkflow'), width: '140px', render: (_v, row) => (
      <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{row.workflow?.name ?? t('pages.changeCatalogAdmin.default')}</span>
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
    return <EntryForm hook={hook} />
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
            <h3 style={{ margin: '0 0 8px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalogAdmin.confirmDelete')}</h3>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 20px' }}>
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
