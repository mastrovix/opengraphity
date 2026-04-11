import { createPortal } from 'react-dom'
import {
  Plus, Pencil, Trash2, X, ToggleLeft, ToggleRight,
} from 'lucide-react'
import { BookOpen } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { useCategoriesTab, ICON_OPTIONS } from '@/pages/admin/useChangeCatalogAdmin'
import type { CatalogCategory } from '@/pages/admin/useChangeCatalogAdmin'
import { inputS, selectS, labelS, btnPrimary, btnSecondary } from '@/pages/admin/catalogAdminStyles'

export function CategoryTab() {
  const {
    categories, loading, modalOpen, setModalOpen, editingId,
    deleteId, setDeleteId, form, setForm,
    openCreate, openEdit, handleSave, handleDelete, handleToggle,
    t,
  } = useCategoriesTab()

  const columns: ColumnDef<CatalogCategory>[] = [
    { key: 'icon', label: t('pages.changeCatalogAdmin.icon'), width: '60px', render: (v) => {
      const found = ICON_OPTIONS.find(io => io.value === v)
      return found
        ? <found.Icon size={18} />
        : <div style={{ width: 24, height: 24, borderRadius: 6, background: '#e0f2fe' }} />
    }},
    { key: 'name', label: t('pages.changeCatalogAdmin.colName'), sortable: true, render: (v, row) => (
      <div>
        <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{String(v)}</div>
        {row.description && <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginTop: 2 }}>{row.description}</div>}
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
              <h2 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
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
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalogAdmin.enabled')}</span>
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
            <h3 style={{ margin: '0 0 8px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>{t('pages.changeCatalogAdmin.confirmDelete')}</h3>
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '0 0 20px' }}>
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
