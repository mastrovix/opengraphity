import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { PreviewData } from './useWidgetConfig'
import { TIME_RANGES, DATA_FREE_WIDGET_TYPES } from './useWidgetConfig'
import { ActiveAlarmsWidget } from './ActiveAlarmsWidget'

// Stesso corpo della card reale (anteprima ≡ widget); lazy per non portare
// ECharts nel bundle del modal di configurazione finché non serve.
const WidgetBody = lazy(() => import('@/components/WidgetBody').then((m) => ({ default: m.WidgetBody })))

// ── Props ────────────────────────────────────────────────────────────────────

interface WidgetPreviewProps {
  widgetType:     string
  color:          string
  title:          string
  previewData:    PreviewData | null
  previewLoading: boolean
  timeRange:      string
}

// ── Component ────────────────────────────────────────────────────────────────

export function WidgetPreview({ widgetType, color, title, previewData, previewLoading, timeRange }: WidgetPreviewProps) {
  const { t, i18n } = useTranslation()
  const timeRangeKey = TIME_RANGES.find((r) => r.value === timeRange)?.labelKey
  const dataFree = DATA_FREE_WIDGET_TYPES.includes(widgetType)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px 24px', background: 'var(--color-slate-bg)', minWidth: 0 }}>
      <div style={{ fontSize: 'var(--font-size-table)', fontWeight: 700, color: 'var(--color-slate-light)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 14 }}>
        {t('pages.dashboard.livePreview')}
      </div>

      {/* Fake card */}
      <div style={{ background: '#fff', border: `2px solid ${color}33`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
        {/* Card header */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', flex: 1 }}>
            {title || t('pages.dashboard.widgetTitlePlaceholder')}
          </span>
          {timeRange && timeRange !== 'all' && timeRangeKey && (
            <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: 'var(--color-slate-light)' }}>
              {t(timeRangeKey)}
            </span>
          )}
        </div>

        {/* Card body */}
        {dataFree ? (
          <ActiveAlarmsWidget color={color} large />
        ) : previewLoading ? (
          <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 28, height: 28, border: `3px solid ${color}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        ) : !previewData ? (
          <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
            {t('pages.dashboard.configureHint')}
          </div>
        ) : (
          <Suspense fallback={<div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('pages.dashboard.chartLoading')}</div>}>
            <WidgetBody widgetType={widgetType} color={color} data={previewData} caption={title || t('pages.dashboard.preview')} large />
          </Suspense>
        )}
      </div>

      {/* Stats */}
      {previewData && !previewLoading && !dataFree && (
        <div style={{ marginTop: 12, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', display: 'flex', gap: 16 }}>
          {previewData.value != null && <span>{t('pages.dashboard.total')} <strong>{Math.round(previewData.value).toLocaleString(i18n.language)}</strong></span>}
          {previewData.series.length > 0 && <span>{t('pages.dashboard.categories')} <strong>{previewData.series.length}</strong></span>}
        </div>
      )}

      {/* Spacer + hint */}
      <div style={{ flex: 1 }} />
      <div style={{ marginTop: 16, padding: 12, background: '#f0f9ff', borderRadius: 8, fontSize: 'var(--font-size-table)', color: '#0369a1', lineHeight: 1.5 }}>
        {'💡'} {t('pages.dashboard.previewHint')}
      </div>
    </div>
  )
}
