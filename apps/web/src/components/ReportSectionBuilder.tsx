import { useState, useCallback, useEffect } from 'react'
import { useQuery, useLazyQuery } from '@apollo/client/react'
import {
  ReactFlow, Background, Controls, Handle, Position,
  useNodesState, useEdgesState,
  type Node, type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Hash, PieChart, CircleDot, BarChart2, BarChart, LineChart, TrendingUp,
  Table as TableIcon, AlertCircle, GitPullRequest, Users, Star, X, Check,
  ChevronLeft, ChevronRight, User, Box,
} from 'lucide-react'
import { GET_NAVIGABLE_ENTITIES, GET_REACHABLE_ENTITIES, PREVIEW_REPORT_SECTION } from '@/graphql/queries'
import { ReportChartRenderer } from './ReportChartRenderer'

// ── Types ────────────────────────────────────────────────────────────────────

interface NavigableField    { name: string; label: string; fieldType: string; enumValues: string[] }
interface NavigableRelation { relationshipType: string; direction: string; label: string; targetEntityType: string; targetLabel: string; targetNeo4jLabel: string }
interface NavigableEntity   { entityType: string; label: string; neo4jLabel: string; icon?: string; color?: string; fields: NavigableField[]; relations: NavigableRelation[] }
interface ReachableEntity   { entityType: string; label: string; neo4jLabel: string; relationshipType: string; direction: string; count: number; fields: NavigableField[] }

interface FilterState { field: string; operator: string; value: string }

interface NodeData {
  entityType:      string
  neo4jLabel:      string
  label:           string
  isResult:        boolean
  isRoot:          boolean
  filters:         FilterState[]
  selectedFields:  string[]
  fields:          NavigableField[]
  onToggleResult:  () => void
  onAddFilter:     () => void
  onRemoveFilter:  (i: number) => void
  onFilterChange:  (i: number, key: keyof FilterState, val: string) => void
  onConnect:       () => void
  [key: string]:   unknown
}

interface SectionResult { sectionId: string; title: string; chartType: string; data: string; total: number | null; error: string | null }

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

// ── Constants ─────────────────────────────────────────────────────────────────

const CHART_TYPES = [
  { value: 'kpi',            label: 'Numero totale',     desc: 'Quanti elementi ci sono?',       icon: <Hash size={18} /> },
  { value: 'pie',            label: 'Torta',             desc: 'Distribuzione in percentuale',    icon: <PieChart size={18} /> },
  { value: 'donut',          label: 'Donut',             desc: 'Distribuzione ad anello',         icon: <CircleDot size={18} /> },
  { value: 'bar',            label: 'Barre verticali',   desc: 'Confronto tra categorie',         icon: <BarChart2 size={18} /> },
  { value: 'bar_horizontal', label: 'Barre orizzontali', desc: 'Confronto con etichette lunghe',  icon: <BarChart size={18} /> },
  { value: 'line',           label: 'Linea',             desc: 'Andamento nel tempo',             icon: <LineChart size={18} /> },
  { value: 'area',           label: 'Area',              desc: 'Andamento con riempimento',       icon: <TrendingUp size={18} /> },
  { value: 'table',          label: 'Tabella',           desc: 'Dati dettagliati con colonne',    icon: <TableIcon size={18} /> },
]

const METRIC_TYPES = [
  { value: 'count', label: 'Conteggio' },
  { value: 'avg',   label: 'Media' },
  { value: 'sum',   label: 'Somma' },
  { value: 'min',   label: 'Minimo' },
  { value: 'max',   label: 'Massimo' },
]

const WIZARD_STEPS: { n: 1 | 2 | 3 | 4; label: string }[] = [
  { n: 1, label: 'Cosa analizzare' },
  { n: 2, label: 'Grafo e filtri' },
  { n: 3, label: 'Come mostrarlo' },
  { n: 4, label: 'Titolo e salva' },
]

const ITSM_TYPES = ['Incident', 'Change']
const ORG_TYPES  = ['Team', 'User']

// ── Helpers ───────────────────────────────────────────────────────────────────

