import { useQuery } from '@apollo/client/react'
import { Hash, BarChart2, PieChart, TrendingUp, Table, Gauge, Activity } from 'lucide-react'
import { GET_WIDGET_DATA } from '@/graphql/queries'
import { lookupOrError } from '@/lib/tokens'
import { WidgetBody, type WidgetSeriesData } from '@/components/WidgetBody'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CustomWidgetData {
  id:           string
  title:        string
  widgetType:   string
  entityType:   string
  metric:       string
  groupByField: string | null
  filterField:  string | null
  filterValue:  string | null
  timeRange:    string | null
  size:         string
  color:        string
  position:     number
  dashboardId:  string
}

interface Props {
  widget:   CustomWidgetData
  editMode?: boolean
  onEdit?:   () => void
  onRemove?: () => void
}

// ── Size → grid columns ───────────────────────────────────────────────────────

const SIZE_COLSPAN: Record<string, number> = { small: 3, medium: 6, large: 12 }

const TIME_LABEL: Record<string, string> = {
  '24h': '24h', '7d': '7gg', '30d': '30gg', '90d': '90gg', '1y': '1 anno', all: 'Tutto',
}

// ── Widget type icon ──────────────────────────────────────────────────────────

const TYPE_ICON: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  counter: Hash, chart_bar: BarChart2, chart_line: TrendingUp, chart_pie: PieChart,
  chart_donut: PieChart, table: Table, gauge: Gauge, heatmap: Activity,
}

function TypeIcon({ type, color }: { type: string; color: string }) {
  const Icon = lookupOrError(TYPE_ICON, type, 'WIDGET_TYPE_ICON', BarChart2)
  return <Icon size={14} color={color} />
}

// ── CustomWidgetCard ──────────────────────────────────────────────────────────

export function CustomWidgetCard({ widget, editMode, onEdit, onRemove }: Props) {
  const { data, loading, error } = useQuery<{ widgetData: WidgetSeriesData }>(GET_WIDGET_DATA, {
    variables: { widgetId: widget.id },
    fetchPolicy: 'cache-and-network',
  })

  const colSpan = lookupOrError(SIZE_COLSPAN, widget.size, 'SIZE_COLSPAN', 6)
  const wData   = data?.widgetData

  const cardStyle: React.CSSProperties = {
    gridColumn:    `span ${colSpan}`,
    background:    '#fff',
    border:        editMode ? `2px dashed ${widget.color}` : '1px solid #e5e7eb',
    borderRadius:  10,
    overflow:      'hidden',
    position:      'relative',
    boxShadow:     '0 1px 4px rgba(0,0,0,0.06)',
    transition:    'border 0.15s',
  }

  const headerStyle: React.CSSProperties = {
    padding:      '10px 14px',
    borderBottom: '1px solid #f3f4f6',
    display:      'flex',
    alignItems:   'center',
    gap:          7,
  }

  // ── Header ──────────────────────────────────────────────────────────────────

  const header = (
    <div style={headerStyle}>
      <TypeIcon type={widget.widgetType} color={widget.color} />
      <span style={{ flex: 1, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {widget.title}
      </span>
      {widget.timeRange && widget.timeRange !== 'all' && (
        <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: 'var(--color-slate-light)' }}>
          {lookupOrError(TIME_LABEL, widget.timeRange, 'TIME_LABEL', widget.timeRange)}
        </span>
      )}
      {editMode && (
        <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
          <button
            onClick={onEdit}
            style={{ width: 20, height: 20, border: '1px solid #d1d5db', background: '#fff', borderRadius: 4, cursor: 'pointer', fontSize: 'var(--font-size-table)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Modifica widget"
          >✏</button>
          <button
            onClick={onRemove}
            style={{ width: 20, height: 20, border: '1px solid #fca5a5', background: 'var(--color-danger-bg)', borderRadius: 4, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Rimuovi widget"
          >×</button>
        </div>
      )}
    </div>
  )

  // ── Body ─────────────────────────────────────────────────────────────────────

  let body: React.ReactNode
  if (loading && !wData) {
    body = (
      <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 24, height: 24, border: `3px solid ${widget.color}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  } else if (error || !wData) {
    body = (
      <div style={{ padding: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' }}>
        {error?.message ?? 'Errore nel caricamento dati'}
      </div>
    )
  } else {
    body = (
      <WidgetBody
        widgetType={widget.widgetType}
        color={widget.color}
        data={wData}
        caption={widget.filterValue ? `Status: ${widget.filterValue}` : widget.entityType}
      />
    )
  }

  return (
    <div style={cardStyle}>
      {header}
      {body}
    </div>
  )
}
