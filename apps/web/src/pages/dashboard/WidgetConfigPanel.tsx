import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import {
  Hash, BarChart2, TrendingUp, PieChart, Table, Gauge, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { CREATE_CUSTOM_WIDGET, UPDATE_CUSTOM_WIDGET } from '@/graphql/mutations'
import { GET_WIDGET_DATA_PREVIEW, GET_ITIL_TYPES, GET_CI_TYPES } from '@/graphql/queries'
import type { CustomWidgetData } from './CustomWidgetCard'

// ── Constants ─────────────────────────────────────────────────────────────────

const WIDGET_TYPES = [
  { value: 'counter',     label: 'Counter',   Icon: Hash,      desc: 'Numero totale' },
  { value: 'chart_bar',   label: 'Bar Chart', Icon: BarChart2, desc: 'Distribuzione' },
  { value: 'chart_line',  label: 'Line',      Icon: TrendingUp,desc: 'Trend' },
  { value: 'chart_pie',   label: 'Pie Chart', Icon: PieChart,  desc: 'Proporzioni' },
  { value: 'chart_donut', label: 'Donut',     Icon: PieChart,  desc: 'Proporzioni' },
  { value: 'table',       label: 'Tabella',   Icon: Table,     desc: 'Lista valori' },
  { value: 'gauge',       label: 'Gauge',     Icon: Gauge,     desc: '% su 100' },
] as const

const ENTITY_TYPES = [
  { value: 'incident',      label: 'Incident' },
  { value: 'problem',       label: 'Problem' },
  { value: 'change',        label: 'Change' },
  { value: 'service_request', label: 'Service Request' },
  { value: 'server',        label: 'Server' },
  { value: 'application',   label: 'Application' },
  { value: 'database',      label: 'Database' },
  { value: 'certificate',   label: 'Certificate' },
  { value: 'network_device',label: 'Network Device' },
  { value: 'vm',            label: 'Virtual Machine' },
]

const METRICS = [
  { value: 'count',          label: 'Conteggio' },
  { value: 'count_by_field', label: 'Conteggio per campo' },
  { value: 'avg_field',      label: 'Media campo' },
  { value: 'sum_field',      label: 'Somma campo' },
]

const ALLOWED_FIELDS: Record<string, string[]> = {
  incident:        ['status', 'severity', 'category'],
  problem:         ['status', 'priority', 'category'],
  change:          ['status', 'type', 'priority', 'risk', 'impact'],
  service_request: ['status', 'priority', 'category'],
  server:          ['status', 'environment', 'os'],
  application:     ['status', 'environment'],
  database:        ['status', 'environment'],
  certificate:     ['status', 'environment'],
  network_device:  ['status', 'environment'],
  vm:              ['status', 'environment'],
}

const TIME_RANGES = [
  { value: '24h', label: '24h' },
  { value: '7d',  label: '7gg' },
  { value: '30d', label: '30gg' },
  { value: '90d', label: '90gg' },
  { value: '1y',  label: '1 anno' },
  { value: 'all', label: 'Tutto' },
]

const PRESET_COLORS = [
  '#0EA5E9', // cyan
  '#10b981', // green
  '#ef4444', // red
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#64748b', // slate
]

const SIZE_OPTIONS = [
  { value: 'small',  label: 'Piccolo',  sub: '1/4 larghezza' },
  { value: 'medium', label: 'Medio',    sub: '1/2 larghezza' },
  { value: 'large',  label: 'Grande',   sub: 'Larghezza intera' },
]

const ITIL_ENTITIES = new Set(['incident', 'problem', 'change', 'service_request'])

interface FieldMeta {
  name:       string
  label:      string
  fieldType:  string      // string | number | date | boolean | enum
  enumValues: string[]    // non-empty when fieldType === 'enum'
}

const FIELD_TYPE_LABELS: Record<string, string> = {
  string: 'testo', number: 'numero', date: 'data', boolean: 'booleano', enum: 'enum',
}

// ── Preview component (inline, not using CustomWidgetCard to keep deps clean) ─

interface PreviewData {
  value: number | null
  label: string | null
  series: { label: string; value: number; color?: string | null }[]
}

function WidgetPreview({
  widgetType, color, title, data, loading,
}: {
  widgetType: string
  color: string
  title: string
  data: PreviewData | null
  loading: boolean
}) {
  if (loading) {
    return (
      <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 28, height: 28, border: `3px solid ${color}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-slate-light)', fontSize: 13 }}>
        Configura le opzioni sopra per vedere l'anteprima
      </div>
    )
  }

  if (widgetType === 'counter') {
    return (
      <div style={{ padding: '24px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 52, fontWeight: 700, color, lineHeight: 1 }}>
          {data.value != null ? Math.round(data.value).toLocaleString('it-IT') : '—'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-slate-light)', marginTop: 8 }}>{title}</div>
      </div>
    )
  }

  if (widgetType === 'table') {
    return (
      <div style={{ maxHeight: 200, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f8fafc' }}>
              <th style={{ padding: '5px 10px', textAlign: 'left', color: 'var(--color-slate-light)', fontWeight: 600 }}>Label</th>
              <th style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--color-slate-light)', fontWeight: 600 }}>Valore</th>
            </tr>
          </thead>
          <tbody>
            {data.series.length === 0 ? (
              <tr><td colSpan={2} style={{ padding: '12px 10px', textAlign: 'center', color: 'var(--color-slate-light)' }}>Nessun dato</td></tr>
            ) : (
              data.series.map((s, i) => (
                <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '4px 10px', color: 'var(--color-slate-dark)' }}>{s.label}</td>
                  <td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 600, color }}>{s.value.toLocaleString('it-IT')}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    )
  }

  // Bar / Pie / Line / Donut / Gauge — lazy-load ECharts
  return <EChartsPreview widgetType={widgetType} color={color} data={data} />
}

type EChartsComponent = React.ComponentType<{ option: object; style?: React.CSSProperties; opts?: { renderer: string } }>

// Lazy ECharts to avoid loading it eagerly
function EChartsPreview({ widgetType, color, data }: { widgetType: string; color: string; data: PreviewData }) {
  const [ReactECharts, setReactECharts] = useState<EChartsComponent | null>(null)

  useEffect(() => {
    import('echarts-for-react').then((m) => {
      const C = m.default as EChartsComponent
      setReactECharts(() => C)
    })
  }, [])

  if (!ReactECharts) return <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--color-slate-light)' }}>Caricamento grafico…</div>

  const palette = ['#0EA5E9','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#84cc16']

  let option: object

  if (widgetType === 'chart_bar') {
    option = {
      tooltip: { trigger: 'axis', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 11 } },
      grid: { top: 8, right: 8, bottom: 20, left: 36, containLabel: true },
      xAxis: { type: 'category', data: data.series.map(s => s.label), axisLabel: { fontSize: 10, color: '#64748b' } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#64748b' } },
      series: [{ type: 'bar', data: data.series.map(s => s.value), itemStyle: { color, borderRadius: [3,3,0,0] } }],
    }
  } else if (widgetType === 'chart_line') {
    option = {
      tooltip: { trigger: 'axis', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 11 } },
      grid: { top: 8, right: 8, bottom: 20, left: 36, containLabel: true },
      xAxis: { type: 'category', data: data.series.map(s => s.label), axisLabel: { fontSize: 10, color: '#64748b' } },
      yAxis: { type: 'value', axisLabel: { fontSize: 10, color: '#64748b' } },
      series: [{ type: 'line', data: data.series.map(s => s.value), smooth: true, lineStyle: { color }, itemStyle: { color }, areaStyle: { color: `${color}22` } }],
    }
  } else if (widgetType === 'chart_pie' || widgetType === 'chart_donut') {
    option = {
      tooltip: { trigger: 'item', backgroundColor: '#1e293b', textStyle: { color: '#f8fafc', fontSize: 11 }, formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'horizontal', bottom: 0, textStyle: { fontSize: 10, color: '#64748b' } },
      series: [{
        type: 'pie', radius: widgetType === 'chart_donut' ? ['38%','65%'] : '60%', center: ['50%','42%'],
        data: data.series.map((s, i) => ({ name: s.label, value: s.value, itemStyle: { color: palette[i % palette.length] } })),
        label: { show: false }, labelLine: { show: false },
      }],
    }
  } else {
    const val = Math.min(100, Math.max(0, data.value ?? 0))
    option = {
      series: [{
        type: 'gauge', startAngle: 200, endAngle: -20, min: 0, max: 100, splitNumber: 5,
        axisLine: { lineStyle: { width: 16, color: [[val/100, color],[1,'#e5e7eb']] } },
        pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
        detail: { fontSize: 20, fontWeight: 600, color: 'var(--color-slate-dark)', formatter: `${Math.round(val)}%`, offsetCenter: [0,'20%'] },
        data: [{ value: val }],
      }],
    }
  }

  return <ReactECharts option={option} style={{ height: 180 }} opts={{ renderer: 'svg' }} />
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  dashboardId: string
  widget?:     CustomWidgetData | null
  onClose:     () => void
  onSaved:     (widget: CustomWidgetData) => void
}

// ── Dynamic filter value input ───────────────────────────────────────────────

function FilterValueInput({ meta, value, onChange, disabled, color }: {
  meta: FieldMeta | null; value: string; onChange: (v: string) => void; disabled: boolean; color: string
}) {
  const opacityStyle = { opacity: disabled ? 0.45 : 1 }

  // No field selected — disabled text input
  if (!meta || disabled) {
    return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Es. new" disabled style={{ ...inputStyle, ...opacityStyle }} />
  }

  // Enum — dropdown with values
  if (meta.fieldType === 'enum' && meta.enumValues.length > 0) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
        <option value="">-- Tutti --</option>
        {meta.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  // Boolean — toggle
  if (meta.fieldType === 'boolean') {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {['true', 'false'].map((v) => (
          <button
            key={v}
            onClick={() => onChange(value === v ? '' : v)}
            style={{
              flex: 1, padding: '7px 0', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600, textAlign: 'center',
              border: value === v ? `1.5px solid ${color}` : '1.5px solid #e5e7eb',
              background: value === v ? `${color}14` : '#fff',
              color: value === v ? color : 'var(--color-slate)',
            }}
          >
            {v === 'true' ? 'Sì' : 'No'}
          </button>
        ))}
      </div>
    )
  }

  // Date — date picker
  if (meta.fieldType === 'date') {
    return (
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    )
  }

  // Number — numeric input
  if (meta.fieldType === 'number') {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Es. 5"
        style={inputStyle}
      />
    )
  }

  // Default (string) — text input
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Es. new"
      style={inputStyle}
    />
  )
}

// ── Main Modal ────────────────────────────────────────────────────────────────

export function WidgetConfigPanel({ dashboardId, widget, onClose, onSaved }: Props) {
  const isEdit = !!widget

  const [title,        setTitle]        = useState(widget?.title        ?? '')
  const [widgetType,   setWidgetType]   = useState(widget?.widgetType   ?? 'counter')
  const [entityType,   setEntityType]   = useState(widget?.entityType   ?? 'incident')
  const [metric,       setMetric]       = useState(widget?.metric       ?? 'count')
  const [groupByField, setGroupByField] = useState(widget?.groupByField ?? '')
  const [filterField,  setFilterField]  = useState(widget?.filterField  ?? '')
  const [filterValue,  setFilterValue]  = useState(widget?.filterValue  ?? '')
  const [timeRange,    setTimeRange]    = useState(widget?.timeRange     ?? 'all')
  const [size,         setSize]         = useState(widget?.size          ?? 'medium')
  const [color,        setColor]        = useState(widget?.color         ?? '#0EA5E9')
  const [saving,       setSaving]       = useState(false)

  // Debounced preview vars
  const [previewVars, setPreviewVars] = useState<{
    entityType: string; metric: string; groupByField?: string; filterField?: string; filterValue?: string; timeRange?: string
  } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fields      = ALLOWED_FIELDS[entityType] ?? []
  const needsGroupBy = metric === 'count_by_field' || metric === 'avg_field' || metric === 'sum_field'

  // ── Load field metadata from type definitions ──────────────────────────────
  const isITIL = ITIL_ENTITIES.has(entityType)
  const { data: itilTypesData } = useQuery(GET_ITIL_TYPES, { skip: !isITIL })
  const { data: ciTypesData }   = useQuery(GET_CI_TYPES,   { skip: isITIL })

  const fieldMetaMap = useMemo<Record<string, FieldMeta>>(() => {
    const map: Record<string, FieldMeta> = {}

    type TypeDef = { name: string; fields: { name: string; label: string; fieldType: string; enumValues?: string[] }[] }
    const itilTypes = (itilTypesData as { itilTypes?: TypeDef[] } | undefined)?.itilTypes
    const ciTypes   = (ciTypesData   as { ciTypes?:   TypeDef[] } | undefined)?.ciTypes

    if (isITIL && itilTypes) {
      const typeDef = itilTypes.find(t => t.name === entityType)
      if (typeDef) {
        for (const f of typeDef.fields) {
          map[f.name] = { name: f.name, label: f.label || f.name, fieldType: f.fieldType, enumValues: f.enumValues ?? [] }
        }
      }
    } else if (!isITIL && ciTypes) {
      const typeDef = ciTypes.find(t => t.name === entityType)
      if (typeDef) {
        for (const f of typeDef.fields) {
          map[f.name] = { name: f.name, label: f.label || f.name, fieldType: f.fieldType, enumValues: f.enumValues ?? [] }
        }
      }
    }

    return map
  }, [isITIL, entityType, itilTypesData, ciTypesData])

  const selectedFilterMeta = filterField ? fieldMetaMap[filterField] : null

  // Trigger preview update (debounced 600ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setPreviewVars({
        entityType,
        metric,
        groupByField: needsGroupBy && groupByField ? groupByField : undefined,
        filterField:  filterField  || undefined,
        filterValue:  filterValue  || undefined,
        timeRange:    timeRange !== 'all' ? timeRange : undefined,
      })
    }, 600)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [entityType, metric, groupByField, filterField, filterValue, timeRange, needsGroupBy])

  const { data: previewData, loading: previewLoading } = useQuery(GET_WIDGET_DATA_PREVIEW, {
    variables: previewVars ?? { entityType, metric },
    skip: !previewVars,
    fetchPolicy: 'cache-and-network',
  })

  const [createWidget] = useMutation(CREATE_CUSTOM_WIDGET)
  const [updateWidget] = useMutation(UPDATE_CUSTOM_WIDGET)

  function handleEntityChange(et: string) {
    setEntityType(et)
    setGroupByField('')
    setFilterField('')
    setFilterValue('')
  }

  async function handleSave() {
    if (!title.trim()) { toast.error('Inserisci un titolo'); return }
    setSaving(true)
    try {
      const input = {
        title:        title.trim(),
        widgetType,
        entityType,
        metric,
        groupByField: (needsGroupBy && groupByField) ? groupByField : null,
        filterField:  filterField  || null,
        filterValue:  filterValue  || null,
        timeRange:    timeRange === 'all' ? null : (timeRange || null),
        size,
        color,
      }

      let saved: CustomWidgetData
      if (isEdit && widget) {
        const res = await updateWidget({ variables: { id: widget.id, input } })
        saved = (res.data as { updateCustomWidget: CustomWidgetData }).updateCustomWidget
        toast.success('Widget aggiornato')
      } else {
        const res = await createWidget({ variables: { input: { ...input, dashboardId } } })
        saved = (res.data as { createCustomWidget: CustomWidgetData }).createCustomWidget
        toast.success('Widget creato')
      }
      onSaved(saved)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Errore')
    } finally {
      setSaving(false)
    }
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const pd = (previewData as { widgetDataPreview: PreviewData } | undefined)?.widgetDataPreview ?? null

  // ── Render — portal to document.body to escape any stacking context ─────────

  return createPortal(
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 900, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.22)', display: 'flex', flexDirection: 'column' }}>

        {/* ── Modal header ──────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
            {isEdit ? 'Modifica widget' : 'Nuovo widget personalizzato'}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', alignItems: 'center' }}>
            <X size={20} color="var(--color-slate-light)" />
          </button>
        </div>

        {/* ── Body: form + preview ──────────────────────────────────────────── */}
        <div style={{ display: 'flex', flex: 1, gap: 0, minHeight: 0 }}>

          {/* Form column */}
          <div style={{ flex: '0 0 420px', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', borderRight: '1px solid #f3f4f6' }}>

            {/* Title */}
            <div>
              <label style={labelStyle}>Titolo *</label>
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Es. Incident aperti oggi"
                style={inputStyle}
              />
            </div>

            {/* Widget type — 7 cards */}
            <div>
              <label style={labelStyle}>Tipo widget</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                {WIDGET_TYPES.map(({ value, label, Icon }) => (
                  <button
                    key={value}
                    onClick={() => setWidgetType(value)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                      padding: '10px 6px', borderRadius: 8, cursor: 'pointer',
                      border: widgetType === value ? `2px solid ${color}` : '1.5px solid #e5e7eb',
                      background: widgetType === value ? `${color}14` : '#fafafa',
                      color: widgetType === value ? color : 'var(--color-slate)',
                      transition: 'all 0.1s',
                    }}
                  >
                    <Icon size={20} />
                    <span style={{ fontSize: 11, fontWeight: 600 }}>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Entity */}
            <div>
              <label style={labelStyle}>Entità</label>
              <select value={entityType} onChange={(e) => handleEntityChange(e.target.value)} style={selectStyle}>
                {ENTITY_TYPES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
              </select>
            </div>

            {/* Metric */}
            <div>
              <label style={labelStyle}>Metrica</label>
              <select value={metric} onChange={(e) => { setMetric(e.target.value); setGroupByField('') }} style={selectStyle}>
                {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {/* Group by — only when needed */}
            {needsGroupBy && (
              <div>
                <label style={labelStyle}>Campo raggruppamento</label>
                <select value={groupByField} onChange={(e) => setGroupByField(e.target.value)} style={selectStyle}>
                  <option value="">-- Seleziona campo --</option>
                  {fields.map((f) => {
                    const meta = fieldMetaMap[f]
                    const typeLabel = meta ? FIELD_TYPE_LABELS[meta.fieldType] ?? meta.fieldType : ''
                    return <option key={f} value={f}>{meta?.label ?? f}{typeLabel ? ` (${typeLabel})` : ''}</option>
                  })}
                </select>
              </div>
            )}

            {/* Filter */}
            <div>
              <label style={labelStyle}>Filtro (opzionale)</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <select value={filterField} onChange={(e) => { setFilterField(e.target.value); setFilterValue('') }} style={selectStyle}>
                  <option value="">Nessun filtro</option>
                  {fields.map((f) => {
                    const meta = fieldMetaMap[f]
                    const typeLabel = meta ? FIELD_TYPE_LABELS[meta.fieldType] ?? meta.fieldType : ''
                    return <option key={f} value={f}>{meta?.label ?? f}{typeLabel ? ` (${typeLabel})` : ''}</option>
                  })}
                </select>
                <FilterValueInput
                  meta={selectedFilterMeta}
                  value={filterValue}
                  onChange={setFilterValue}
                  disabled={!filterField}
                  color={color}
                />
              </div>
            </div>

            {/* Period — 6 buttons */}
            <div>
              <label style={labelStyle}>Periodo</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {TIME_RANGES.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setTimeRange(value)}
                    style={{
                      padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500,
                      border: timeRange === value ? `1.5px solid ${color}` : '1.5px solid #e5e7eb',
                      background: timeRange === value ? `${color}14` : '#fff',
                      color: timeRange === value ? color : 'var(--color-slate)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Size — 3 buttons */}
            <div>
              <label style={labelStyle}>Dimensione</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {SIZE_OPTIONS.map(({ value, label, sub }) => (
                  <button
                    key={value}
                    onClick={() => setSize(value)}
                    style={{
                      flex: 1, padding: '8px 6px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                      border: size === value ? `2px solid ${color}` : '1.5px solid #e5e7eb',
                      background: size === value ? `${color}14` : '#fafafa',
                      color: size === value ? color : 'var(--color-slate)',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 10, color: 'var(--color-slate-light)', marginTop: 1 }}>{sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Color — 6 circles + custom */}
            <div>
              <label style={labelStyle}>Colore</label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    style={{
                      width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                      border: color === c ? '3px solid #1e293b' : '2.5px solid transparent',
                      outline: color === c ? `2.5px solid ${c}` : 'none',
                      outlineOffset: 1,
                      transition: 'transform 0.1s',
                      transform: color === c ? 'scale(1.2)' : 'scale(1)',
                    }}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  title="Colore personalizzato"
                  style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid #d1d5db', cursor: 'pointer', padding: 2 }}
                />
              </div>
            </div>
          </div>

          {/* Preview column */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px 24px', background: '#f8fafc', minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-slate-light)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 14 }}>
              Anteprima live
            </div>

            {/* Fake card */}
            <div style={{ background: '#fff', border: `2px solid ${color}33`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
              {/* Card header */}
              <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-slate)', flex: 1 }}>
                  {title || 'Titolo widget'}
                </span>
                {timeRange && timeRange !== 'all' && (
                  <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#f1f5f9', color: 'var(--color-slate-light)' }}>
                    {TIME_RANGES.find(t => t.value === timeRange)?.label}
                  </span>
                )}
              </div>

              {/* Card body */}
              <WidgetPreview
                widgetType={widgetType}
                color={color}
                title={title || 'Anteprima'}
                data={pd}
                loading={previewLoading}
              />
            </div>

            {/* Stats */}
            {pd && !previewLoading && (
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-slate-light)', display: 'flex', gap: 16 }}>
                {pd.value != null && <span>Totale: <strong>{Math.round(pd.value).toLocaleString('it-IT')}</strong></span>}
                {pd.series.length > 0 && <span>Categorie: <strong>{pd.series.length}</strong></span>}
              </div>
            )}

            {/* Spacer + hint */}
            <div style={{ flex: 1 }} />
            <div style={{ marginTop: 16, padding: 12, background: '#f0f9ff', borderRadius: 8, fontSize: 11, color: '#0369a1', lineHeight: 1.5 }}>
              💡 La preview si aggiorna automaticamente mentre configuri il widget (con debounce 600ms).
            </div>
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 24px', borderTop: '1px solid #f3f4f6', flexShrink: 0, background: '#fff' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: 'var(--color-slate)', fontSize: 14, cursor: 'pointer' }}>
            Annulla
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || !title.trim()}
            style={{
              padding: '8px 22px', borderRadius: 7, border: 'none', fontSize: 14, fontWeight: 600, cursor: saving || !title.trim() ? 'not-allowed' : 'pointer',
              background: saving || !title.trim() ? '#bfdbfe' : color,
              color: '#fff',
            }}
          >
            {saving ? 'Salvataggio…' : isEdit ? 'Aggiorna widget' : 'Crea widget'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Micro styles ──────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700,
  color: 'var(--color-slate)', marginBottom: 5,
  letterSpacing: 0.3, textTransform: 'uppercase',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7,
  border: '1.5px solid #e2e8f0', fontSize: 13,
  boxSizing: 'border-box', color: 'var(--color-slate-dark)',
  outline: 'none',
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 7,
  border: '1.5px solid #e2e8f0', fontSize: 13,
  background: '#fff', color: 'var(--color-slate-dark)',
}
