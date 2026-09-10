import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { isITILEntity } from '@/lib/automationOperators'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { CREATE_CUSTOM_WIDGET, UPDATE_CUSTOM_WIDGET } from '@/graphql/mutations'
import { GET_WIDGET_DATA_PREVIEW, GET_ITIL_TYPES, GET_CI_TYPES } from '@/graphql/queries'
import type { CustomWidgetData } from './CustomWidgetCard'
import { cssVar } from '@/lib/charts/cssVar'

// ── Constants ────────────────────────────────────────────────────────────────
// Le etichette visibili sono chiavi i18n (`labelKey`, `descKey`, `subKey`,
// `nameKey`): i componenti le traducono nel render con `t(x.labelKey)`.

export const WIDGET_TYPES = [
  { value: 'counter',     labelKey: 'pages.dashboard.widgetType.counter',    icon: 'Hash',       descKey: 'pages.dashboard.widgetTypeDesc.counter' },
  { value: 'chart_bar',   labelKey: 'pages.dashboard.widgetType.chartBar',   icon: 'BarChart2',  descKey: 'pages.dashboard.widgetTypeDesc.chartBar' },
  { value: 'chart_line',  labelKey: 'pages.dashboard.widgetType.chartLine',  icon: 'TrendingUp', descKey: 'pages.dashboard.widgetTypeDesc.chartLine' },
  { value: 'chart_pie',   labelKey: 'pages.dashboard.widgetType.chartPie',   icon: 'PieChart',   descKey: 'pages.dashboard.widgetTypeDesc.chartPie' },
  { value: 'chart_donut', labelKey: 'pages.dashboard.widgetType.chartDonut', icon: 'PieChart',   descKey: 'pages.dashboard.widgetTypeDesc.chartDonut' },
  { value: 'table',       labelKey: 'pages.dashboard.widgetType.table',      icon: 'Table',      descKey: 'pages.dashboard.widgetTypeDesc.table' },
  { value: 'gauge',       labelKey: 'pages.dashboard.widgetType.gauge',      icon: 'Gauge',      descKey: 'pages.dashboard.widgetTypeDesc.gauge' },
  // Event Management: contatori di eventStats, nessuna entità/metrica da configurare
  // (entityType/metric vengono salvati con i valori correnti del form ma il widget non li usa).
  { value: 'active_alarms', labelKey: 'pages.dashboard.widgetType.activeAlarms', icon: 'Radar',  descKey: 'pages.dashboard.widgetTypeDesc.activeAlarms' },
] as const

/** Tipi di widget che NON leggono `widgetData` (la sorgente dei dati è fissa): niente anteprima né configurazione dati. */
export const DATA_FREE_WIDGET_TYPES: readonly string[] = ['active_alarms']

export const ENTITY_TYPES = [
  { value: 'incident',             labelKey: 'pages.dashboard.entity.incident' },
  { value: 'problem',              labelKey: 'pages.dashboard.entity.problem' },
  { value: 'change',               labelKey: 'pages.dashboard.entity.change' },
  { value: 'service_request',      labelKey: 'pages.dashboard.entity.serviceRequest' },
  { value: 'server',               labelKey: 'pages.dashboard.entity.server' },
  { value: 'application',          labelKey: 'pages.dashboard.entity.application' },
  { value: 'database',             labelKey: 'pages.dashboard.entity.database' },
  { value: 'certificate',          labelKey: 'pages.dashboard.entity.certificate' },
  { value: 'network_device',       labelKey: 'pages.dashboard.entity.networkDevice' },
  { value: 'vm',                   labelKey: 'pages.dashboard.entity.vm' },
  { value: 'business_application', labelKey: 'pages.dashboard.entity.businessApplication' },
]

export const METRICS = [
  { value: 'count',          labelKey: 'pages.dashboard.metric.count' },
  { value: 'count_by_field', labelKey: 'pages.dashboard.metric.countByField' },
  { value: 'avg_field',      labelKey: 'pages.dashboard.metric.avgField' },
  { value: 'sum_field',      labelKey: 'pages.dashboard.metric.sumField' },
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
  business_application: ['status', 'environment', 'criticality', 'businessUnit'],
}

