import { useQuery } from '@apollo/client/react'
import ReactECharts from 'echarts-for-react'
import { Hash, BarChart2, PieChart, TrendingUp, Table, Gauge, Activity } from 'lucide-react'
import { GET_WIDGET_DATA } from '@/graphql/queries'

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

interface WidgetDataResult {
  value:  number | null
  label:  string | null
  series: { label: string; value: number; color?: string | null }[]
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

function TypeIcon({ type, color }: { type: string; color: string }) {
  const props = { size: 14, color }
  switch (type) {
    case 'counter':    return <Hash {...props} />
    case 'chart_bar':  return <BarChart2 {...props} />
    case 'chart_line': return <TrendingUp {...props} />
    case 'chart_pie':  return <PieChart {...props} />
    case 'chart_donut':return <PieChart {...props} />
    case 'table':      return <Table {...props} />
    case 'gauge':      return <Gauge {...props} />
    case 'heatmap':    return <Activity {...props} />
    default:           return <BarChart2 {...props} />
  }
}

// ── Chart builders ────────────────────────────────────────────────────────────

function buildBarOption(data: WidgetDataResult, color: string) {
  return {
    tooltip: { trigger: 'axis', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 12 } },
    grid:    { top: 12, right: 12, bottom: 20, left: 40, containLabel: true },
    xAxis:   { type: 'category', data: data.series.map(s => s.label), axisLabel: { fontSize: 11, color: '#64748b' } },
    yAxis:   { type: 'value', axisLabel: { fontSize: 11, color: '#64748b' } },
    series:  [{ type: 'bar', data: data.series.map(s => s.value), itemStyle: { color, borderRadius: [3, 3, 0, 0] } }],
  }
}

function buildPieOption(data: WidgetDataResult, _color: string, donut = false) {
  const palette = ['#0EA5E9','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#84cc16']
  return {
    tooltip: { trigger: 'item', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 12 }, formatter: '{b}: {c} ({d}%)' },
    legend:  { orient: 'horizontal', bottom: 0, textStyle: { fontSize: 11, color: '#64748b' } },
    series:  [{
      type: 'pie', radius: donut ? ['40%', '70%'] : '65%',
      center: ['50%', '45%'],
      data: data.series.map((s, i) => ({ name: s.label, value: s.value, itemStyle: { color: palette[i % palette.length] } })),
      label: { show: false },
      labelLine: { show: false },
    }],
  }
}

function buildLineOption(data: WidgetDataResult, color: string) {
  return {
    tooltip: { trigger: 'axis', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 12 } },
    grid:    { top: 12, right: 12, bottom: 20, left: 40, containLabel: true },
    xAxis:   { type: 'category', data: data.series.map(s => s.label), axisLabel: { fontSize: 11, color: '#64748b' } },
    yAxis:   { type: 'value', axisLabel: { fontSize: 11, color: '#64748b' } },
    series:  [{
      type: 'line', data: data.series.map(s => s.value),
      smooth: true, lineStyle: { color }, itemStyle: { color },
      areaStyle: { color: `${color}22` },
    }],
  }
}

function buildGaugeOption(data: WidgetDataResult, color: string) {
  const val = Math.min(100, Math.max(0, data.value ?? 0))
  return {
    series: [{
      type: 'gauge', startAngle: 200, endAngle: -20,
      min: 0, max: 100, splitNumber: 5,
      axisLine: { lineStyle: { width: 18, color: [[val / 100, color], [1, '#e5e7eb']] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      detail: { fontSize: 22, fontWeight: 600, color: 'var(--color-slate-dark)', formatter: `${Math.round(val)}%`, offsetCenter: [0, '20%'] },
      data: [{ value: val }],
    }],
  }
}

// ── CustomWidgetCard ──────────────────────────────────────────────────────────

export function CustomWidgetCard({ widget, editMode, onEdit, onRemove }: Props) {
  const { data, loading, error } = useQuery<{ widgetData: WidgetDataResult }>(GET_WIDGET_DATA, {
    variables: { widgetId: widget.id },
    fetchPolicy: 'cache-and-network',
  })

  const colSpan = SIZE_COLSPAN[widget.size] ?? 6
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
      <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {widget.title}
      </span>
      {widget.timeRange && widget.timeRange !== 'all' && (
        <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: 'var(--color-slate-light)' }}>
          {TIME_LABEL[widget.timeRange] ?? widget.timeRange}
        </span>
      )}
      {editMode && (
        <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
          <button
            onClick={onEdit}
            style={{ width: 20, height: 20, border: '1px solid #d1d5db', background: '#fff', borderRadius: 4, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Modifica widget"
          >✏</button>
          <button
            onClick={onRemove}
            style={{ width: 20, height: 20, border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: 'var(--color-danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Rimuovi widget"
          >×</button>
        </div>
      )}
    </div>
  )

  // ── Body ─────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={cardStyle}>
        {header}
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 24, height: 24, border: `3px solid ${widget.color}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        </div>
      </div>
    )
  }

  if (error || !wData) {
    return (
      <div style={cardStyle}>
        {header}
        <div style={{ padding: 16, fontSize: 12, color: '#ef4444' }}>
          {error?.message ?? 'Errore nel caricamento dati'}
        </div>
      </div>
    )
  }

  // ── Counter ──────────────────────────────────────────────────────────────────

  if (widget.widgetType === 'counter') {
    return (
      <div style={cardStyle}>
        {header}
        <div style={{ padding: '20px 14px', textAlign: 'center' }}>
          <div style={{ fontSize: 42, fontWeight: 700, color: widget.color, lineHeight: 1 }}>
            {wData.value != null ? Math.round(wData.value).toLocaleString('it-IT') : '—'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginTop: 6 }}>
            {widget.filterValue ? `Status: ${widget.filterValue}` : widget.entityType}
          </div>
        </div>
      </div>
    )
  }

  // ── Table ────────────────────────────────────────────────────────────────────

  if (widget.widgetType === 'table') {
    return (
      <div style={cardStyle}>
        {header}
        <div style={{ overflow: 'auto', maxHeight: 220 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--color-slate-light)', fontWeight: 600 }}>Label</th>
                <th style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--color-slate-light)', fontWeight: 600 }}>Valore</th>
              </tr>
            </thead>
            <tbody>
              {wData.series.map((s, i) => (
                <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '5px 10px', color: 'var(--color-slate-dark)' }}>{s.label}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 600, color: widget.color }}>{s.value.toLocaleString('it-IT')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // ── Gauge ────────────────────────────────────────────────────────────────────

  if (widget.widgetType === 'gauge') {
    return (
      <div style={cardStyle}>
        {header}
        <ReactECharts
          option={buildGaugeOption(wData, widget.color)}
          style={{ height: 160 }}
          opts={{ renderer: 'svg' }}
        />
      </div>
    )
  }

  // ── ECharts (bar, line, pie, donut) ───────────────────────────────────────────

  let option: object
  switch (widget.widgetType) {
    case 'chart_bar':   option = buildBarOption(wData, widget.color); break
    case 'chart_line':  option = buildLineOption(wData, widget.color); break
    case 'chart_pie':   option = buildPieOption(wData, widget.color, false); break
    case 'chart_donut': option = buildPieOption(wData, widget.color, true); break
    default:            option = buildBarOption(wData, widget.color)
  }

  return (
    <div style={cardStyle}>
      {header}
      <ReactECharts
        option={option}
        style={{ height: 180 }}
        opts={{ renderer: 'svg' }}
      />
    </div>
  )
}
