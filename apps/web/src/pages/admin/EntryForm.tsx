import {
  Plus, X, ArrowLeft, ToggleLeft, ToggleRight,
} from 'lucide-react'
import { ICON_OPTIONS } from '@/pages/admin/useChangeCatalogAdmin'
import type { useEntriesTab } from '@/pages/admin/useChangeCatalogAdmin'
import { inputS, selectS, labelS, btnPrimary, btnSecondary } from '@/pages/admin/catalogAdminStyles'

interface EntryFormProps {
  hook: ReturnType<typeof useEntriesTab>
}

export function EntryForm({ hook }: EntryFormProps) {
  const {
    setFormView, editingId,
    form, setForm,
    categories, ciTypes, changeWorkflows, titleInputRef,
    handleSave,
    addChecklistItem, removeChecklistItem, updateChecklistItem,
    t,
  } = hook

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

        {/* -- Section: Informazioni Base -- */}
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

        {/* -- Section: Template Change -- */}
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

        {/* -- Section: CI Impattati -- */}
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

        {/* -- Section: Checklist Deploy -- */}
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

        {/* -- Section: Informazioni Operative -- */}
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

        {/* -- Section: Notifiche -- */}
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