export const TIME_RANGES = [
  { value: '24h', labelKey: 'pages.dashboard.timeRange.24h' },
  { value: '7d',  labelKey: 'pages.dashboard.timeRange.7d' },
  { value: '30d', labelKey: 'pages.dashboard.timeRange.30d' },
  { value: '90d', labelKey: 'pages.dashboard.timeRange.90d' },
  { value: '1y',  labelKey: 'pages.dashboard.timeRange.1y' },
  { value: 'all', labelKey: 'pages.dashboard.timeRange.all' },
]

/**
 * Colori proposti per un widget. Il colore del widget è un DATO scelto
 * dall'utente (salvato sul widget, mostrato in <input type="color">, usato
 * con suffisso alfa): deve essere un esadecimale concreto, non `var(--…)`.
 * I preset partono comunque dai token: `cssVar` legge il valore risolto da
 * :root, così un cambio di tavolozza cambia anche i preset (non i widget già
 * salvati, che restano col colore scelto allora).
 */
export function presetColors(): { value: string; nameKey: string }[] {
  return [
    { value: cssVar('--color-brand'),        nameKey: 'pages.dashboard.color.cyan' },
    { value: cssVar('--color-success'),      nameKey: 'pages.dashboard.color.green' },
    { value: cssVar('--color-danger'),       nameKey: 'pages.dashboard.color.red' },
    { value: cssVar('--color-warning'),      nameKey: 'pages.dashboard.color.amber' },
    { value: cssVar('--color-purple-light'), nameKey: 'pages.dashboard.color.purple' },
    { value: cssVar('--color-slate'),        nameKey: 'pages.dashboard.color.slate' },
  ]
}

/**
 * Tinta leggera del colore del widget (sfondo di chip e riquadri selezionati).
 * Con un esadecimale a 6 cifre usa il suffisso alfa (`#rrggbb14` ≈ 8%); con
 * qualsiasi altra forma (token, rgb) usa color-mix, così non si producono mai
 * colori CSS non validi.
 */
export function widgetTint(color: string, alphaHex: '14' | '33' = '14'): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return `${color}${alphaHex}`
  const pct = alphaHex === '33' ? 20 : 8
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

export const SIZE_OPTIONS = [
  { value: 'small',  labelKey: 'pages.dashboard.size.small',  subKey: 'pages.dashboard.sizeSub.small' },
  { value: 'medium', labelKey: 'pages.dashboard.size.medium', subKey: 'pages.dashboard.sizeSub.medium' },
  { value: 'large',  labelKey: 'pages.dashboard.size.large',  subKey: 'pages.dashboard.sizeSub.large' },
]

export const FIELD_TYPE_LABEL_KEYS: Record<string, string> = {
  string:  'pages.dashboard.fieldType.string',
  number:  'pages.dashboard.fieldType.number',
  date:    'pages.dashboard.fieldType.date',
  boolean: 'pages.dashboard.fieldType.boolean',
  enum:    'pages.dashboard.fieldType.enum',
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
  const { t } = useTranslation()
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
  const [color,        setColor]        = useState(widget?.color         ?? presetColors()[0]!.value)
  const [saving,       setSaving]       = useState(false)

  // Debounced preview vars
  const [previewVars, setPreviewVars] = useState<{
    entityType: string; metric: string; groupByField?: string; filterField?: string; filterValue?: string; timeRange?: string
  } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fields      = ALLOWED_FIELDS[entityType] ?? []
  const needsGroupBy = metric === 'count_by_field' || metric === 'avg_field' || metric === 'sum_field'

  // ── Load field metadata from type definitions ──────────────────────────────
  const isITIL = isITILEntity(entityType)
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

  const dataFree = DATA_FREE_WIDGET_TYPES.includes(widgetType)
  const { data: previewRaw, loading: previewLoading } = useQuery(GET_WIDGET_DATA_PREVIEW, {
    variables: previewVars ?? { entityType, metric },
    skip: !previewVars || dataFree,
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
    if (!title.trim()) { toast.error(t('toast.widget.titleRequired')); return }
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
        toast.success(t('toast.widget.updated'))
      } else {
        const res = await createWidget({ variables: { input: { ...input, dashboardId } } })
        saved = (res.data as { createCustomWidget: CustomWidgetData }).createCustomWidget
        toast.success(t('toast.widget.created'))
      }
      onSaved(saved)
    } catch (err: unknown) {
      toast.error(t('toast.widget.saveFailed', { error: errorMessage(err) }))
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
