import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useWidgetConfig } from './useWidgetConfig'
import { WidgetTypeSelector } from './WidgetTypeSelector'
import { WidgetFilterConfig } from './WidgetFilterConfig'
import { WidgetPreview } from './WidgetPreview'
import type { CustomWidgetData } from './CustomWidgetCard'

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  dashboardId: string
  widget?:     CustomWidgetData | null
  onClose:     () => void
  onSaved:     (widget: CustomWidgetData) => void
}

// ── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-table)', fontWeight: 700,
  color: 'var(--color-slate)', marginBottom: 5,
  letterSpacing: 0.3, textTransform: 'uppercase',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7,
  border: '1.5px solid #e2e8f0', fontSize: 'var(--font-size-body)',
  boxSizing: 'border-box', color: 'var(--color-slate-dark)',
  outline: 'none',
}

// ── Component ────────────────────────────────────────────────────────────────

export function WidgetConfigPanel({ dashboardId, widget, onClose, onSaved }: Props) {
  const c = useWidgetConfig({ dashboardId, widget, onClose, onSaved })

  return createPortal(
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 900, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.22)', display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
            {c.isEdit ? 'Modifica widget' : 'Nuovo widget personalizzato'}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', alignItems: 'center' }}>
            <X size={20} color="var(--color-slate-light)" />
          </button>
        </div>

        {/* Body: form + preview */}
        <div style={{ display: 'flex', flex: 1, gap: 0, minHeight: 0 }}>

          {/* Form column */}
          <div style={{ flex: '0 0 420px', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', borderRight: '1px solid #f3f4f6' }}>
            {/* Title */}
            <div>
              <label style={labelStyle}>Titolo *</label>
              <input autoFocus value={c.title} onChange={(e) => c.setTitle(e.target.value)} placeholder="Es. Incident aperti oggi" style={inputStyle} />
            </div>

            <WidgetTypeSelector widgetType={c.widgetType} color={c.color} onSelect={c.setWidgetType} />

            <WidgetFilterConfig
              entityType={c.entityType} onEntityChange={c.handleEntityChange}
              metric={c.metric} onMetricChange={(v) => { c.setMetric(v); c.setGroupByField('') }}
              groupByField={c.groupByField} onGroupByChange={c.setGroupByField}
              filterField={c.filterField} onFilterFieldChange={(v) => { c.setFilterField(v); c.setFilterValue('') }}
              filterValue={c.filterValue} onFilterValueChange={c.setFilterValue}
              timeRange={c.timeRange} onTimeRangeChange={c.setTimeRange}
              size={c.size} onSizeChange={c.setSize}
              color={c.color} onColorChange={c.setColor}
              fields={c.fields} needsGroupBy={c.needsGroupBy}
              fieldMetaMap={c.fieldMetaMap} selectedFilterMeta={c.selectedFilterMeta}
            />
          </div>

          {/* Preview column */}
          <WidgetPreview
            widgetType={c.widgetType} color={c.color} title={c.title}
            previewData={c.previewData} previewLoading={c.previewLoading}
            timeRange={c.timeRange}
          />
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 24px', borderTop: '1px solid #f3f4f6', flexShrink: 0, background: '#fff' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', cursor: 'pointer' }}>
            Annulla
          </button>
          <button
            onClick={() => void c.handleSave()}
            disabled={c.saving || !c.title.trim()}
            style={{
              padding: '8px 22px', borderRadius: 7, border: 'none', fontSize: 'var(--font-size-card-title)', fontWeight: 600,
              cursor: c.saving || !c.title.trim() ? 'not-allowed' : 'pointer',
              background: c.saving || !c.title.trim() ? '#bfdbfe' : c.color,
              color: '#fff',
            }}
          >
            {c.saving ? 'Salvataggio\u2026' : c.isEdit ? 'Aggiorna widget' : 'Crea widget'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
