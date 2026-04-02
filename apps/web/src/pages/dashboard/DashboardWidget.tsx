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
  reportTemplate: { id: string; name: string } | null
}

interface DashboardWidgetProps {
  widget: DashboardWidgetData
}

export function DashboardWidget({ widget }: DashboardWidgetProps) {
  return (
    <div key={widget.id} style={{ gridColumn: `span ${widget.colSpan}` }}>
      <div className="card-border" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)' }}>
            {widget.reportSection?.title ?? 'Widget'}
          </div>
          {widget.reportTemplate?.name && (
            <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginTop: 1 }}>{widget.reportTemplate.name}</div>
          )}
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
