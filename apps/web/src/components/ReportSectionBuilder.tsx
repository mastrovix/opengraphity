import { useState, useCallback, useEffect } from 'react'
import { useQuery, useLazyQuery } from '@apollo/client/react'
import {
  ReactFlow, Background, Controls,
  ConnectionMode, MarkerType, reconnectEdge,
  useNodesState, useEdgesState,
  type Node, type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Star, X, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { GET_NAVIGABLE_ENTITIES, GET_REACHABLE_ENTITIES, PREVIEW_REPORT_SECTION } from '@/graphql/queries'
import {
  nodeTypes, edgeTypes,
  type FilterState, type NodeData, type NavigableEntity, type ReachableEntity, type NavigableField,
} from './ReportFlowNodes'
import { ReportPreview, type SectionResult } from './ReportPreview'
import { ReportQueryBuilder } from './ReportQueryBuilder'
import { ReportChartConfig, CHART_TYPES, DATE_FIELD_NAMES } from './ReportChartConfig'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReportSectionInput {
  title:         string
  chartType:     string
  groupByNodeId: string | null
  groupByField:  string | null
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

const WIZARD_STEPS: { n: 1 | 2 | 3 | 4; label: string }[] = [
  { n: 1, label: 'Cosa analizzare' },
  { n: 2, label: 'Grafo e filtri' },
  { n: 3, label: 'Come mostrarlo' },
  { n: 4, label: 'Titolo e salva' },
]

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', borderRadius: 6,
  border: '1px solid #d1d5db', fontSize: 'var(--font-size-body)', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 6, display: 'block',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ReportSectionBuilder({ onSave, onCancel, initialValues }: Props) {
  const [wizardStep,    setWizardStep]    = useState<1 | 2 | 3 | 4>(1)
  const [title,         setTitle]         = useState(initialValues?.title ?? '')
  const [chartType,     setChartType]     = useState(initialValues?.chartType ?? 'bar')
  const [metric,        setMetric]        = useState(initialValues?.metric ?? 'count')
  const [metricField,   setMetricField]   = useState(initialValues?.metricField ?? '')
  const [groupByNodeId, setGroupByNodeId] = useState(initialValues?.groupByNodeId ?? '')
  const [groupByField,  setGroupByField]  = useState(initialValues?.groupByField ?? '')
  const [limit,         setLimit]         = useState<number>(initialValues?.limit ?? 20)
  const [sortDir,       setSortDir]       = useState(initialValues?.sortDir ?? 'DESC')

  const [nodeDataMap, setNodeDataMap] = useState<Record<string, NodeDataEntry>>({})
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [connectingNodeId, setConnectingNodeId] = useState<string | null>(null)

  const { data: entitiesData } = useQuery<{ navigableEntities: NavigableEntity[] }>(GET_NAVIGABLE_ENTITIES)
  const entities: NavigableEntity[] = entitiesData?.navigableEntities ?? []

  const [fetchReachable, { data: reachableData, loading: reachableLoading }] = useLazyQuery<
    { reachableEntities: ReachableEntity[] }
  >(GET_REACHABLE_ENTITIES, { fetchPolicy: 'network-only' })

  const [runPreview, { loading: previewLoading, data: previewQueryData }] = useLazyQuery<
    { previewReportSection: SectionResult }
  >(PREVIEW_REPORT_SECTION, { fetchPolicy: 'network-only' })
  const previewData = previewQueryData?.previewReportSection ?? null

  // ── Node field helpers ──────────────────────────────────────────────────────

  const getNodeFields = useCallback((neo4jLabel: string): NavigableField[] => {
    const entity     = entities.find(e => e.neo4jLabel === neo4jLabel)
    const typeFields = entity?.fields ?? []
    const isCIEntity = !['Incident', 'Change', 'Team', 'User'].includes(entity?.entityType ?? '')
    if (!isCIEntity) return typeFields
    const baseFields: NavigableField[] = [
      { name: 'name',        label: 'Nome',        fieldType: 'string', enumValues: [] },
      { name: 'status',      label: 'Stato',       fieldType: 'enum',   enumValues: ['active', 'inactive', 'maintenance'] },
      { name: 'environment', label: 'Ambiente',    fieldType: 'enum',   enumValues: ['production', 'staging', 'development'] },
      { name: 'description', label: 'Descrizione', fieldType: 'string', enumValues: [] },
    ]
    const merged = [...baseFields]
    typeFields.forEach(f => { if (!merged.find(b => b.name === f.name)) merged.push(f) })
    return merged
  }, [entities])

  // ── Node data callbacks ──────────────────────────────────────────────────────

  const deleteNode = useCallback((nodeId: string) => {
    setNodes(nds => nds.filter(n => n.id !== nodeId))
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId))
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

  const makeNodeData = useCallback((id: string, nd: NodeDataEntry, neo4jLabel: string): NodeData => ({
    ...nd,
    onToggleResult: () => toggleResult(id),
    onAddFilter:    () => addFilter(id),
    onRemoveFilter: (i: number) => removeFilter(id, i),
    onFilterChange: (i: number, k: keyof FilterState, v: string) => updateFilter(id, i, k, v),
    onConnect: () => { setConnectingNodeId(id); fetchReachable({ variables: { fromNeo4jLabel: neo4jLabel } }) },
    onDelete: () => deleteNode(id),
  }), [toggleResult, addFilter, removeFilter, updateFilter, fetchReachable, deleteNode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setNodes(nds => nds.map(n => {
      const nd = nodeDataMap[n.id]
      if (!nd) return n
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
      addNode(entity.entityType, entity.neo4jLabel, entity.label, getNodeFields(entity.neo4jLabel), true, { x: 300, y: 80 })
    }, 0)
  }, [addNode, getNodeFields]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reconstruct graph from initialValues ────────────────────────────────────

  useEffect(() => {
    if (!initialValues?.nodes?.length || !entities.length || nodes.length > 0) return
    const newNodeDataMap: Record<string, NodeDataEntry> = {}
    const newNodes: Node[] = initialValues.nodes.map(n => {
      let filters: FilterState[] = []
      try { if (n.filters) filters = JSON.parse(n.filters) } catch { /* ignore */ }
      const nd: NodeDataEntry = {
        entityType: n.entityType, neo4jLabel: n.neo4jLabel, label: n.label,
        isResult: n.isResult, isRoot: n.isRoot,
        filters, selectedFields: n.selectedFields ?? [],
        fields: getNodeFields(n.neo4jLabel),
      }
      newNodeDataMap[n.id] = nd
      return { id: n.id, type: 'reportEntity', dragHandle: '.node-drag-handle', position: { x: n.positionX, y: n.positionY }, data: makeNodeData(n.id, nd, n.neo4jLabel) }
    })
    const newEdges: Edge[] = initialValues.edges.map(e => ({
      id: e.id, type: 'reportEdge',
      source: e.sourceNodeId, target: e.targetNodeId,
      data: { relationshipType: e.relationshipType, direction: e.direction, label: e.label },
    }))
    setNodeDataMap(newNodeDataMap)
    setNodes(newNodes)
    setEdges(newEdges)
    setWizardStep(2)
  }, [entities.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Connect reachable entity ─────────────────────────────────────────────────

  const connectReachable = useCallback((re: ReachableEntity) => {
    if (!connectingNodeId) return
    const sourceNode = nodes.find(n => n.id === connectingNodeId)
    const newPos = { x: (sourceNode?.position.x ?? 300) + (Math.random() * 200 - 100), y: (sourceNode?.position.y ?? 100) + 200 }
    const newNodeId = addNode(re.entityType, re.neo4jLabel, re.label, getNodeFields(re.neo4jLabel), false, newPos)
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
    limit, sortDir,
    nodes: nodes.map(n => {
      const nd = nodeDataMap[n.id]
      return {
        id: n.id, entityType: nd?.entityType ?? '', neo4jLabel: nd?.neo4jLabel ?? '', label: nd?.label ?? '',
        isResult: nd?.isResult ?? false, isRoot: nd?.isRoot ?? false,
        positionX: n.position.x, positionY: n.position.y,
        filters: nd?.filters?.length ? JSON.stringify(nd.filters.map(f => ({ field: f.field, operator: f.operator, value: f.value }))) : null,
        selectedFields: nd?.selectedFields ?? [],
      }
    }),
    edges: edges.map(e => ({
      id: e.id, sourceNodeId: e.source, targetNodeId: e.target,
      relationshipType: (e.data as { relationshipType: string } | undefined)?.relationshipType ?? '',
      direction:        (e.data as { direction: string } | undefined)?.direction ?? 'outgoing',
      label:            (e.label as string) ?? '',
    })),
  }), [nodes, edges, nodeDataMap, title, chartType, metric, metricField, groupByNodeId, groupByField, limit, sortDir])

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
    const timer = setTimeout(() => { runPreview({ variables: { input: buildInput() } }) }, 500)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardStep, chartType, groupByNodeId, groupByField, metric, metricField, limit, sortDir, nodes.length, edges.length])

  // ── Wizard navigation ────────────────────────────────────────────────────────

  const renderProgressBar = () => (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {WIZARD_STEPS.map((s, i) => (
        <div key={s.n} style={{ display: 'flex', alignItems: 'flex-start', flex: i < WIZARD_STEPS.length - 1 ? 1 : 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div
              onClick={() => { if (wizardStep > s.n) setWizardStep(s.n) }}
              style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'var(--font-size-card-title)', fontWeight: 700,
                background: wizardStep > s.n ? '#10b981' : wizardStep === s.n ? 'var(--color-brand)' : '#e5e7eb',
                color:      wizardStep >= s.n ? '#fff' : 'var(--color-slate-light)',
                cursor:     wizardStep > s.n ? 'pointer' : 'default',
              }}
            >
              {wizardStep > s.n ? <Check size={16} /> : s.n}
            </div>
            <span style={{
              fontSize: 'var(--font-size-body)', fontWeight: 500, whiteSpace: 'nowrap',
              color: wizardStep === s.n ? 'var(--color-brand)' : wizardStep > s.n ? '#10b981' : 'var(--color-slate-light)',
            }}>
              {s.label}
            </span>
          </div>
          {i < WIZARD_STEPS.length - 1 && (
            <div style={{ flex: 1, height: 2, margin: '15px 8px 0', background: wizardStep > s.n ? '#10b981' : '#e5e7eb' }} />
          )}
        </div>
      ))}
    </div>
  )

  const renderNavButtons = (
    onBack: (() => void) | null,
    onNext: () => void,
    nextDisabled = false,
    nextLabel = 'Avanti',
    isLastStep = false,
  ) => (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      {onBack ? (
        <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
          <ChevronLeft size={18} /> Indietro
        </button>
      ) : <div />}
      <div style={{ display: 'flex', gap: 10 }}>
        {isLastStep && (
          <button onClick={onCancel} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
            Annulla
          </button>
        )}
        <button onClick={onNext} disabled={nextDisabled} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 24px',
          borderRadius: 8, border: 'none',
          background: nextDisabled ? '#c7d2fe' : 'var(--color-brand)',
          color: '#fff', cursor: nextDisabled ? 'not-allowed' : 'pointer',
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
        <h3 style={{ margin: '0 0 4px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>Grafo e filtri</h3>
        <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Visualizza e configura le entità collegate.</p>
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
            style: { stroke: '#c4b5fd', strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#c4b5fd' },
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>

        {connectingNodeId && (
          <div style={{ position: 'absolute', top: 0, right: 0, width: 260, height: '100%', background: '#fff', borderLeft: '1px solid #e5e7eb', overflowY: 'auto', padding: 16, zIndex: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)' }}>Connetti a...</span>
              <button onClick={() => setConnectingNodeId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)' }}>
                <X size={16} />
              </button>
            </div>
            {reachableLoading ? (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', textAlign: 'center' }}>Caricamento...</p>
            ) : (reachableData?.reachableEntities ?? []).length === 0 ? (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', textAlign: 'center' }}>Nessuna connessione trovata</p>
            ) : (
              (reachableData?.reachableEntities ?? []).map((re, i) => (
                <div key={`${re.neo4jLabel}:${re.relationshipType}:${re.direction}:${i}`}
                  onClick={() => connectReachable(re)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid #cffafe', borderRadius: 8, cursor: 'pointer', background: '#fafafe', marginBottom: 6 }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-brand-light)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#fafafe' }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{re.label}</div>
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{re.direction === 'outgoing' ? '→' : '←'} {re.relationshipType}</div>
                  </div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: '#c4b5fd' }}>{re.count}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {orphan ? (
        <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-trigger-sla-breach)', padding: '8px 32px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          ⚠ Ci sono nodi non collegati. Collega o elimina i nodi isolati prima di continuare.
        </div>
      ) : (
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', padding: '6px 32px 0', flexShrink: 0 }}>
          Clicca <strong>+ Connetti a...</strong> su un nodo per aggiungere entità collegate.
          Usa <Star size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> per marcare le entità da includere nel risultato.
        </p>
      )}
    </div>
  )

  // ── Step 4 — Titolo e salva ──────────────────────────────────────────────────

  const renderStep4 = () => {
    const chartDef     = CHART_TYPES.find(c => c.value === chartType)
    const rootEntry    = Object.values(nodeDataMap).find(nd => nd.isRoot)
    const suggestedTitle = rootEntry ? `${rootEntry.label} - ${chartDef?.label ?? chartType}` : ''
    const isKpi        = chartType === 'kpi'
    const isTable      = chartType === 'table'
    const isTS         = chartType === 'line' || chartType === 'area'
    const needsLimit   = !isKpi && !isTable && !isTS

    return (
      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>Dai un nome alla sezione</h3>
        <p style={{ margin: '0 0 24px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>Scegli un titolo descrittivo per questa sezione del report.</p>

        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ flex: '0 0 300px' }}>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Titolo sezione</label>
              <input value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} placeholder="Titolo..." />
              {suggestedTitle && title !== suggestedTitle && (
                <button onClick={() => setTitle(suggestedTitle)} style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand)', fontSize: 'var(--font-size-body)', padding: 0 }}>
                  Usa: "{suggestedTitle}"
                </button>
              )}
            </div>

            <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Riepilogo</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {rootEntry && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', flexShrink: 0 }}>Analisi</span>
                    <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textAlign: 'right' }}>{rootEntry.label}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', flexShrink: 0 }}>Nodi</span>
                  <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textAlign: 'right' }}>{nodes.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', flexShrink: 0 }}>Visualizzazione</span>
                  <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textAlign: 'right' }}>{chartDef?.label ?? chartType}</span>
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
            <label style={labelStyle}>Anteprima finale</label>
            <ReportPreview loading={previewLoading} data={previewData} title={title || undefined} placeholder="Nessuna anteprima disponibile" />
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
            if (rootEntry) setTitle(`${rootEntry.label} - ${CHART_TYPES.find(c => c.value === chartType)?.label ?? chartType}`)
          }
          setWizardStep(4)
        },
        nextDisabled: !canProceedStep3,
      }
      case 4: return { onBack: () => setWizardStep(3), onNext: () => onSave(buildInput()), nextDisabled: !title, nextLabel: 'Salva sezione', isLastStep: true }
    }
  })()

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, padding: '16px 32px', borderBottom: '1px solid #f3f4f6' }}>
        {renderProgressBar()}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {wizardStep === 2 ? renderStep2() : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
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

      <div style={{ flexShrink: 0, padding: '12px 32px', borderTop: '1px solid #e5e7eb', background: '#fff' }}>
        {navConfig && renderNavButtons(navConfig.onBack, navConfig.onNext, navConfig.nextDisabled, (navConfig as { nextLabel?: string }).nextLabel, (navConfig as { isLastStep?: boolean }).isLastStep)}
      </div>
    </div>
  )
}