function getEntityIcon(entityType: string, size = 24): React.ReactNode {
  switch (entityType) {
    case 'Incident': return <AlertCircle    size={size} color="#ef4444" />
    case 'Change':   return <GitPullRequest  size={size} color="#3b82f6" />
    case 'Team':     return <Users           size={size} color="#8b5cf6" />
    case 'User':     return <User            size={size} color="#10b981" />
    default:         return <Box             size={size} color="#4f46e5" />
  }
}

// ── Custom Node ───────────────────────────────────────────────────────────────

function ReportEntityNode({ data }: { id: string; data: NodeData }) {
  const d = data
  const borderStyle = d.isRoot
    ? '2px solid #4f46e5'
    : d.isResult
      ? '2px solid #10b981'
      : '2px dashed #c4b5fd'
  const bg = d.isResult || d.isRoot ? '#ffffff' : '#faf5ff'

  return (
    <div style={{
      border: borderStyle, borderRadius: 12, background: bg,
      minWidth: 220, maxWidth: 280, boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: '#c4b5fd' }} />

      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827', flex: 1 }}>{d.label}</span>
        {d.isRoot && (
          <span style={{ fontSize: 10, background: '#ede9fe', color: '#7c3aed', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>
            Radice
          </span>
        )}
        <button
          onClick={d.onToggleResult}
          title={d.isResult ? 'Rimuovi dal risultato' : 'Includi nel risultato'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: d.isResult ? '#4f46e5' : '#d1d5db' }}
        >
          <Star size={16} fill={d.isResult ? '#4f46e5' : 'none'} />
        </button>
      </div>

      <div style={{ padding: '8px 14px' }}>
        {d.filters.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {d.filters.map((f: FilterState, i: number) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                <select
                  value={f.field}
                  onChange={e => d.onFilterChange(i, 'field', e.target.value)}
                  style={{ fontSize: 11, padding: '2px 4px', border: '1px solid #e5e7eb', borderRadius: 4, flex: 1 }}
                >
                  <option value="">-- campo --</option>
                  {(d.fields as NavigableField[]).filter(fld => fld.fieldType === 'enum' || fld.fieldType === 'date').map(fld => (
                    <option key={fld.name} value={fld.name}>{fld.label}</option>
                  ))}
                </select>
                {(d.fields as NavigableField[]).find(fld => fld.name === f.field)?.fieldType === 'enum' ? (
                  <select
                    value={f.value}
                    onChange={e => d.onFilterChange(i, 'value', e.target.value)}
                    style={{ fontSize: 11, padding: '2px 4px', border: '1px solid #e5e7eb', borderRadius: 4, flex: 1 }}
                  >
                    <option value="">-- valore --</option>
                    {((d.fields as NavigableField[]).find(fld => fld.name === f.field)?.enumValues ?? []).map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={f.value}
                    onChange={e => d.onFilterChange(i, 'value', e.target.value)}
                    placeholder="valore"
                    style={{ fontSize: 11, padding: '2px 4px', border: '1px solid #e5e7eb', borderRadius: 4, width: 60 }}
                  />
                )}
                <button onClick={() => d.onRemoveFilter(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0 }}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={d.onAddFilter}
          style={{ fontSize: 11, color: '#6b7280', background: 'none', border: '1px dashed #d1d5db', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', width: '100%', marginBottom: 4 }}
        >
          + filtro
        </button>
        <button
          onClick={d.onConnect}
          style={{ fontSize: 11, color: '#4f46e5', background: 'none', border: '1px solid #c4b5fd', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', width: '100%' }}
        >
          + Connetti a...
        </button>
      </div>

      <Handle type="source" position={Position.Bottom} style={{ background: '#c4b5fd' }} />
    </div>
  )
}

const nodeTypes = { reportEntity: ReportEntityNode }

// ── Component ──────────────────────────────────────────────────────────────────

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

  const [nodeDataMap, setNodeDataMap] = useState<Record<string, {
    entityType: string; neo4jLabel: string; label: string
    isResult: boolean; isRoot: boolean
    filters: FilterState[]; selectedFields: string[]
    fields: NavigableField[]
  }>>({})

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

  // ── Node data management ────────────────────────────────────────────────────

  const toggleResult = useCallback((nodeId: string) => {
    setNodeDataMap(prev => ({
      ...prev,
      [nodeId]: { ...prev[nodeId], isResult: !prev[nodeId].isResult },
    }))
  }, [])

  const addFilter = useCallback((nodeId: string) => {
    setNodeDataMap(prev => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        filters: [...prev[nodeId].filters, { field: '', operator: 'eq', value: '' }],
      },
    }))
  }, [])

  const removeFilter = useCallback((nodeId: string, i: number) => {
    setNodeDataMap(prev => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        filters: prev[nodeId].filters.filter((_, idx) => idx !== i),
      },
    }))
  }, [])

  const updateFilter = useCallback((nodeId: string, i: number, key: keyof FilterState, val: string) => {
    setNodeDataMap(prev => {
      const filters = [...prev[nodeId].filters]
      filters[i] = { ...filters[i], [key]: val }
      return { ...prev, [nodeId]: { ...prev[nodeId], filters } }
    })
  }, [])

  // Sync nodeDataMap → react-flow node data
  useEffect(() => {
    setNodes(nds => nds.map(n => {
      const nd = nodeDataMap[n.id]
      if (!nd) return n
      return {
        ...n,
        data: {
          ...n.data,
          ...nd,
          onToggleResult: () => toggleResult(n.id),
          onAddFilter:    () => addFilter(n.id),
          onRemoveFilter: (i: number) => removeFilter(n.id, i),
          onFilterChange: (i: number, k: keyof FilterState, v: string) => updateFilter(n.id, i, k, v),
          onConnect:      () => {
            setConnectingNodeId(n.id)
            fetchReachable({ variables: { fromNeo4jLabel: nd.neo4jLabel } })
          },
        },
      }
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
    const nd = {
      entityType, neo4jLabel, label, isResult: isRoot, isRoot,
      filters: [], selectedFields: [], fields,
    }
    setNodeDataMap(prev => ({ ...prev, [id]: nd }))
    setNodes(prev => [...prev, {
      id,
      type: 'reportEntity',
      position,
      data: {
        ...nd,
        onToggleResult: () => toggleResult(id),
        onAddFilter:    () => addFilter(id),
        onRemoveFilter: (i: number) => removeFilter(id, i),
        onFilterChange: (i: number, k: keyof FilterState, v: string) => updateFilter(id, i, k, v),
        onConnect:      () => {
          setConnectingNodeId(id)
          fetchReachable({ variables: { fromNeo4jLabel: neo4jLabel } })
        },
      },
    }])
    return id
  }, [toggleResult, addFilter, removeFilter, updateFilter, fetchReachable]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Connect reachable ───────────────────────────────────────────────────────

  const connectReachable = useCallback((re: ReachableEntity) => {
    if (!connectingNodeId) return
    const sourceNode = nodes.find(n => n.id === connectingNodeId)
    const newPos = {
      x: (sourceNode?.position.x ?? 300) + (Math.random() * 200 - 100),
      y: (sourceNode?.position.y ?? 100) + 200,
    }

    const entityFull = entities.find(e => e.neo4jLabel === re.neo4jLabel || e.entityType === re.entityType)
    const newNodeId = addNode(re.entityType, re.neo4jLabel, re.label, entityFull?.fields ?? re.fields, false, newPos)

    const edgeId = `edge_${Date.now()}`
    setEdges(prev => [...prev, {
      id: edgeId,
      source: re.direction === 'outgoing' ? connectingNodeId : newNodeId,
      target: re.direction === 'outgoing' ? newNodeId : connectingNodeId,
      label: `${re.direction === 'outgoing' ? '→' : '←'} ${re.relationshipType}`,
      style: { stroke: '#c4b5fd', strokeWidth: 2 },
      data: { relationshipType: re.relationshipType, direction: re.direction },
    }])

    setConnectingNodeId(null)
  }, [connectingNodeId, nodes, entities, addNode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build output ────────────────────────────────────────────────────────────

  const buildInput = useCallback((): ReportSectionInput => {
    const outputNodes = nodes.map(n => {
      const nd = nodeDataMap[n.id]
      return {
        id:             n.id,
        entityType:     nd?.entityType ?? '',
        neo4jLabel:     nd?.neo4jLabel ?? '',
        label:          nd?.label ?? '',
        isResult:       nd?.isResult ?? false,
        isRoot:         nd?.isRoot ?? false,
        positionX:      n.position.x,
        positionY:      n.position.y,
        filters:        nd?.filters?.length ? JSON.stringify(nd.filters.map(f => ({ field: f.field, operator: f.operator, value: f.value }))) : null,
        selectedFields: nd?.selectedFields ?? [],
      }
    })
    const outputEdges = edges.map(e => ({
      id:               e.id,
      sourceNodeId:     e.source,
      targetNodeId:     e.target,
      relationshipType: (e.data as { relationshipType: string } | undefined)?.relationshipType ?? '',
      direction:        (e.data as { direction: string } | undefined)?.direction ?? 'outgoing',
      label:            (e.label as string) ?? '',
    }))
    return {
      title, chartType, metric,
      metricField:   metricField || null,
      groupByNodeId: groupByNodeId || null,
      groupByField:  groupByField || null,
      limit,
      sortDir,
      nodes: outputNodes,
      edges: outputEdges,
    }
  }, [nodes, edges, nodeDataMap, title, chartType, metric, metricField, groupByNodeId, groupByField, limit, sortDir])

  // ── Derived ─────────────────────────────────────────────────────────────────

  const isKpi        = chartType === 'kpi'
  const isTable      = chartType === 'table'
  const isTimeSeries = chartType === 'line' || chartType === 'area'
  const needsGroupBy = !isKpi && !isTable
  const needsLimit   = !isKpi && !isTable && !isTimeSeries

  // ── Auto-preview on step 3 ──────────────────────────────────────────────────

  useEffect(() => {
    if (wizardStep !== 3 || nodes.length === 0) return
    const timer = setTimeout(() => {
      runPreview({ variables: { input: buildInput() } })
    }, 500)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardStep, chartType, groupByNodeId, groupByField, metric, metricField, limit, sortDir, nodes.length, edges.length])

  // ── Styles ──────────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 6,
    border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box',
  }
  const selectStyle: React.CSSProperties = { ...inputStyle, background: '#fff' }
  const labelStyle: React.CSSProperties  = {
    fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase',
    letterSpacing: '0.05em', marginBottom: 6, display: 'block',
  }

  // ── Progress bar ────────────────────────────────────────────────────────────

  const renderProgressBar = () => (
    <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 36 }}>
      {WIZARD_STEPS.map((s, i) => (
        <div key={s.n} style={{ display: 'flex', alignItems: 'flex-start', flex: i < WIZARD_STEPS.length - 1 ? 1 : 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div
              onClick={() => { if (wizardStep > s.n) setWizardStep(s.n) }}
              style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 700,
                background: wizardStep > s.n ? '#10b981' : wizardStep === s.n ? '#4f46e5' : '#e5e7eb',
                color:      wizardStep >= s.n ? '#fff' : '#9ca3af',
                cursor:     wizardStep > s.n ? 'pointer' : 'default',
              }}
            >
              {wizardStep > s.n ? <Check size={16} /> : s.n}
            </div>
            <span style={{
              fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap',
              color: wizardStep === s.n ? '#4f46e5' : wizardStep > s.n ? '#10b981' : '#9ca3af',
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
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 28 }}>
      {onBack ? (
        <button onClick={onBack} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px',
          borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff',
          cursor: 'pointer', fontSize: 14, color: '#374151',
        }}>
          <ChevronLeft size={18} /> Indietro
        </button>
      ) : <div />}
      <div style={{ display: 'flex', gap: 10 }}>
        {isLastStep && (
          <button onClick={onCancel} style={{
            padding: '10px 16px', borderRadius: 8, border: '1px solid #e5e7eb',
            background: '#fff', cursor: 'pointer', fontSize: 14, color: '#6b7280',
          }}>
            Annulla
          </button>
        )}
        <button onClick={onNext} disabled={nextDisabled} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 24px',
          borderRadius: 8, border: 'none',
          background: nextDisabled ? '#c7d2fe' : '#4f46e5',
          color: '#fff', cursor: nextDisabled ? 'not-allowed' : 'pointer',
          fontSize: 14, fontWeight: 600,
        }}>
          {isLastStep ? <Check size={16} /> : null}
          {nextLabel}
          {!isLastStep && <ChevronRight size={18} />}
        </button>
      </div>
    </div>
  )

  // ── STEP 1 — Cosa analizzare ──────────────────────────────────────────────

  const renderStep1 = () => {
    const itsmEntities = entities.filter(e => ITSM_TYPES.includes(e.entityType))
    const orgEntities  = entities.filter(e => ORG_TYPES.includes(e.entityType))
    const ciEntities   = entities.filter(e => !ITSM_TYPES.includes(e.entityType) && !ORG_TYPES.includes(e.entityType))

    const renderEntityGroup = (groupLabel: string, items: NavigableEntity[]) => {
      if (!items.length) return null
      return (
        <div style={{ marginBottom: 24 }} key={groupLabel}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            {groupLabel}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
            {items.map(e => {
              const isSelected = nodes.length > 0 && nodeDataMap[nodes[0]?.id]?.neo4jLabel === e.neo4jLabel
              return (
                <div key={e.entityType} onClick={() => {
                  // Reset graph and start fresh with this entity as root
                  setNodes([])
                  setEdges([])
                  setNodeDataMap({})
                  setTimeout(() => {
                    const nId = `node_${Date.now()}`
                    const nd = {
                      entityType: e.entityType, neo4jLabel: e.neo4jLabel, label: e.label,
                      isResult: true, isRoot: true, filters: [], selectedFields: [], fields: e.fields,
                    }
                    setNodeDataMap({ [nId]: nd })
                    setNodes([{
                      id: nId, type: 'reportEntity', position: { x: 300, y: 80 },
                      data: {
                        ...nd,
                        onToggleResult: () => toggleResult(nId),
                        onAddFilter:    () => addFilter(nId),
                        onRemoveFilter: (i: number) => removeFilter(nId, i),
                        onFilterChange: (i: number, k: keyof FilterState, v: string) => updateFilter(nId, i, k, v),
                        onConnect:      () => {
                          setConnectingNodeId(nId)
                          fetchReachable({ variables: { fromNeo4jLabel: e.neo4jLabel } })
                        },
                      },
                    }])
                  }, 0)
                }} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 10, padding: '20px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                  transition: 'all 0.15s',
                  border:     isSelected ? '2px solid #4f46e5' : '1px solid #e5e7eb',
                  background: isSelected ? '#eef2ff' : '#fff',
                }}>
                  {getEntityIcon(e.entityType, 28)}
                  <span style={{ fontSize: 13, fontWeight: 600, color: isSelected ? '#4f46e5' : '#374151' }}>
                    {e.label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )
    }

    return (
      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700, color: '#0f1629' }}>
          Cosa vuoi analizzare?
        </h3>
        <p style={{ margin: '0 0 24px', fontSize: 13, color: '#6b7280' }}>
          Scegli il tipo di dato su cui costruire la sezione del report.
        </p>
        {renderEntityGroup('ITSM', itsmEntities)}
        {renderEntityGroup('Organizzazione', orgEntities)}
        {renderEntityGroup('CI', ciEntities)}
        {renderNavButtons(null, () => setWizardStep(2), nodes.length === 0)}
      </div>
    )
  }

  // ── STEP 2 — Grafo e filtri ───────────────────────────────────────────────

  const renderStep2 = () => (
    <div>
      <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700, color: '#0f1629' }}>
        Grafo e filtri
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
        Visualizza e configura le entità collegate.
      </p>

      <div style={{ height: 500, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>

        {connectingNodeId && (
          <div style={{
            position: 'absolute', top: 0, right: 0, width: 260, height: '100%',
            background: '#fff', borderLeft: '1px solid #e5e7eb',
            overflowY: 'auto', padding: 16, zIndex: 10,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Connetti a...</span>
              <button onClick={() => setConnectingNodeId(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}>
                <X size={16} />
              </button>
            </div>
            {reachableLoading ? (
              <p style={{ color: '#8892a4', fontSize: 12, textAlign: 'center' }}>Caricamento...</p>
            ) : (reachableData?.reachableEntities ?? []).length === 0 ? (
              <p style={{ color: '#8892a4', fontSize: 12, textAlign: 'center' }}>Nessuna connessione trovata</p>
            ) : (
              (reachableData?.reachableEntities ?? []).map((re, i) => (
                <div
                  key={`${re.neo4jLabel}:${re.relationshipType}:${re.direction}:${i}`}
                  onClick={() => connectReachable(re)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                    border: '1px solid #e0e7ff', borderRadius: 8, cursor: 'pointer',
                    background: '#fafafe', marginBottom: 6,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#eef2ff' }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#fafafe' }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{re.label}</div>
                    <div style={{ fontSize: 11, color: '#8892a4' }}>
                      {re.direction === 'outgoing' ? '→' : '←'} {re.relationshipType}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#c4b5fd' }}>{re.count}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <p style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
        Clicca <strong>+ Connetti a...</strong> su un nodo per aggiungere entità collegate.
        Usa <Star size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> per marcare le entità da includere nel risultato.
      </p>

      {renderNavButtons(() => setWizardStep(1), () => setWizardStep(3))}
    </div>
  )

  // ── STEP 3 — Come mostrare i dati ────────────────────────────────────────

  const renderStep3 = () => {
    const resultNodes = Object.entries(nodeDataMap).filter(([, nd]) => nd.isResult)

    return (
      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700, color: '#0f1629' }}>
          Come vuoi vedere i dati?
        </h3>
        <p style={{ margin: '0 0 24px', fontSize: 13, color: '#6b7280' }}>
          Configura la visualizzazione della sezione.
        </p>

        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ flex: '0 0 420px', display: 'flex', flexDirection: 'column', gap: 18 }}>

            <div>
              <label style={labelStyle}>Tipo di visualizzazione</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {CHART_TYPES.map(ct => (
                  <div key={ct.value} onClick={() => setChartType(ct.value)} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                    borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s',
                    border:     chartType === ct.value ? '2px solid #4f46e5' : '1px solid #e5e7eb',
                    background: chartType === ct.value ? '#eef2ff' : '#fff',
                    color:      chartType === ct.value ? '#4f46e5' : '#374151',
                  }}>
                    {ct.icon}
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{ct.label}</div>
                      <div style={{ fontSize: 11, color: chartType === ct.value ? '#818cf8' : '#9ca3af', marginTop: 2 }}>{ct.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {needsGroupBy && resultNodes.length > 0 && (
              <div>
                <label style={labelStyle}>Raggruppa per</label>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <select value={groupByNodeId} onChange={e => setGroupByNodeId(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                    <option value="">Nodo...</option>
                    {resultNodes.map(([nid, nd]) => (
                      <option key={nid} value={nid}>{nd.label}</option>
                    ))}
                  </select>
                  <select value={groupByField} onChange={e => setGroupByField(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
                    <option value="">Campo...</option>
                    {groupByNodeId && nodeDataMap[groupByNodeId]
                      ? nodeDataMap[groupByNodeId].fields.map(f => (
                          <option key={f.name} value={f.name}>{f.label}</option>
                        ))
                      : null}
                  </select>
                </div>
              </div>
            )}

            {!isKpi && (
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Metrica</label>
                  <select value={metric} onChange={e => setMetric(e.target.value)} style={selectStyle}>
                    {METRIC_TYPES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                {metric !== 'count' && resultNodes.length > 0 && (
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Campo</label>
                    <select value={metricField} onChange={e => setMetricField(e.target.value)} style={selectStyle}>
                      <option value="">Seleziona...</option>
                      {resultNodes.flatMap(([, nd]) =>
                        nd.fields.filter(f => f.fieldType === 'number').map(f => (
                          <option key={f.name} value={f.name}>{f.label}</option>
                        ))
                      )}
                    </select>
                  </div>
                )}
              </div>
            )}

            {needsLimit && (
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Mostra i primi N</label>
                  <input type="number" value={limit} onChange={e => setLimit(Number(e.target.value))} style={inputStyle} min={1} max={100} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Ordine</label>
                  <select value={sortDir} onChange={e => setSortDir(e.target.value)} style={selectStyle}>
                    <option value="DESC">Decrescente</option>
                    <option value="ASC">Crescente</option>
                  </select>
                </div>
              </div>
            )}

            {isTable && resultNodes.length > 0 && (
              <div>
                <label style={labelStyle}>Colonne da mostrare (per nodo risultato)</label>
                {resultNodes.map(([nid, nd]) => (
                  <div key={nid} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{nd.label}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
                      {nd.fields.map(f => (
                        <label key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={nd.selectedFields.includes(f.name)}
                            onChange={e => {
                              setNodeDataMap(prev => ({
                                ...prev,
                                [nid]: {
                                  ...prev[nid],
                                  selectedFields: e.target.checked
                                    ? [...prev[nid].selectedFields, f.name]
                                    : prev[nid].selectedFields.filter(x => x !== f.name),
                                },
                              }))
                            }}
                          />
                          {f.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle}>Anteprima in tempo reale</label>
            <div style={{
              border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, background: '#fafafa', minHeight: 220,
              display: 'flex', alignItems: previewLoading || !previewData ? 'center' : 'flex-start',
              justifyContent: previewLoading || !previewData ? 'center' : 'flex-start',
            }}>
              {previewLoading ? (
                <div style={{ color: '#9ca3af', fontSize: 13 }}>Caricamento anteprima...</div>
              ) : previewData ? (
                <ReportChartRenderer chartType={previewData.chartType} data={previewData.data} title={previewData.title} error={previewData.error} />
              ) : (
                <div style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>
                  Configura il grafico per vedere l'anteprima
                </div>
              )}
            </div>
          </div>
        </div>

        {renderNavButtons(() => setWizardStep(2), () => {
          if (!title) {
            const rootEntry = Object.values(nodeDataMap).find(nd => nd.isRoot)
            if (rootEntry) setTitle(`${rootEntry.label} - ${CHART_TYPES.find(c => c.value === chartType)?.label ?? chartType}`)
          }
          setWizardStep(4)
        })}
      </div>
    )
  }

  // ── STEP 4 — Titolo e salva ───────────────────────────────────────────────

  const renderStep4 = () => {
    const chartDef = CHART_TYPES.find(c => c.value === chartType)
    const rootEntry = Object.values(nodeDataMap).find(nd => nd.isRoot)
    const suggestedTitle = rootEntry
      ? `${rootEntry.label} - ${chartDef?.label ?? chartType}`
      : ''

    return (
      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700, color: '#0f1629' }}>
          Dai un nome alla sezione
        </h3>
        <p style={{ margin: '0 0 24px', fontSize: 13, color: '#6b7280' }}>
          Scegli un titolo descrittivo per questa sezione del report.
        </p>

        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ flex: '0 0 300px' }}>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Titolo sezione</label>
              <input value={title} onChange={e => setTitle(e.target.value)} style={inputStyle} placeholder="Titolo..." />
              {suggestedTitle && title !== suggestedTitle && (
                <button onClick={() => setTitle(suggestedTitle)} style={{
                  marginTop: 6, background: 'none', border: 'none', cursor: 'pointer',
                  color: '#4f46e5', fontSize: 11, padding: 0, textAlign: 'left',
                }}>
                  Usa: "{suggestedTitle}"
                </button>
              )}
            </div>

            <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
                Riepilogo
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {rootEntry && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>Analisi</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', textAlign: 'right' }}>{rootEntry.label}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>Nodi</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', textAlign: 'right' }}>{nodes.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>Visualizzazione</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', textAlign: 'right' }}>{chartDef?.label ?? chartType}</span>
                </div>
                {needsLimit && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>Top</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', textAlign: 'right' }}>{limit}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle}>Anteprima finale</label>
            <div style={{
              border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, background: '#fafafa', minHeight: 220,
              display: 'flex', alignItems: previewLoading || !previewData ? 'center' : 'flex-start',
              justifyContent: previewLoading || !previewData ? 'center' : 'flex-start',
            }}>
              {previewLoading ? (
                <div style={{ color: '#9ca3af', fontSize: 13 }}>Caricamento...</div>
              ) : previewData ? (
                <ReportChartRenderer
                  chartType={previewData.chartType}
                  data={previewData.data}
                  title={title || previewData.title}
                  error={previewData.error}
                />
              ) : (
                <div style={{ color: '#9ca3af', fontSize: 13 }}>Nessuna anteprima disponibile</div>
              )}
            </div>
          </div>
        </div>

        {renderNavButtons(
          () => setWizardStep(3),
          () => onSave(buildInput()),
          !title,
          'Salva sezione',
          true,
        )}
      </div>
    )
  }

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      {renderProgressBar()}
      {wizardStep === 1 && renderStep1()}
      {wizardStep === 2 && renderStep2()}
      {wizardStep === 3 && renderStep3()}
      {wizardStep === 4 && renderStep4()}
    </div>
  )
}
