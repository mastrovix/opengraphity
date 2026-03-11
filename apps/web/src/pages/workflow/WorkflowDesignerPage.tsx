import { memo, useEffect, useState, useCallback } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Pencil, Settings2, X } from 'lucide-react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  getSmoothStepPath,
  BaseEdge,
  EdgeLabelRenderer,
  MarkerType,
  ConnectionMode,
} from '@xyflow/react'
import type { NodeProps, EdgeProps, Node, Edge } from '@xyflow/react'
import { GET_WORKFLOW_DEFINITIONS } from '@/graphql/queries'
import { UPDATE_WORKFLOW_STEP, UPDATE_WORKFLOW_TRANSITION } from '@/graphql/mutations'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WFStep {
  id:           string
  name:         string
  label:        string
  type:         'start' | 'standard' | 'end'
  enterActions: string | null
  exitActions:  string | null
}

interface WFTransition {
  id:            string
  fromStepName:  string
  toStepName:    string
  trigger:       string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
}

interface WorkflowDefinition {
  id:          string
  name:        string
  entityType:  string
  version:     number
  active:      boolean
  steps:       WFStep[]
  transitions: WFTransition[]
}

type WorkflowKey = 'incident' | 'standard' | 'normal' | 'emergency'
type StepNodeData = { step: WFStep; accentColor: string }
type EdgeNodeData  = { transition: WFTransition; color: string }

// ── Workflow Colors ────────────────────────────────────────────────────────────

const WORKFLOW_COLORS: Record<WorkflowKey, string> = {
  incident:  '#4F46E5',
  standard:  '#059669',
  normal:    '#7C3AED',
  emergency: '#D97706',
}

// ── Per-workflow positions ─────────────────────────────────────────────────────

const INCIDENT_POSITIONS: Record<string, { x: number; y: number }> = {
  new:         { x: 0,    y: 280 },
  assigned:    { x: 280,  y: 280 },
  in_progress: { x: 560,  y: 280 },
  escalated:   { x: 840,  y: 0   },
  pending:     { x: 560,  y: 560 },
  resolved:    { x: 1120, y: 280 },
  closed:      { x: 1400, y: 280 },
}

const STANDARD_POSITIONS: Record<string, { x: number; y: number }> = {
  draft:      { x: 0,    y: 280 },
  approved:   { x: 280,  y: 280 },
  scheduled:  { x: 560,  y: 280 },
  validation: { x: 840,  y: 280 },
  deployment: { x: 1120, y: 280 },
  completed:  { x: 1400, y: 280 },
  failed:     { x: 1120, y: 560 },
}

const NORMAL_POSITIONS: Record<string, { x: number; y: number }> = {
  draft:        { x: 0,    y: 280 },
  assessment:   { x: 280,  y: 280 },
  cab_approval: { x: 560,  y: 280 },
  scheduled:    { x: 840,  y: 280 },
  validation:   { x: 1120, y: 280 },
  deployment:   { x: 1400, y: 280 },
  completed:    { x: 1680, y: 280 },
  failed:       { x: 1400, y: 560 },
  rejected:     { x: 560,  y: 560 },
}

const EMERGENCY_POSITIONS: Record<string, { x: number; y: number }> = {
  draft:               { x: 0,    y: 280 },
  emergency_approval:  { x: 280,  y: 280 },
  validation:          { x: 560,  y: 280 },
  deployment:          { x: 840,  y: 280 },
  completed:           { x: 1120, y: 280 },
  failed:              { x: 840,  y: 560 },
  post_review:         { x: 1120, y: 560 },
  rejected:            { x: 280,  y: 560 },
}

// ── Per-workflow edge handles ──────────────────────────────────────────────────

