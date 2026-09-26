import { useTranslation } from 'react-i18next'
import { ReportChartRenderer } from '@/components/ReportChartRenderer'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DashboardWidgetData {
  id: string
  order: number
  colSpan: number
  reportTemplateId: string
  reportSectionId: string
  data: string | null
  error: string | null
  reportSection: { id: string; title: string; chartType: string } | null
  reportTemplate: { id: string; name: string; description?: string | null } | null
}

interface DashboardWidgetProps {
  widget: DashboardWidgetData
}

const oneLine = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const

/**
 * The line under the section's title: the report it comes from, unless it only
 * repeats the title (tour of 24 Sep 2026, G2: «Open incidents / Open Incidents»);
 * then what the report says of itself, its description.
 */
function widgetSubtitle(widget: DashboardWidgetData): string {
  const name = widget.reportTemplate?.name?.trim() ?? ''
  const title = (widget.reportSection?.title ?? '').trim()
  if (name && name.toLowerCase() !== title.toLowerCase()) return name
  return widget.reportTemplate?.description?.trim() ?? ''
}

export function DashboardWidget({ widget }: DashboardWidgetProps) {
  const { t } = useTranslation()
  const title = widget.reportSection?.title ?? t('pages.dashboard.widgetFallback')
  const subtitle = widgetSubtitle(widget)
  // Every card fills its row and every header has two lines, the second even
  // when empty: cards side by side line up, header and figures alike (25 Sep 2026).
  return (
    <div key={widget.id} style={{ gridColumn: `span ${widget.colSpan}`, display: 'flex' }}>
      <div className="card-border" style={{ overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-light)' }}>
          <div title={title} style={{ ...oneLine, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)' }}>
            {title}
          </div>
          <div title={subtitle || undefined} data-testid="widget-subtitle" style={{ ...oneLine, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 1 }}>
            {subtitle || ' '}
          </div>
        </div>
        <ReportChartRenderer
          chartType={widget.reportSection?.chartType ?? 'bar'}
          data={widget.data ?? ''}
          title={widget.reportSection?.title ?? ''}
          error={widget.error}
        />
      </div>
    </div>
  )
}
