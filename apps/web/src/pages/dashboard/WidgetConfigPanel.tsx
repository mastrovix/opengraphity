import { Input } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { lazy, Suspense, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@/components/Modal'
import { useWidgetConfig, DATA_FREE_WIDGET_TYPES, DATA_FREE_HINT_KEY } from './useWidgetConfig'
import { WidgetTypeSelector } from './WidgetTypeSelector'
import { WidgetFilterConfig } from './WidgetFilterConfig'
const WidgetPreview = lazy(() => import('./WidgetPreview').then(m => ({ default: m.WidgetPreview })))
import type { CustomWidgetData } from './CustomWidgetCard'
import { palette } from '@/lib/tokens'

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


// ── Component ────────────────────────────────────────────────────────────────

export function WidgetConfigPanel({ dashboardId, widget, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const c = useWidgetConfig({ dashboardId, widget, onSaved })
  const id = useId()
  const titleId = id + '-title'
  // The app's `Modal` (26 Sep 2026: this dialog drew its own overlay, header and
  // footer); the body is two panes side by side, so it has no padding of its own.
  return (
    <Modal
      open
      onClose={onClose}
      title={c.isEdit ? t('pages.dashboard.editWidget') : t('pages.dashboard.newWidget')}
      width={900}
      zIndex={9999}
      bodyStyle={{ padding: 0, display: 'flex' }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => c.handleSave()} disabled={c.saving || !c.title.trim()}>
            {c.saving ? t('pages.dashboard.saving') : c.isEdit ? t('pages.dashboard.updateWidget') : t('pages.dashboard.createWidget')}
          </Button>
        </>
      }
    >
        <div style={{ display: 'flex', flex: 1, gap: 0, minHeight: 0 }}>

          {/* Form column */}
          <div style={{ flex: '0 0 420px', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', borderRight: '1px solid var(--color-border-light)' }}>
            {/* Title */}
            <div>
              <label htmlFor={titleId} style={labelStyle}>{t('common.title')} *</label>
              <Input
                id={titleId}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo aperto dall'utente (campo principale)
                autoFocus
                value={c.title}
                onChange={(e) => c.setTitle(e.target.value)}
                placeholder={t('pages.dashboard.titlePlaceholder')}
              />
            </div>

            <WidgetTypeSelector widgetType={c.widgetType} color={c.color} onSelect={c.setWidgetType} />

            {DATA_FREE_HINT_KEY[c.widgetType] && (
              <p style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--color-brand-light)', color: palette.info.text, fontSize: 'var(--font-size-body)', lineHeight: 1.5 }}>
                {t(DATA_FREE_HINT_KEY[c.widgetType]!)}
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
              entities={c.entities} groupByFields={c.groupByFields} filterFields={c.filterFields} needsGroupBy={c.needsGroupBy}
              fieldMetaMap={c.fieldMetaMap} selectedFilterMeta={c.selectedFilterMeta}
            />
          </div>

          {/* Preview column */}
          <Suspense fallback={<div style={{ flex: 1 }} />}>
            <WidgetPreview
              widgetType={c.widgetType} color={c.color} title={c.title}
              previewData={c.previewData} previewLoading={c.previewLoading}
              timeRange={c.timeRange}
              entityType={c.entityType} groupByField={c.groupByField}
            />
          </Suspense>
        </div>

    </Modal>
  )
}