const INCIDENT_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'new→assigned':                     { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'assigned→in_progress':             { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'resolved→closed':                  { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'in_progress→escalated→manual':     { sourceHandle: 'src-top',    targetHandle: 'tgt-left'   },
  'in_progress→escalated→sla_breach': { sourceHandle: 'src-top',    targetHandle: 'tgt-bottom' },
  'escalated→in_progress':            { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'    },
  'escalated→resolved':               { sourceHandle: 'src-right',  targetHandle: 'tgt-top'    },
  'in_progress→pending':              { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'    },
  'pending→in_progress':              { sourceHandle: 'src-top',    targetHandle: 'tgt-bottom' },
  'in_progress→resolved':             { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'resolved→in_progress':             { sourceHandle: 'src-left',   targetHandle: 'tgt-right'  },
}

const STANDARD_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'draft→approved':        { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'approved→scheduled':    { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'scheduled→validation':  { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'validation→deployment': { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'deployment→completed':  { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'deployment→failed':     { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'  },
}

const NORMAL_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'draft→assessment':         { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'assessment→cab_approval':  { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'assessment→rejected':      { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'    },
  'cab_approval→scheduled':   { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'cab_approval→rejected':    { sourceHandle: 'src-bottom', targetHandle: 'tgt-left'   },
  'scheduled→validation':     { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'validation→deployment':    { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'deployment→completed':     { sourceHandle: 'src-right',  targetHandle: 'tgt-left'   },
  'deployment→failed':        { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'    },
  'rejected→draft':           { sourceHandle: 'src-left',   targetHandle: 'tgt-bottom' },
}

const EMERGENCY_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'draft→emergency_approval':      { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'emergency_approval→validation': { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'emergency_approval→rejected':   { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'  },
  'validation→deployment':         { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'deployment→completed':          { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'deployment→failed':             { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'  },
  'failed→post_review':            { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'rejected→draft':                { sourceHandle: 'src-left',   targetHandle: 'tgt-bottom' },
}

// ── Per-workflow back transitions (dashed) ────────────────────────────────────

const INCIDENT_BACK = new Set(['pending→in_progress', 'escalated→in_progress', 'resolved→in_progress'])
const CHANGE_BACK   = new Set(['rejected→draft'])

// ── Step node visual ──────────────────────────────────────────────────────────

const STEP_BG: Record<string, string> = {
  start:    '#ECFDF5',
  end:      '#F9FAFB',
  standard: '#FFFFFF',
}

const TRIGGER_COLOR: Record<string, string> = {
  manual:     '#4F46E5',
  automatic:  '#059669',
  sla_breach: '#DC2626',
  timer:      '#D97706',
}

// ── Custom Node ───────────────────────────────────────────────────────────────

const WorkflowStepNode = memo(function WorkflowStepNode({ data, selected }: NodeProps) {
  const { step, accentColor } = data as StepNodeData
  const [hovered, setHovered] = useState(false)
  const bg = STEP_BG[step.type] ?? '#FFFFFF'

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width:           160,
        minHeight:       80,
        padding:         12,
        borderRadius:    10,
        border:          `2px solid ${selected ? accentColor : hovered ? accentColor : accentColor + '88'}`,
        backgroundColor: bg,
        boxShadow:       selected ? `0 0 0 3px ${accentColor}33` : '0 2px 8px rgba(0,0,0,0.08)',
        position:        'relative',
        transition:      'box-shadow 0.15s, border-color 0.15s',
        cursor:          'default',
      }}
    >
      <Handle type="target" position={Position.Top}    id="tgt-top"    style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="target" position={Position.Bottom} id="tgt-bottom" style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="target" position={Position.Left}   id="tgt-left"   style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="target" position={Position.Right}  id="tgt-right"  style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />

      <div style={{
        display:         'inline-block',
        fontSize:        9,
        fontWeight:      700,
        letterSpacing:   '0.07em',
        textTransform:   'uppercase',
        color:           accentColor,
        backgroundColor: bg === '#FFFFFF' ? `${accentColor}15` : `${accentColor}22`,
        padding:         '1px 6px',
        borderRadius:    4,
        marginBottom:    6,
      }}>
        {step.type === 'start' ? 'START' : step.type === 'end' ? 'END' : step.name.replace(/_/g, ' ')}
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: '#0f1629', lineHeight: 1.3, marginBottom: 4 }}>
        {step.label}
      </div>

      <div style={{ fontSize: 10, color: '#8892a4', fontFamily: 'monospace' }}>
        {step.name}
      </div>

      {(hovered || selected) && (
        <div style={{ position: 'absolute', top: 6, right: 6, color: accentColor, opacity: 0.7 }}>
          <Pencil size={12} />
        </div>
      )}

      <Handle type="source" position={Position.Top}    id="src-top"    style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="source" position={Position.Bottom} id="src-bottom" style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="source" position={Position.Left}   id="src-left"   style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
      <Handle type="source" position={Position.Right}  id="src-right"  style={{ background: accentColor, width: 8, height: 8 }} isConnectable={true} />
    </div>
  )
})

// ── Custom Edge ───────────────────────────────────────────────────────────────

const WorkflowEdge = memo(function WorkflowEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, selected, animated, markerEnd,
}: EdgeProps) {
  const { transition, color } = (data ?? {}) as EdgeNodeData
  const [hovered, setHovered] = useState(false)

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 8,
  })

  const strokeColor = color ?? '#4F46E5'

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke:          strokeColor,
          strokeWidth:     selected || hovered ? 2.5 : 1.5,
          strokeDasharray: animated ? '6 3' : undefined,
          opacity:         selected || hovered ? 1 : 0.7,
          transition:      'stroke-width 0.15s, opacity 0.15s',
        }}
      />

      <EdgeLabelRenderer>
        <div
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            position:        'absolute',
            transform:       `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents:   'all',
            display:         'flex',
            alignItems:      'center',
            gap:             4,
            backgroundColor: '#ffffff',
            border:          `1px solid ${strokeColor}`,
            borderRadius:    4,
            padding:         '2px 6px',
            fontSize:        10,
            fontWeight:      500,
            color:           strokeColor,
            whiteSpace:      'nowrap',
            cursor:          'pointer',
            boxShadow:       '0 1px 4px rgba(0,0,0,0.1)',
            opacity:         selected || hovered ? 1 : 0.85,
          }}
        >
          {transition?.label ?? ''}
          {(hovered || selected) && <Settings2 size={10} />}
        </div>
      </EdgeLabelRenderer>
    </>
  )
})

// ── nodeTypes / edgeTypes — defined outside component to avoid re-renders ──────

const nodeTypes = { workflowStep: WorkflowStepNode }
const edgeTypes  = { workflowEdge: WorkflowEdge }

// ── Side Panel ────────────────────────────────────────────────────────────────

interface StepPanelProps {
  step:         WFStep
  definitionId: string
  onClose:      () => void
  onSaved:      (updated: Partial<WFStep>) => void
}

function StepPanel({ step, definitionId, onClose, onSaved }: StepPanelProps) {
  const [label, setLabel] = useState(step.label)

  const [save, { loading }] = useMutation(UPDATE_WORKFLOW_STEP, {
    onCompleted: () => { toast.success('Step aggiornato'); onSaved({ label }) },
    onError:     (e) => toast.error(e.message),
  })

  const enterActions = step.enterActions ? (JSON.parse(step.enterActions) as Array<{ type: string }>) : []
  const exitActions  = step.exitActions  ? (JSON.parse(step.exitActions)  as Array<{ type: string }>) : []

  return (
    <div style={panelStyle}>
      <PanelHeader title="Modifica Step" onClose={onClose} />

      <PanelField label="Label">
        <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
      </PanelField>

      <PanelField label="Name">
        <code style={{ fontSize: 12, color: '#4a5468' }}>{step.name}</code>
      </PanelField>

      <PanelField label="Type">
        <code style={{ fontSize: 12, color: '#4a5468' }}>{step.type}</code>
      </PanelField>

      {enterActions.length > 0 && (
        <PanelField label="Enter Actions">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {enterActions.map((a, i) => <ActionBadge key={i} type={a.type} />)}
          </div>
        </PanelField>
      )}

      {exitActions.length > 0 && (
        <PanelField label="Exit Actions">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {exitActions.map((a, i) => <ActionBadge key={i} type={a.type} />)}
          </div>
        </PanelField>
      )}

      <button
        onClick={() => save({ variables: { definitionId, stepName: step.name, label } })}
        disabled={loading || label === step.label}
        style={saveButtonStyle(loading || label === step.label)}
      >
        {loading ? 'Salvataggio…' : 'Salva'}
      </button>
    </div>
  )
}

interface EdgePanelProps {
  transition:   WFTransition
  definitionId: string
  onClose:      () => void
  onSaved:      (updated: Partial<WFTransition>) => void
}

function EdgePanel({ transition, definitionId, onClose, onSaved }: EdgePanelProps) {
  const [label,         setLabel]         = useState(transition.label)
  const [requiresInput, setRequiresInput] = useState(transition.requiresInput)
  const [inputField,    setInputField]    = useState(transition.inputField ?? '')

  const [save, { loading }] = useMutation(UPDATE_WORKFLOW_TRANSITION, {
    onCompleted: () => {
      toast.success('Transizione aggiornata')
      onSaved({ label, requiresInput, inputField: inputField || null })
    },
    onError: (e) => toast.error(e.message),
  })

  const unchanged =
    label === transition.label &&
    requiresInput === transition.requiresInput &&
    (inputField || null) === transition.inputField

  return (
    <div style={panelStyle}>
      <PanelHeader title="Modifica Transizione" onClose={onClose} />

      <PanelField label="Label">
        <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
      </PanelField>

      <PanelField label="Requires Input">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={requiresInput}
            onChange={(e) => { setRequiresInput(e.target.checked); if (!e.target.checked) setInputField('') }}
          />
          <span style={{ fontSize: 13 }}>{requiresInput ? 'Sì' : 'No'}</span>
        </label>
      </PanelField>

      {requiresInput && (
        <PanelField label="Input Field">
          <select value={inputField} onChange={(e) => setInputField(e.target.value)} style={inputStyle}>
            <option value="">— nessuno —</option>
            <option value="rootCause">rootCause</option>
            <option value="notes">notes</option>
          </select>
        </PanelField>
      )}

      <PanelField label="From → To">
        <span style={{ fontSize: 12, color: '#4a5468' }}>
          <code>{transition.fromStepName}</code> → <code>{transition.toStepName}</code>
        </span>
      </PanelField>

      <PanelField label="Trigger">
        <span style={{
          display:         'inline-block',
          padding:         '2px 8px',
          borderRadius:    4,
          backgroundColor: `${TRIGGER_COLOR[transition.trigger] ?? '#8892a4'}18`,
          color:           TRIGGER_COLOR[transition.trigger] ?? '#8892a4',
          fontSize:        11,
          fontWeight:      600,
        }}>
          {transition.trigger}
        </span>
      </PanelField>

      <button
        onClick={() => save({ variables: { definitionId, transitionId: transition.id, label, requiresInput, inputField: inputField || null } })}
        disabled={loading || unchanged}
        style={saveButtonStyle(loading || unchanged)}
      >
        {loading ? 'Salvataggio…' : 'Salva'}
      </button>
    </div>
  )
}

// ── Panel helpers ─────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  width:           300,
  backgroundColor: '#ffffff',
  border:          '1px solid #e2e6f0',
  borderRadius:    10,
  padding:         20,
  boxShadow:       '0 4px 24px rgba(0,0,0,0.1)',
  display:         'flex',
  flexDirection:   'column',
  gap:             14,
}

const inputStyle: React.CSSProperties = {
  width:           '100%',
  padding:         '7px 10px',
  border:          '1px solid #e2e6f0',
  borderRadius:    6,
  fontSize:        13,
  color:           '#0f1629',
  outline:         'none',
  backgroundColor: '#fafafa',
  boxSizing:       'border-box',
}

function saveButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding:         '8px 0',
    backgroundColor: disabled ? '#e2e6f0' : '#4f46e5',
    color:           disabled ? '#8892a4' : '#ffffff',
    border:          'none',
    borderRadius:    6,
    fontSize:        13,
    fontWeight:      600,
    cursor:          disabled ? 'not-allowed' : 'pointer',
    width:           '100%',
  }
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#0f1629' }}>{title}</span>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8892a4', padding: 0 }}>
        <X size={16} />
      </button>
    </div>
  )
}

function PanelField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      {children}
    </div>
  )
}

function ActionBadge({ type }: { type: string }) {
  return (
    <span style={{
      fontSize:        10,
      padding:         '2px 6px',
      borderRadius:    4,
      backgroundColor: '#eef2ff',
      color:           '#4f46e5',
      fontWeight:      500,
    }}>
      {type}
    </span>
  )
}

// ── Selector labels ───────────────────────────────────────────────────────────

const WORKFLOW_LABELS: Record<WorkflowKey, string> = {
  incident:  'Incident',
  standard:  'Standard Change',
  normal:    'Normal Change',
  emergency: 'Emergency Change',
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function WorkflowDesignerPage() {
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowKey>('incident')

  const entityType = selectedWorkflow === 'incident' ? 'incident' : 'change'

  const { data, loading } = useQuery<{ workflowDefinitions: WorkflowDefinition[] }>(
    GET_WORKFLOW_DEFINITIONS,
    { variables: { entityType } },
  )

  const workflowName = selectedWorkflow === 'incident' ? null
    : selectedWorkflow === 'standard' ? 'Standard'
    : selectedWorkflow === 'normal'   ? 'Normal'
    : 'Emergency'

  const def = data?.workflowDefinitions?.find((d) =>
    workflowName ? d.name.includes(workflowName) : true,
  ) ?? null

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [hasChanges,     setHasChanges]     = useState(false)

  // ── Build nodes / edges from definition ───────────────────────────────────
  useEffect(() => {
    if (!def) return

    const positions = selectedWorkflow === 'incident' ? INCIDENT_POSITIONS
      : selectedWorkflow === 'standard' ? STANDARD_POSITIONS
      : selectedWorkflow === 'normal'   ? NORMAL_POSITIONS
      : EMERGENCY_POSITIONS

    const edgeHandles = selectedWorkflow === 'incident' ? INCIDENT_HANDLES
      : selectedWorkflow === 'standard' ? STANDARD_HANDLES
      : selectedWorkflow === 'normal'   ? NORMAL_HANDLES
      : EMERGENCY_HANDLES

    const backTransitions = selectedWorkflow === 'incident' ? INCIDENT_BACK : CHANGE_BACK

    const accentColor = WORKFLOW_COLORS[selectedWorkflow]

    const stepById: Record<string, string> = {}
    def.steps.forEach((s) => { stepById[s.name] = s.id })

    const newNodes: Node[] = def.steps.map((step, index) => ({
      id:       step.id,
      type:     'workflowStep',
      position: positions[step.name] ?? { x: index * 220, y: 200 },
      data:     { step, accentColor } satisfies StepNodeData,
    }))

    const newEdges: Edge[] = def.transitions.map((tr) => {
      const edgeColor  = TRIGGER_COLOR[tr.trigger] ?? accentColor
      const baseKey    = `${tr.fromStepName}→${tr.toStepName}`
      const triggerKey = `${tr.fromStepName}→${tr.toStepName}→${tr.trigger}`
      const isBack     = backTransitions.has(baseKey)
      const handles    = edgeHandles[triggerKey] ?? edgeHandles[baseKey] ?? { sourceHandle: 'src-right', targetHandle: 'tgt-left' }

      if (isBack) {
        return {
          id:           tr.id,
          source:       stepById[tr.fromStepName] ?? tr.fromStepName,
          target:       stepById[tr.toStepName]   ?? tr.toStepName,
          sourceHandle: handles.sourceHandle,
          targetHandle: handles.targetHandle,
          type:         'workflowEdge',
          animated:     true,
          style:        { stroke: edgeColor, strokeWidth: 1.5, strokeDasharray: '6,3' },
          markerEnd:    { type: MarkerType.ArrowClosed, width: 14, height: 14, color: edgeColor },
          data:         { transition: { ...tr, label: '' }, color: edgeColor } satisfies EdgeNodeData,
        }
      }

      return {
        id:                  tr.id,
        source:              stepById[tr.fromStepName] ?? tr.fromStepName,
        target:              stepById[tr.toStepName]   ?? tr.toStepName,
        sourceHandle:        handles.sourceHandle,
        targetHandle:        handles.targetHandle,
        type:                'workflowEdge',
        animated:            false,
        style:               { stroke: edgeColor, strokeWidth: 2 },
        markerEnd:           { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edgeColor },
        labelStyle:          { fontSize: 11, fontWeight: 500, fill: '#374151' },
        labelBgStyle:        { fill: '#ffffff', fillOpacity: 1, stroke: edgeColor, strokeWidth: 1 },
        labelBgPadding:      [6, 4] as [number, number],
        labelBgBorderRadius: 4,
        data:                { transition: tr, color: edgeColor } satisfies EdgeNodeData,
      }
    })

    setNodes(newNodes)
    setEdges(newEdges)
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
  }, [def, selectedWorkflow, setNodes, setEdges])

  // ── Click handlers ────────────────────────────────────────────────────────
  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
    setSelectedEdgeId(null)
    setEdges((es) => es.map((e) => ({ ...e, selected: false })))
  }, [setEdges])

  const handleEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id)
    setSelectedNodeId(null)
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))
  }, [setNodes])

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
  }, [])

  // ── Selected data ─────────────────────────────────────────────────────────
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null
  const selectedStep = selectedNode ? (selectedNode.data as StepNodeData).step : null
  const selectedTr   = selectedEdge ? (selectedEdge.data as EdgeNodeData).transition : null

  const accentColor = WORKFLOW_COLORS[selectedWorkflow]

  // ── Save callbacks ────────────────────────────────────────────────────────
  function onStepSaved(updated: Partial<WFStep>) {
    if (!selectedStep) return
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selectedNodeId
          ? { ...n, data: { step: { ...(n.data as StepNodeData).step, ...updated }, accentColor } }
          : n,
      ),
    )
    setHasChanges(false)
  }

  function onEdgeSaved(updated: Partial<WFTransition>) {
    if (!selectedTr) return
    setEdges((es) =>
      es.map((e) =>
        e.id === selectedEdgeId
          ? { ...e, data: { ...(e.data as EdgeNodeData), transition: { ...(e.data as EdgeNodeData).transition, ...updated } } }
          : e,
      ),
    )
    setHasChanges(false)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* Header */}
      <div style={{
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'space-between',
        padding:         '12px 24px',
        borderBottom:    '1px solid #e2e6f0',
        backgroundColor: '#ffffff',
        flexShrink:      0,
      }}>
        <div>
          <div style={{ fontSize: 11, color: '#8892a4', marginBottom: 6 }}>
            Impostazioni &rsaquo; Workflow Designer
          </div>

          {/* Workflow selector */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            {(['incident', 'standard', 'normal', 'emergency'] as WorkflowKey[]).map((wf) => (
              <button
                key={wf}
                onClick={() => { setSelectedWorkflow(wf); setHasChanges(false) }}
                style={{
                  padding:         '5px 12px',
                  borderRadius:    6,
                  border:          `1.5px solid ${selectedWorkflow === wf ? WORKFLOW_COLORS[wf] : '#e2e6f0'}`,
                  backgroundColor: selectedWorkflow === wf ? `${WORKFLOW_COLORS[wf]}15` : 'transparent',
                  color:           selectedWorkflow === wf ? WORKFLOW_COLORS[wf] : '#8892a4',
                  fontSize:        12,
                  fontWeight:      600,
                  cursor:          'pointer',
                  transition:      'all 0.15s',
                }}
              >
                {WORKFLOW_LABELS[wf]}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <h1 style={{ fontSize: 16, fontWeight: 700, color: '#0f1629', margin: 0 }}>
              {WORKFLOW_LABELS[selectedWorkflow]}
            </h1>
            {def && (
              <span style={{
                fontSize:        11,
                fontWeight:      600,
                padding:         '2px 8px',
                borderRadius:    100,
                backgroundColor: `${accentColor}15`,
                color:           accentColor,
              }}>
                v{def.version} · Attivo
              </span>
            )}
          </div>
        </div>

        <button
          disabled={!hasChanges}
          style={{
            padding:         '8px 18px',
            backgroundColor: hasChanges ? accentColor : '#e2e6f0',
            color:           hasChanges ? '#ffffff' : '#8892a4',
            border:          'none',
            borderRadius:    7,
            fontSize:        13,
            fontWeight:      600,
            cursor:          hasChanges ? 'pointer' : 'not-allowed',
          }}
        >
          Salva modifiche
        </button>
      </div>

      {/* Canvas area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', width: '100%', height: 'calc(100vh - 120px)' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8892a4', fontSize: 14 }}>
            Caricamento workflow…
          </div>
        ) : !def ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8892a4', fontSize: 14 }}>
            Nessun workflow trovato per questo tenant.
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
            onPaneClick={handlePaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode="light"
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={2}
            edgesFocusable={true}
            edgesReconnectable={true}
            connectionLineStyle={{ stroke: accentColor, strokeWidth: 2 }}
            isValidConnection={() => true}
            connectionMode={ConnectionMode.Loose}
            onReconnect={(oldEdge, newConnection) => {
              setEdges((eds) =>
                eds.map((e) =>
                  e.id === oldEdge.id
                    ? {
                        ...e,
                        source:       newConnection.source,
                        target:       newConnection.target,
                        sourceHandle: newConnection.sourceHandle ?? e.sourceHandle,
                        targetHandle: newConnection.targetHandle ?? e.targetHandle,
                      }
                    : e,
                ),
              )
            }}
          >
            <Background color="#e2e6f0" gap={20} size={1} />
            <Controls position="bottom-left" style={{ marginBottom: 80 }} />
            <MiniMap
              position="bottom-right"
              nodeColor={(n) => {
                const step = (n.data as StepNodeData | undefined)?.step
                return STEP_BG[step?.type ?? 'standard'] ?? '#fff'
              }}
              style={{ border: '1px solid #e2e6f0', borderRadius: 8 }}
            />
          </ReactFlow>
        )}

        {/* Side Panel */}
        {(selectedStep || selectedTr) && (
          <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
            {selectedStep && def && (
              <StepPanel
                step={selectedStep}
                definitionId={def.id}
                onClose={() => setSelectedNodeId(null)}
                onSaved={(u) => { onStepSaved(u); setHasChanges(true) }}
              />
            )}
            {selectedTr && def && (
              <EdgePanel
                transition={selectedTr}
                definitionId={def.id}
                onClose={() => setSelectedEdgeId(null)}
                onSaved={(u) => { onEdgeSaved(u); setHasChanges(true) }}
              />
            )}
          </div>
        )}

        {/* Legend */}
        {def && (
          <div style={{
            position:        'absolute',
            bottom:          80,
            left:            16,
            zIndex:          10,
            backgroundColor: '#ffffff',
            border:          '1px solid #e2e6f0',
            borderRadius:    8,
            padding:         '10px 14px',
            display:         'flex',
            flexDirection:   'column',
            gap:             6,
          }}>
            {[
              { color: '#4F46E5', label: 'Manuale' },
              { color: '#059669', label: 'Automatico' },
              { color: '#DC2626', label: 'SLA Breach' },
              { color: '#D97706', label: 'Timer (auto-close)' },
            ].map(({ color, label }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 20, height: 2, backgroundColor: color, borderRadius: 1 }} />
                <span style={{ fontSize: 11, color: '#4a5468' }}>{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
