import { lazy, Suspense, useId } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useWidgetConfig, DATA_FREE_WIDGET_TYPES } from './useWidgetConfig'
import { WidgetTypeSelector } from './WidgetTypeSelector'
import { WidgetFilterConfig } from './WidgetFilterConfig'
const WidgetPreview = lazy(() => import('./WidgetPreview').then(m => ({ default: m.WidgetPreview })))
import type { CustomWidgetData } from './CustomWidgetCard'
import { alpha, colors, palette } from '@/lib/tokens'

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
  border: '1.5px solid var(--color-border)', fontSize: 'var(--font-size-body)',
  boxSizing: 'border-box', color: 'var(--color-slate-dark)',
  outline: 'none',
}

// ── Component ────────────────────────────────────────────────────────────────

export function WidgetConfigPanel({ dashboardId, widget, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const c = useWidgetConfig({ dashboardId, widget, onClose, onSaved })
  const id = useId()
  const titleId = id + '-title'
  const headingId = id + '-heading'

  return createPortal(
    // Il click sull'overlay (fuori dal pannello) chiude il dialogo: scorciatoia
    // solo-mouse; da tastiera valgono Escape (gestito in useWidgetConfig) e il
    // bottone "Chiudi" nell'header. Stesso pattern di components/Modal.tsx.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- overlay: chiusura via mouse, Escape/bottone per la tastiera
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: alpha.scrim, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        style={{ background: colors.white, borderRadius: 14, width: '100%', maxWidth: 900, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 24px 80px var(--color-black-a20)', display: 'flex', flexDirection: 'column' }}
      >

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--color-border-light)', flexShrink: 0 }}>
          <h2 id={headingId} style={{ margin: 0, fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
            {c.isEdit ? t('pages.dashboard.editWidget') : t('pages.dashboard.newWidget')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', alignItems: 'center' }}>
            <X size={20} color="var(--color-slate-light)" />
          </button>
        </div>

        {/* Body: form + preview */}
        <div style={{ display: 'flex', flex: 1, gap: 0, minHeight: 0 }}>

          {/* Form column */}
          <div style={{ flex: '0 0 420px', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', borderRight: '1px solid var(--color-border-light)' }}>
            {/* Title */}
            <div>
              <label htmlFor={titleId} style={labelStyle}>{t('common.title')} *</label>
              <input
                id={titleId}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo aperto dall'utente (campo principale)
                autoFocus
                value={c.title}
                onChange={(e) => c.setTitle(e.target.value)}
                placeholder={t('pages.dashboard.titlePlaceholder')}
                style={inputStyle}
              />
            </div>

            <WidgetTypeSelector widgetType={c.widgetType} color={c.color} onSelect={c.setWidgetType} />

            {DATA_FREE_WIDGET_TYPES.includes(c.widgetType) && (
              <p style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--color-brand-light)', color: palette.info.text, fontSize: 'var(--font-size-body)', lineHeight: 1.5 }}>
                {t('pages.dashboard.activeAlarmsHint')}
              </p>
            )}
            <WidgetFilterConfig
              dataConfigurable={!DATA_FREE_WIDGET_TYPES.includes(c.widgetType)}
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
          <Suspense fallback={<div style={{ flex: 1 }} />}>
            <WidgetPreview
              widgetType={c.widgetType} color={c.color} title={c.title}
              previewData={c.previewData} previewLoading={c.previewLoading}
              timeRange={c.timeRange}
            />
          </Suspense>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 24px', borderTop: '1px solid var(--color-border-light)', flexShrink: 0, background: colors.white }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 18px', borderRadius: 7, border: '1px solid var(--color-border-strong)', background: colors.white, color: 'var(--color-slate)', fontSize: 'var(--font-size-card-title)', cursor: 'pointer' }}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void c.handleSave()}
            disabled={c.saving || !c.title.trim()}
            style={{
              padding: '8px 22px', borderRadius: 7, border: 'none', fontSize: 'var(--font-size-card-title)', fontWeight: 600,
              cursor: c.saving || !c.title.trim() ? 'not-allowed' : 'pointer',
              background: c.saving || !c.title.trim() ? palette.info.border : c.color,
              color: colors.white,
            }}
          >
            {c.saving ? t('pages.dashboard.saving') : c.isEdit ? t('pages.dashboard.updateWidget') : t('pages.dashboard.createWidget')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
