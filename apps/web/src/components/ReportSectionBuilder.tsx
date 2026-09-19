import { useState, useCallback, useEffect, useMemo, useRef, useId } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useQuery, useLazyQuery } from '@apollo/client/react'
import {
  ReactFlow, Background, Controls,
  ConnectionMode, MarkerType, reconnectEdge,
  useNodesState, useEdgesState,
  type Node, type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Star, X, Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { GET_NAVIGABLE_ENTITIES, GET_REACHABLE_ENTITIES, PREVIEW_REPORT_SECTION } from '@/graphql/queries'
import {
  nodeTypes, edgeTypes, navigableLabel,
  type FilterState, type NodeData, type NavigableEntity, type ReachableEntity, type NavigableField,
} from './ReportFlowNodes'
import { ReportPreview, type SectionResult } from './ReportPreview'
import { Button } from '@/components/Button'
import { ModaleProgettoReportAI, type ProgettoReport } from './ProgettoReportAI'
import { useAIFeature } from '@/hooks/useAIFeature'
import { ReportQueryBuilder } from './ReportQueryBuilder'
import { ReportChartConfig, CHART_TYPES, DATE_FIELD_NAMES } from './ReportChartConfig'
import { useCIBaseEnums } from '@/lib/ciEnums'
import { colors, palette } from '@/lib/tokens'
import { showError } from '@/lib/showError'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReportSectionInput {
  title:         string
  chartType:     string
  groupByNodeId: string | null
  groupByField:  string | null
  groupByGranularity?: string | null
  metric:        string
  metricField:   string | null
  limit:         number | null
  sortDir:       string | null
  nodes: Array<{
    id: string; entityType: string; neo4jLabel: string; label: string
    isResult: boolean; isRoot: boolean; positionX: number; positionY: number
    filters: string | null; selectedFields: string[]
  }>
  edges: Array<{
    id: string; sourceNodeId: string; targetNodeId: string
    relationshipType: string; direction: string; label: string
  }>
}

interface Props {
  onSave:         (input: ReportSectionInput) => void
  onCancel:       () => void
  initialValues?: ReportSectionInput | null
}

type NodeDataEntry = {
  entityType: string; neo4jLabel: string; label: string
  isResult: boolean; isRoot: boolean
  filters: FilterState[]; selectedFields: string[]
  fields: NavigableField[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WIZARD_STEPS: { n: 1 | 2 | 3 | 4; labelKey: string }[] = [
  { n: 1, labelKey: 'reportBuilder.wizard.what' },
  { n: 2, labelKey: 'reportBuilder.wizard.graph' },
  { n: 3, labelKey: 'reportBuilder.wizard.display' },
  { n: 4, labelKey: 'reportBuilder.wizard.titleAndSave' },
]

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', borderRadius: 6,
  border: `1px solid ${palette.neutral.borderStrong}`, fontSize: 'var(--font-size-body)', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 6, display: 'block',
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * UN FILTRO COME LO VUOLE IL SERVER (19 set 2026).
 *
 * L'interfaccia scrive sempre testo — è quello che una casella produce — ma
 * «ultimi N giorni» è un NUMERO e «è fra» una LISTA, e il Cypher li usa così
 * (`duration({days: $p})`, `IN $p`). Prima il costruttore sapeva scrivere solo
 * `eq`, quindi la differenza non si vedeva; da quando gli operatori si possono
 * scegliere, va tradotta qui — una volta, sul confine.
 *
 * Gli operatori senza valore mandano `null`: un valore lasciato in giro
 * sarebbe un dato che nessuno usa ma che chi rilegge il JSON deve spiegare.
 */
function normalizzaFiltro(f: FilterState): { field: string; operator: string; value: string | number | string[] | null } {
  if (f.operator === 'is_null' || f.operator === 'is_not_null') return { field: f.field, operator: f.operator, value: null }
  if (f.operator === 'last_n_days') {
    const giorni = Number(Array.isArray(f.value) ? f.value[0] : f.value)
    return { field: f.field, operator: f.operator, value: Number.isFinite(giorni) ? giorni : 0 }
  }
  if (f.operator === 'in') {
    const valori = Array.isArray(f.value)
      ? f.value
      : String(f.value).split(',').map((x) => x.trim()).filter((x) => x !== '')
    return { field: f.field, operator: f.operator, value: valori }
  }
  return { field: f.field, operator: f.operator, value: Array.isArray(f.value) ? (f.value[0] ?? '') : String(f.value) }
}

export function ReportSectionBuilder({ onSave, onCancel, initialValues }: Props) {
  const { t, i18n } = useTranslation()
  const titleInputId = useId()
  const [wizardStep,    setWizardStep]    = useState<1 | 2 | 3 | 4>(1)
  const [title,         setTitle]         = useState(initialValues?.title ?? '')
  const [chartType,     setChartType]     = useState(initialValues?.chartType ?? 'bar')
  const [metric,        setMetric]        = useState(initialValues?.metric ?? 'count')
  const [metricField,   setMetricField]   = useState(initialValues?.metricField ?? '')
  const [groupByNodeId, setGroupByNodeId] = useState(initialValues?.groupByNodeId ?? '')
  const [groupByField,  setGroupByField]  = useState(initialValues?.groupByField ?? '')
  const [granularita,   setGranularita]   = useState(initialValues?.groupByGranularity ?? 'day')
  const [limit,         setLimit]         = useState<number>(initialValues?.limit ?? 20)
  const [sortDir,       setSortDir]       = useState(initialValues?.sortDir ?? 'DESC')

  const [nodeDataMap, setNodeDataMap] = useState<Record<string, NodeDataEntry>>({})
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [connectingNodeId, setConnectingNodeId] = useState<string | null>(null)
  /*
   * IL PROGETTISTA AI (19 set 2026): una casella dove descrivere il report a
   * parole, e il disegno entra qui come se fosse stato fatto a mano.
   *
   * `aiAccesa` è `null` finché non si sa: in quel momento il bottone non si
   * mostra e non si mostra nemmeno l'avviso, invece di indovinare.
   */
  const aiAccesa = useAIFeature('reportDesigner')
  const [progettoAI, setProgettoAI] = useState(false)

  const { data: entitiesData } = useQuery<{ navigableEntities: NavigableEntity[] }>(GET_NAVIGABLE_ENTITIES)
  const entities: NavigableEntity[] = useMemo(() => entitiesData?.navigableEntities ?? [], [entitiesData])

  const [fetchReachable, { data: reachableData, loading: reachableLoading }] = useLazyQuery<
    { reachableEntities: ReachableEntity[] }
  >(GET_REACHABLE_ENTITIES, { fetchPolicy: 'network-only' })

  const [runPreview, { loading: previewLoading, data: previewQueryData }] = useLazyQuery<
    { previewReportSection: SectionResult }
  >(PREVIEW_REPORT_SECTION, { fetchPolicy: 'network-only' })
  const previewData = previewQueryData?.previewReportSection ?? null

  // ── Node field helpers ──────────────────────────────────────────────────────

  // Status/environment dei CI dal tipo base del metamodello (F-23)
  const baseEnums = useCIBaseEnums()

  const getNodeFields = useCallback((neo4jLabel: string): NavigableField[] => {
    const entity     = entities.find(e => e.neo4jLabel === neo4jLabel)
    const typeFields = entity?.fields ?? []
    const isCIEntity = entity?.group === 'cmdb'
    if (!isCIEntity) return typeFields
    const baseFields: NavigableField[] = [
      { name: 'name',        label: t('common.name'),        fieldType: 'string', enumValues: [] },
      { name: 'status',      label: t('common.status'),      fieldType: 'enum',   enumValues: baseEnums.statuses },
      { name: 'environment', label: t('reportBuilder.environment'), fieldType: 'enum', enumValues: baseEnums.environments },
      { name: 'description', label: t('common.description'), fieldType: 'string', enumValues: [] },
    ]
    const merged = [...baseFields]
    typeFields.forEach(f => { if (!merged.find(b => b.name === f.name)) merged.push(f) })
    return merged
  }, [entities, baseEnums.statuses, baseEnums.environments, t])

  // ── Node data callbacks ──────────────────────────────────────────────────────

  const deleteNode = useCallback((nodeId: string) => {
    setNodes(nds => nds.filter(n => n.id !== nodeId))
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId))
    // F-12: also drop the entry from nodeDataMap, otherwise the deleted node
    // stays selectable in "Raggruppa per"/columns and the section is saved
    // with a groupByNodeId that no longer exists (server-side error at run).
    setNodeDataMap(prev => {
      if (!(nodeId in prev)) return prev
      const { [nodeId]: _removed, ...rest } = prev
      return rest
    })
    setGroupByNodeId(prev => (prev === nodeId ? '' : prev))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleResult = useCallback((nodeId: string) => {
    setNodeDataMap(prev => ({ ...prev, [nodeId]: { ...prev[nodeId], isResult: !prev[nodeId].isResult } }))
  }, [])

  const addFilter = useCallback((nodeId: string) => {
    setNodeDataMap(prev => ({
      ...prev,
      [nodeId]: { ...prev[nodeId], filters: [...prev[nodeId].filters, { field: '', operator: 'eq', value: '' }] },
    }))
  }, [])

  const removeFilter = useCallback((nodeId: string, i: number) => {
    setNodeDataMap(prev => ({
      ...prev,
      [nodeId]: { ...prev[nodeId], filters: prev[nodeId].filters.filter((_, idx) => idx !== i) },
    }))
  }, [])

  const updateFilter = useCallback((nodeId: string, i: number, key: keyof FilterState, val: string) => {
    setNodeDataMap(prev => {
      const filters = [...prev[nodeId].filters]
      filters[i] = { ...filters[i], [key]: val }
      return { ...prev, [nodeId]: { ...prev[nodeId], filters } }
    })
  }, [])

  // ── Sync nodeDataMap → ReactFlow nodes ──────────────────────────────────────

  // Callback stabili PER NODO (F-26): create una volta per id e riusate, così
  // `data` di un nodo cambia solo quando cambia la sua entry e
  // memo(ReportEntityNode) può saltare il render degli altri.
  type NodeCallbacks = Pick<NodeData, 'onToggleResult' | 'onAddFilter' | 'onRemoveFilter' | 'onFilterChange' | 'onConnect' | 'onDelete'>
  const callbacksRef = useRef(new Map<string, NodeCallbacks>())
  const nodeCallbacks = useCallback((id: string, neo4jLabel: string): NodeCallbacks => {
    const hit = callbacksRef.current.get(id)
    if (hit) return hit
    const cbs: NodeCallbacks = {
      onToggleResult: () => toggleResult(id),
      onAddFilter:    () => addFilter(id),
      onRemoveFilter: (i: number) => removeFilter(id, i),
      onFilterChange: (i: number, k: keyof FilterState, v: string) => updateFilter(id, i, k, v),
      onConnect: () => { setConnectingNodeId(id); fetchReachable({ variables: { fromNeo4jLabel: neo4jLabel } }) },
      onDelete: () => { callbacksRef.current.delete(id); deleteNode(id) },
    }
    callbacksRef.current.set(id, cbs)
    return cbs
  }, [toggleResult, addFilter, removeFilter, updateFilter, fetchReachable, deleteNode])

  const makeNodeData = useCallback((id: string, nd: NodeDataEntry, neo4jLabel: string): NodeData => ({
    ...nd,
    ...nodeCallbacks(id, neo4jLabel),
    // Riferimento all'entry: permette all'effetto di sync di saltare i nodi invariati
    entry: nd,
  }), [nodeCallbacks])

  useEffect(() => {
    setNodes(nds => nds.map(n => {
      const nd = nodeDataMap[n.id]
      if (!nd) return n
      if ((n.data as NodeData).entry === nd) return n   // entry invariata → stesso oggetto data
      return { ...n, data: makeNodeData(n.id, nd, nd.neo4jLabel) }
    }))
  }, [nodeDataMap]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Add node ────────────────────────────────────────────────────────────────

  const addNode = useCallback((
    entityType: string, neo4jLabel: string, label: string,
    fields: NavigableField[],
    isRoot = false,
    position = { x: 300, y: 100 },
  ) => {
    const id = `node_${Date.now()}`
    const nd: NodeDataEntry = { entityType, neo4jLabel, label, isResult: isRoot, isRoot, filters: [], selectedFields: [], fields }
    setNodeDataMap(prev => ({ ...prev, [id]: nd }))
    setNodes(prev => [...prev, {
      id, type: 'reportEntity', dragHandle: '.node-drag-handle', position,
      data: makeNodeData(id, nd, neo4jLabel),
    }])
    return id
  }, [makeNodeData]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Select root entity (Step 1) ─────────────────────────────────────────────

  const onSelectRoot = useCallback((entity: NavigableEntity) => {
    setNodes([])
    setEdges([])
    setNodeDataMap({})
    setTimeout(() => {
      // C-18: l'etichetta mostrata è quella tradotta quando è del prodotto.
      addNode(entity.entityType, entity.neo4jLabel, navigableLabel(t, entity), getNodeFields(entity.neo4jLabel), true, { x: 300, y: 80 })
    }, 0)
  }, [addNode, getNodeFields]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * METTE UNA SEZIONE NEL WIZARD — riaperta a mano, o PROPOSTA DALL'AI.
   *
   * Una funzione sola per due strade (19 set 2026): la proposta dell'AI ha la
   * stessa forma di una sezione salvata, e farla atterrare per una strada sua
   * vorrebbe dire due ricostruzioni da tenere d'accordo — e la seconda che si
   * dimentica un pezzo (i filtri, il nodo risultato) senza che nessuno se ne
   * accorga.
   *
   * Non salva niente: riempie il costruttore. `passo` dice dove portare chi
   * guarda — al grafo quando riapre, alla visualizzazione quando arriva una
   * proposta (lì c'è l'anteprima, che è il modo di verificarla).
   */
  const applicaSezione = useCallback((v: ReportSectionInput, passo: 2 | 3) => {
    // Se i filtri salvati di un nodo non sono JSON valido NON ricostruiamo il
    // grafo senza filtri (un salvataggio li perderebbe in silenzio): blocchiamo
    // l'apertura e rendiamo l'errore visibile.
    for (const n of v.nodes) {
      if (!n.filters) continue
      try {
        JSON.parse(n.filters)
      } catch (e) {
        showError(e, t('toast.report.corruptFilters', { node: n.label, error: e instanceof Error ? e.message : String(e) }))
        return
      }
    }
    const newNodeDataMap: Record<string, NodeDataEntry> = {}
    const newNodes: Node[] = v.nodes.map(n => {
      let filters: FilterState[] = []
      if (n.filters) filters = JSON.parse(n.filters) as FilterState[]
      const nd: NodeDataEntry = {
        entityType: n.entityType, neo4jLabel: n.neo4jLabel, label: n.label,
        isResult: n.isResult, isRoot: n.isRoot,
        filters, selectedFields: n.selectedFields ?? [],
        fields: getNodeFields(n.neo4jLabel),
      }
      newNodeDataMap[n.id] = nd
      return { id: n.id, type: 'reportEntity', dragHandle: '.node-drag-handle', position: { x: n.positionX, y: n.positionY }, data: makeNodeData(n.id, nd, n.neo4jLabel) }
    })
    const newEdges: Edge[] = v.edges.map(e => ({
      id: e.id, type: 'reportEdge',
      source: e.sourceNodeId, target: e.targetNodeId,
      data: { relationshipType: e.relationshipType, direction: e.direction, label: e.label },
    }))
    setTitle(v.title)
    setChartType(v.chartType)
    setMetric(v.metric)
    setMetricField(v.metricField ?? '')
    setGroupByNodeId(v.groupByNodeId ?? '')
    setGroupByField(v.groupByField ?? '')
    setGranularita(v.groupByGranularity ?? 'day')
    setLimit(v.limit ?? 20)
    setSortDir(v.sortDir ?? 'DESC')
    setNodeDataMap(newNodeDataMap)
    setNodes(newNodes)
    setEdges(newEdges)
    setWizardStep(passo)
  }, [getNodeFields, makeNodeData, setNodes, setEdges, t])

  // ── Reconstruct graph from initialValues ────────────────────────────────────

  useEffect(() => {
    if (!initialValues?.nodes?.length || !entities.length || nodes.length > 0) return
    applicaSezione(initialValues, 2)
  }, [entities.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Connect reachable entity ─────────────────────────────────────────────────

  const connectReachable = useCallback((re: ReachableEntity) => {
    if (!connectingNodeId) return
    const sourceNode = nodes.find(n => n.id === connectingNodeId)
    const newPos = { x: (sourceNode?.position.x ?? 300) + (Math.random() * 200 - 100), y: (sourceNode?.position.y ?? 100) + 200 }
    const newNodeId = addNode(re.entityType, re.neo4jLabel, navigableLabel(t, re), getNodeFields(re.neo4jLabel), false, newPos)
    setEdges(prev => [...prev, {
      id: `edge_${Date.now()}`, type: 'reportEdge',
      source: re.direction === 'outgoing' ? connectingNodeId : newNodeId,
      target: re.direction === 'outgoing' ? newNodeId : connectingNodeId,
      data: { relationshipType: re.relationshipType, direction: re.direction, label: `${re.direction === 'outgoing' ? '→' : '←'} ${re.relationshipType}` },
    }])
    setConnectingNodeId(null)
  }, [connectingNodeId, nodes, addNode, getNodeFields]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build output ─────────────────────────────────────────────────────────────

  const buildInput = useCallback((): ReportSectionInput => ({
    title, chartType, metric,
    metricField:   metricField || null,
    groupByNodeId: groupByNodeId || null,
    groupByField:  groupByField || null,
    groupByGranularity: granularita || 'day',
    limit, sortDir,
    nodes: nodes.map(n => {
      const nd = nodeDataMap[n.id]
      return {
        id: n.id, entityType: nd?.entityType ?? '', neo4jLabel: nd?.neo4jLabel ?? '', label: nd?.label ?? '',
        isResult: nd?.isResult ?? false, isRoot: nd?.isRoot ?? false,
        positionX: n.position.x, positionY: n.position.y,
        filters: nd?.filters?.length ? JSON.stringify(nd.filters.map(normalizzaFiltro)) : null,
        selectedFields: nd?.selectedFields ?? [],
      }
    }),
    edges: edges.map(e => {
      // The label lives in e.data (set by connectReachable / the reopen effect),
      // not in the React Flow `label` prop — reading e.label always saved ''.
      const d = e.data as { relationshipType?: string; direction?: string; label?: string } | undefined
      return {
        id: e.id, sourceNodeId: e.source, targetNodeId: e.target,
        relationshipType: d?.relationshipType ?? '',
        direction:        d?.direction ?? 'outgoing',
        label:            d?.label || d?.relationshipType || '',
      }
    }),
  }), [nodes, edges, nodeDataMap, title, chartType, metric, metricField, groupByNodeId, groupByField, granularita, limit, sortDir])

  // ── Derived ──────────────────────────────────────────────────────────────────

  const isTimeSeries = chartType === 'line' || chartType === 'area'

  const hasOrphanNodes = (): boolean => {
    if (nodes.length <= 1) return false
    const rootNode = nodes.find(n => (n.data as NodeData).isRoot)
    if (!rootNode) return false
    const connected = new Set<string>()
    const visit = (id: string) => {
      if (connected.has(id)) return
      connected.add(id)
      edges.filter(e => e.source === id || e.target === id).forEach(e => { visit(e.source); visit(e.target) })
    }
    visit(rootNode.id)
    return nodes.some(n => !connected.has(n.id))
  }
  const orphan = hasOrphanNodes()

  const lastNode        = nodes[nodes.length - 1]
  const lastEntity      = entities.find(e => e.neo4jLabel === (lastNode?.data as NodeData | undefined)?.neo4jLabel)
  const step3DateFields = (lastEntity?.fields ?? []).filter(f => f.fieldType === 'date' || DATE_FIELD_NAMES.includes(f.name))
  const canProceedStep3 = !isTimeSeries || step3DateFields.length > 0

  // ── Auto-preview on step 3 ───────────────────────────────────────────────────

  useEffect(() => {
    if (wizardStep !== 3 || nodes.length === 0) return
    const timer = setTimeout(() => { runPreview({ variables: { input: buildInput(), language: i18n.resolvedLanguage ?? i18n.language } }) }, 500)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
    // `granularita` fra le dipendenze (19 set 2026): senza, si cambiava
    // «Periodo» in «Per mese» e l'anteprima restava quella per giorno —
    // l'unico posto dove si verifica il disegno mostrava un altro disegno.
  }, [wizardStep, chartType, groupByNodeId, groupByField, granularita, metric, metricField, limit, sortDir, nodes.length, edges.length])

  // ── Wizard navigation ────────────────────────────────────────────────────────

  const renderProgressBar = () => (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {WIZARD_STEPS.map((s, i) => (
        <div key={s.n} style={{ display: 'flex', alignItems: 'flex-start', flex: i < WIZARD_STEPS.length - 1 ? 1 : 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              aria-label={t(s.labelKey)}
              aria-current={wizardStep === s.n ? 'step' : undefined}
              disabled={wizardStep <= s.n}
              onClick={() => { if (wizardStep > s.n) setWizardStep(s.n) }}
              style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0, border: 'none', padding: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--font-size-card-title)', fontWeight: 700, fontFamily: 'inherit',
                background: wizardStep > s.n ? colors.success : wizardStep === s.n ? 'var(--color-brand)' : colors.border,
                color:      wizardStep >= s.n ? colors.white : 'var(--color-slate-light)',
                cursor:     wizardStep > s.n ? 'pointer' : 'default',
              }}
            >
              {wizardStep > s.n ? <Check size={16} /> : s.n}
            </button>
            <span style={{
              fontSize: 'var(--font-size-body)', fontWeight: 500, whiteSpace: 'nowrap',
              color: wizardStep === s.n ? 'var(--color-brand)' : wizardStep > s.n ? colors.success : 'var(--color-slate-light)',
            }}>
              {t(s.labelKey)}
            </span>
          </div>
          {i < WIZARD_STEPS.length - 1 && (
            <div style={{ flex: 1, height: 2, margin: '15px 8px 0', background: wizardStep > s.n ? colors.success : colors.border }} />
          )}
        </div>
      ))}
    </div>
  )

  const renderNavButtons = (
    onBack: (() => void) | null,
    onNext: () => void,
    nextDisabled = false,
    nextLabel = t('reportBuilder.next'),
    isLastStep = false,
  ) => (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      {onBack ? (
        <button type="button" onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          <ChevronLeft size={18} /> {t('pages.reportSchedule.back')}
        </button>
      ) : <div />}
      <div style={{ display: 'flex', gap: 10 }}>
        {isLastStep && (
          <button type="button" onClick={onCancel} style={{ padding: '10px 16px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
            {t('common.cancel')}
          </button>
        )}
        <button type="button" onClick={onNext} disabled={nextDisabled} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 24px',
          borderRadius: 8, border: 'none',
          background: nextDisabled ? palette.info.border : 'var(--color-brand)',
          color: colors.white, cursor: nextDisabled ? 'not-allowed' : 'pointer',
          fontSize: 'var(--font-size-card-title)', fontWeight: 600,
        }}>
          {isLastStep ? <Check size={16} /> : null}
          {nextLabel}
          {!isLastStep && <ChevronRight size={18} />}
        </button>
      </div>
    </div>
  )

  // ── Step 2 — Grafo e filtri ──────────────────────────────────────────────────

  const renderStep2 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '0 32px 12px' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>{t('reportBuilder.graphAndFilters')}</h3>
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('reportBuilder.graphHint')}</p>
      </div>

      <div style={{ flex: 1, border: '0', overflow: 'hidden', position: 'relative' }}>
        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={() => {}} connectOnClick={false} nodesConnectable={false} deleteKeyCode={null}
          nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose} reconnectRadius={10}
          nodesDraggable={true} defaultViewport={{ x: 100, y: 80, zoom: 1 }}
          zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} preventScrolling={false}
          edgesReconnectable={true}
          onReconnect={(oldEdge, newConnection) => setEdges(eds => reconnectEdge(oldEdge, newConnection, eds))}
          defaultEdgeOptions={{
            type: 'reportEdge', animated: false,
            style: { stroke: palette.purple.border, strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: palette.purple.border },
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>

        {connectingNodeId && (
          <div style={{ position: 'absolute', top: 0, right: 0, width: 260, height: '100%', background: colors.white, borderLeft: `1px solid ${colors.border}`, overflowY: 'auto', padding: 16, zIndex: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)' }}>{t('reportBuilder.connectTo')}</span>
              <button type="button" onClick={() => setConnectingNodeId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)' }}>
                <X size={16} />
              </button>
            </div>
            {reachableLoading ? (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', textAlign: 'center' }}>{t('common.loading')}</p>
            ) : (reachableData?.reachableEntities ?? []).length === 0 ? (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', textAlign: 'center' }}>{t('reportBuilder.noConnection')}</p>
            ) : (
              (reachableData?.reachableEntities ?? []).map((re, i) => (
                <button key={`${re.neo4jLabel}:${re.relationshipType}:${re.direction}:${i}`}
                  type="button"
                  onClick={() => connectReachable(re)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: `1px solid ${palette.teal.bg}`, borderRadius: 8, cursor: 'pointer', background: palette.neutral.surface1, marginBottom: 6, width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-brand-light)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = palette.neutral.surface1 }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{navigableLabel(t, re)}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{re.direction === 'outgoing' ? '→' : '←'} {re.relationshipType}</div>
                  </div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: palette.purple.light }}>{re.count}</div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {orphan ? (
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)', padding: '8px 32px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('reportBuilder.disconnectedNodes')}
        </div>
      ) : (
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', padding: '6px 32px 0', flexShrink: 0 }}>
          <Trans
            i18nKey="reportBuilder.hint"
            components={{ b: <strong />, star: <Star size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> }}
          />
        </p>
      )}
    </div>
  )

  // ── Step 4 — Titolo e salva ──────────────────────────────────────────────────

  const renderStep4 = () => {
    const chartDef     = CHART_TYPES.find(c => c.value === chartType)
    const rootEntry    = Object.values(nodeDataMap).find(nd => nd.isRoot)
    const suggestedTitle = rootEntry ? `${rootEntry.label} - ${chartDef ? t(chartDef.labelKey) : chartType}` : ''
    const isKpi        = chartType === 'kpi'
    const isTable      = chartType === 'table'
    const isTS         = chartType === 'line' || chartType === 'area'
    const needsLimit   = !isKpi && !isTable && !isTS

    return (
      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>{t('reportBuilder.nameTheSection')}</h3>
        <p style={{ margin: '0 0 24px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{t('reportBuilder.nameHint')}</p>

        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ flex: '0 0 300px' }}>
            <div style={{ marginBottom: 20 }}>
              <label htmlFor={titleInputId} style={labelStyle}>{t('reportBuilder.sectionTitle')}</label>
              <input id={titleInputId} value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} placeholder={t('reportBuilder.titlePlaceholder')} />
              {suggestedTitle && title !== suggestedTitle && (
                <button type="button" onClick={() => setTitle(suggestedTitle)} style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand)', fontSize: 'var(--font-size-body)', padding: 0 }}>
                  {t('reportBuilder.useSuggested', { title: suggestedTitle })}
                </button>
              )}
            </div>

            <div style={{ background: 'var(--color-slate-bg)', border: `1px solid ${colors.border}`, borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>{t('reportBuilder.summary')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {rootEntry && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', flexShrink: 0 }}>{t('reportBuilder.analysis')}</span>
                    <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textAlign: 'right' }}>{rootEntry.label}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', flexShrink: 0 }}>{t('reportBuilder.nodes')}</span>
                  <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textAlign: 'right' }}>{nodes.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', flexShrink: 0 }}>{t('reportBuilder.chart')}</span>
                  <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textAlign: 'right' }}>{chartDef ? t(chartDef.labelKey) : chartType}</span>
                </div>
                {needsLimit && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', flexShrink: 0 }}>Top</span>
                    <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textAlign: 'right' }}>{limit}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={labelStyle}>{t('reportBuilder.finalPreview')}</div>
            <ReportPreview loading={previewLoading} data={previewData} title={title || undefined} placeholder={t('reportBuilder.noPreview')} granularita={granularita} />
          </div>
        </div>
      </div>
    )
  }

  // ── Nav config ────────────────────────────────────────────────────────────────

  const navConfig = (() => {
    switch (wizardStep) {
      case 1: return { onBack: null, onNext: () => setWizardStep(2), nextDisabled: nodes.length === 0 }
      case 2: return { onBack: () => setWizardStep(1), onNext: () => setWizardStep(3), nextDisabled: orphan }
      case 3: return {
        onBack: () => setWizardStep(2),
        onNext: () => {
          if (!title) {
            const rootEntry = Object.values(nodeDataMap).find(nd => nd.isRoot)
            if (rootEntry) {
              const def = CHART_TYPES.find(c => c.value === chartType)
              setTitle(`${rootEntry.label} - ${def ? t(def.labelKey) : chartType}`)
            }
          }
          setWizardStep(4)
        },
        nextDisabled: !canProceedStep3,
      }
      case 4: return { onBack: () => setWizardStep(3), onNext: () => onSave(buildInput()), nextDisabled: !title, nextLabel: t('reportBuilder.saveSection'), isLastStep: true }
    }
  })()

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '16px 32px', borderBottom: `1px solid ${palette.neutral.borderLight}` }}>
        {renderProgressBar()}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {wizardStep === 2 ? renderStep2() : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
            {wizardStep === 1 && aiAccesa === true && (
              /* Sopra la scelta a mano, non invece: chi sa già cosa vuole
                 clicca l'entità e va avanti come prima. */
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                border: `1px solid ${colors.border}`, borderRadius: 8, padding: '12px 14px', marginBottom: 20,
              }}>
                <div style={{ flex: '1 1 260px' }}>
                  <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                    {t('reportAI.title')}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
                    {t('reportAI.subtitle')}
                  </div>
                </div>
                <Button onClick={() => { setProgettoAI(true) }}>
                  <Sparkles size={14} style={{ marginRight: 6 }} />
                  {t('reportAI.button')}
                </Button>
              </div>
            )}
            {wizardStep === 1 && (
              <ReportQueryBuilder
                entities={entities}
                nodes={nodes}
                nodeDataMap={nodeDataMap}
                onSelectRoot={onSelectRoot}
              />
            )}
            {wizardStep === 3 && (
              <ReportChartConfig
                chartType={chartType}          onChartTypeChange={setChartType}
                metric={metric}                onMetricChange={setMetric}
                metricField={metricField}       onMetricFieldChange={setMetricField}
                groupByNodeId={groupByNodeId}   onGroupByNodeIdChange={setGroupByNodeId}
                groupByField={groupByField}     onGroupByFieldChange={setGroupByField}
                groupByGranularity={granularita} onGroupByGranularityChange={setGranularita}
                limit={limit}                   onLimitChange={setLimit}
                sortDir={sortDir}               onSortDirChange={setSortDir}
                nodeDataMap={nodeDataMap}
                onSelectedFieldsChange={(nid, fields) =>
                  setNodeDataMap(prev => ({ ...prev, [nid]: { ...prev[nid], selectedFields: fields } }))
                }
                step3DateFields={step3DateFields}
                previewLoading={previewLoading}
                previewData={previewData}
              />
            )}
            {wizardStep === 4 && renderStep4()}
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0, padding: '12px 32px', borderTop: `1px solid ${colors.border}`, background: colors.white }}>
        {navConfig && renderNavButtons(navConfig.onBack, navConfig.onNext, navConfig.nextDisabled, (navConfig as { nextLabel?: string }).nextLabel, (navConfig as { isLastStep?: boolean }).isLastStep)}
      </div>

      {progettoAI && (
        <ModaleProgettoReportAI
          onChiudi={() => { setProgettoAI(false) }}
          onApplica={(p: ProgettoReport) => {
            /*
             * Il progetto entra dalla STESSA porta di una sezione riaperta a
             * mano (`applicaSezione`), e si va al passo della visualizzazione:
             * lì c'è l'anteprima sui dati veri, che è il modo di verificarlo.
             */
            applicaSezione({
              title: p.title, chartType: p.chartType, metric: p.metric, metricField: p.metricField,
              groupByNodeId: p.groupByNodeId, groupByField: p.groupByField,
              groupByGranularity: p.groupByGranularity,
              limit: p.limit, sortDir: p.sortDir,
              nodes: p.nodes.map((n) => ({
                id: n.id, entityType: n.entityType, neo4jLabel: n.neo4jLabel, label: n.label,
                isResult: n.isResult, isRoot: n.isRoot, positionX: n.positionX, positionY: n.positionY,
                filters: n.filters, selectedFields: n.selectedFields,
              })),
              edges: p.edges.map((e) => ({
                id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
                relationshipType: e.relationshipType, direction: e.direction, label: e.label,
              })),
            }, 3)
          }}
        />
      )}
    </div>

  )
}
