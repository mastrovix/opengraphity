import { useState, useEffect, useRef, useMemo } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { CREATE_CUSTOM_WIDGET, UPDATE_CUSTOM_WIDGET } from '@/graphql/mutations'
import { GET_WIDGET_DATA_PREVIEW, GET_ITIL_TYPES, GET_CI_TYPES } from '@/graphql/queries'
import type { CustomWidgetData } from './CustomWidgetCard'

// ── Constants ────────────────────────────────────────────────────────────────

export const WIDGET_TYPES = [
  { value: 'counter',     label: 'Counter',   icon: 'Hash',       desc: 'Numero totale' },
  { value: 'chart_bar',   label: 'Bar Chart', icon: 'BarChart2',  desc: 'Distribuzione' },
  { value: 'chart_line',  label: 'Line',      icon: 'TrendingUp', desc: 'Trend' },
  { value: 'chart_pie',   label: 'Pie Chart', icon: 'PieChart',   desc: 'Proporzioni' },
  { value: 'chart_donut', label: 'Donut',     icon: 'PieChart',   desc: 'Proporzioni' },
  { value: 'table',       label: 'Tabella',   icon: 'Table',      desc: 'Lista valori' },
  { value: 'gauge',       label: 'Gauge',     icon: 'Gauge',      desc: '% su 100' },
] as const

export const ENTITY_TYPES = [
  { value: 'incident',        label: 'Incident' },
  { value: 'problem',         label: 'Problem' },
  { value: 'change',          label: 'Change' },
  { value: 'service_request', label: 'Service Request' },
  { value: 'server',          label: 'Server' },
  { value: 'application',     label: 'Application' },
  { value: 'database',        label: 'Database' },
  { value: 'certificate',     label: 'Certificate' },
  { value: 'network_device',  label: 'Network Device' },
  { value: 'vm',              label: 'Virtual Machine' },
]

export const METRICS = [
  { value: 'count',          label: 'Conteggio' },
  { value: 'count_by_field', label: 'Conteggio per campo' },
  { value: 'avg_field',      label: 'Media campo' },
  { value: 'sum_field',      label: 'Somma campo' },
]

export const ALLOWED_FIELDS: Record<string, string[]> = {
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

export const TIME_RANGES = [
  { value: '24h', label: '24h' },
  { value: '7d',  label: '7gg' },
  { value: '30d', label: '30gg' },
  { value: '90d', label: '90gg' },
  { value: '1y',  label: '1 anno' },
  { value: 'all', label: 'Tutto' },
]

export const PRESET_COLORS = [
  '#0EA5E9', // cyan
  '#10b981', // green
  '#ef4444', // red
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#64748b', // slate
]

export const SIZE_OPTIONS = [
  { value: 'small',  label: 'Piccolo',  sub: '1/4 larghezza' },
  { value: 'medium', label: 'Medio',    sub: '1/2 larghezza' },
  { value: 'large',  label: 'Grande',   sub: 'Larghezza intera' },
]

const ITIL_ENTITIES = new Set(['incident', 'problem', 'change', 'service_request'])

export const FIELD_TYPE_LABELS: Record<string, string> = {
  string: 'testo', number: 'numero', date: 'data', boolean: 'booleano', enum: 'enum',
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface FieldMeta {
  name:       string
  label:      string
  fieldType:  string
  enumValues: string[]
}

export interface PreviewData {
  value: number | null
  label: string | null
  series: { label: string; value: number; color?: string | null }[]
}

export interface WidgetConfigState {
  // Form state
  title:        string
  setTitle:     (v: string) => void
  widgetType:   string
  setWidgetType:(v: string) => void
  entityType:   string
  metric:       string
  setMetric:    (v: string) => void
  groupByField: string
  setGroupByField: (v: string) => void
  filterField:  string
  setFilterField:  (v: string) => void
  filterValue:  string
  setFilterValue:  (v: string) => void
  timeRange:    string
  setTimeRange: (v: string) => void
  size:         string
  setSize:      (v: string) => void
  color:        string
  setColor:     (v: string) => void
  saving:       boolean

  // Computed
  isEdit:       boolean
  fields:       string[]
  needsGroupBy: boolean
  fieldMetaMap: Record<string, FieldMeta>
  selectedFilterMeta: FieldMeta | null

  // Preview
  previewData:    PreviewData | null
  previewLoading: boolean

  // Handlers
  handleEntityChange: (et: string) => void
  handleSave:         () => Promise<void>
}

// ── Hook ─────────────────────────────────────────────────────────────────────

interface UseWidgetConfigParams {
  dashboardId: string
  widget?:     CustomWidgetData | null
  onClose:     () => void
  onSaved:     (widget: CustomWidgetData) => void
}

export function useWidgetConfig({ dashboardId, widget, onClose, onSaved }: UseWidgetConfigParams): WidgetConfigState {
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

  const { data: previewRaw, loading: previewLoading } = useQuery(GET_WIDGET_DATA_PREVIEW, {
    variables: previewVars ?? { entityType, metric },
    skip: !previewVars,
    fetchPolicy: 'cache-and-network',
  })

  const previewData = (previewRaw as { widgetDataPreview: PreviewData } | undefined)?.widgetDataPreview ?? null

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

  return {
    title, setTitle,
    widgetType, setWidgetType,
    entityType,
    metric, setMetric,
    groupByField, setGroupByField,
    filterField, setFilterField,
    filterValue, setFilterValue,
    timeRange, setTimeRange,
    size, setSize,
    color, setColor,
    saving,
    isEdit,
    fields,
    needsGroupBy,
    fieldMetaMap,
    selectedFilterMeta,
    previewData,
    previewLoading,
    handleEntityChange,
    handleSave,
  }
}
