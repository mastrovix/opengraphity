import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Hash, BarChart2, PieChart, TrendingUp, Table, Gauge, Activity, X, Radar } from 'lucide-react'
import { GET_WIDGET_DATA } from '@/graphql/queries'
import { lookupOrError } from '@/lib/tokens'
import { WidgetBody, type WidgetSeriesData } from '@/components/WidgetBody'
import { ActiveAlarmsWidget, ACTIVE_ALARMS_WIDGET_TYPE } from './ActiveAlarmsWidget'

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

/** Chiave i18n dell'etichetta di periodo (allineata a TIME_RANGES in useWidgetConfig). */
const TIME_LABEL_KEY: Record<string, string> = {
  '24h': 'pages.dashboard.timeRange.24h',
  '7d':  'pages.dashboard.timeRange.7d',
  '30d': 'pages.dashboard.timeRange.30d',
  '90d': 'pages.dashboard.timeRange.90d',
  '1y':  'pages.dashboard.timeRange.1y',
  all:   'pages.dashboard.timeRange.all',
}

// ── Widget type icon ──────────────────────────────────────────────────────────

const TYPE_ICON: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  counter: Hash, chart_bar: BarChart2, chart_line: TrendingUp, chart_pie: PieChart,
  chart_donut: PieChart, table: Table, gauge: Gauge, heatmap: Activity,
  active_alarms: Radar,
}

function TypeIcon({ type, color }: { type: string; color: string }) {
  const Icon = lookupOrError(TYPE_ICON, type, 'WIDGET_TYPE_ICON', BarChart2)
  return <Icon size={14} color={color} />
}

// ── CustomWidgetCard ──────────────────────────────────────────────────────────

export function CustomWidgetCard({ widget, editMode, onEdit, onRemove }: Props) {
  const { t } = useTranslation()
  // "Allarmi attivi" legge eventStats (ActiveAlarmsWidget), non widgetData.
  const isActiveAlarms = widget.widgetType === ACTIVE_ALARMS_WIDGET_TYPE
  const { data, loading, error } = useQuery<{ widgetData: WidgetSeriesData }>(GET_WIDGET_DATA, {
    variables: { widgetId: widget.id },
    fetchPolicy: 'cache-and-network',
    skip: isActiveAlarms,
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

  const timeLabelKey = widget.timeRange ? TIME_LABEL_KEY[widget.timeRange] : undefined

  const header = (
    <div style={headerStyle}>
      <TypeIcon type={widget.widgetType} color={widget.color} />
      <span style={{ flex: 1, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {widget.title}
      </span>
      {widget.timeRange && widget.timeRange !== 'all' && (
        <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: 'var(--color-slate-light)' }}>
          {timeLabelKey ? t(timeLabelKey) : widget.timeRange}
        </span>
      )}
      {editMode && (
        <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
          <button
            type="button"
            onClick={onEdit}
            style={{ width: 20, height: 20, border: '1px solid #d1d5db', background: '#fff', borderRadius: 4, cursor: 'pointer', fontSize: 'var(--font-size-table)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title={t('pages.dashboard.editWidget')}
            aria-label={t('pages.dashboard.editWidget')}
          >✏</button>
          <button
            type="button"
            onClick={onRemove}
            style={{ width: 20, height: 20, border: '1px solid #fca5a5', background: 'var(--color-danger-bg)', borderRadius: 4, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title={t('pages.dashboard.removeWidget')}
            aria-label={t('pages.dashboard.removeWidget')}
          ><X size={12} aria-hidden="true" /></button>
        </div>
      )}
    </div>
  )

  // ── Body ─────────────────────────────────────────────────────────────────────

  let body: React.ReactNode
  if (isActiveAlarms) {
    body = <ActiveAlarmsWidget color={widget.color} />
  } else if (loading && !wData) {
    body = (
      <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 24, height: 24, border: `3px solid ${widget.color}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  } else if (error || !wData) {
    body = (
      <div style={{ padding: 16, fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' }}>
        {error?.message ?? t('pages.dashboard.loadError')}
      </div>
    )
  } else {
    body = (
      <WidgetBody
        widgetType={widget.widgetType}
        color={widget.color}
        data={wData}
        caption={widget.filterValue ? t('pages.dashboard.statusCaption', { value: widget.filterValue }) : widget.entityType}
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
