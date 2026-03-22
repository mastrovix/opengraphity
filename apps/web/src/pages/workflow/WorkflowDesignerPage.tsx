import { memo, useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { ArrowLeft, Pencil, Settings2, X } from 'lucide-react'
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
import { GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { colors } from '@/lib/tokens'
import { UPDATE_WORKFLOW_STEP, SAVE_WORKFLOW_CHANGES } from '@/graphql/mutations'

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
  timerHours:    number | null
}

interface PendingTransitionChange {
  transitionId:  string
  label:         string
  trigger:       string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
  timerHours:    number | null
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

const ACCENT_COLOR = colors.brand

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
  manual:     colors.trigger.manual,
  automatic:  colors.trigger.automatic,
  sla_breach: colors.trigger.slaBreach,
  timer:      colors.trigger.timer,
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
        border:          `2px solid ${selected || hovered ? accentColor : 'var(--color-brand-a53)'}`,
        backgroundColor: bg,
        boxShadow:       selected ? '0 0 0 3px var(--color-brand-a20)' : '0 2px 8px rgba(0,0,0,0.08)',
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
        backgroundColor: bg === '#FFFFFF' ? 'var(--color-brand-a08)' : 'var(--color-brand-a13)',
        padding:         '1px 6px',
        borderRadius:    4,
        marginBottom:    6,
      }}>
        {step.type === 'start' ? 'START' : step.type === 'end' ? 'END' : step.name.replace(/_/g, ' ')}
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-slate-dark)', lineHeight: 1.3, marginBottom: 4 }}>
        {step.label}
      </div>

      <div style={{ fontSize: 10, color: 'var(--color-slate-light)', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
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

  const strokeColor = color ?? 'var(--color-slate)'

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
        <code style={{ fontSize: 12, color: 'var(--color-slate)' }}>{step.name}</code>
      </PanelField>

      <PanelField label="Type">
        <code style={{ fontSize: 12, color: 'var(--color-slate)' }}>{step.type}</code>
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
  transition:    WFTransition
  onClose:       () => void
  onSaved:       (updated: Partial<WFTransition>) => void
  onSaveLocally: (change: PendingTransitionChange) => void
}

function EdgePanel({ transition, onClose, onSaved, onSaveLocally }: EdgePanelProps) {
  const [label,         setLabel]         = useState(transition.label)
  const [trigger,       setTrigger]       = useState(transition.trigger)
  const [requiresInput, setRequiresInput] = useState(transition.requiresInput)
  const [inputField,    setInputField]    = useState(transition.inputField ?? '')
  const [condition,     setCondition]     = useState(transition.condition ?? '')
  const [timerHours,    setTimerHours]    = useState<string>(transition.timerHours != null ? String(transition.timerHours) : '')

  const unchanged =
    label         === transition.label         &&
    trigger       === transition.trigger       &&
    requiresInput === transition.requiresInput &&
    (inputField  || null) === transition.inputField &&
    (condition   || null) === transition.condition  &&
    (timerHours ? parseInt(timerHours, 10) : null) === transition.timerHours

  return (
    <div style={panelStyle}>
      <PanelHeader title="Modifica Transizione" onClose={onClose} />

      <PanelField label="From → To">
        <span style={{ fontSize: 12, color: 'var(--color-slate)' }}>
          <code>{transition.fromStepName}</code> → <code>{transition.toStepName}</code>
        </span>
      </PanelField>

      <PanelField label="Label">
        <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
      </PanelField>

      <PanelField label="Trigger">
        <select value={trigger} onChange={(e) => setTrigger(e.target.value)} style={inputStyle}>
          <option value="manual">manual</option>
          <option value="automatic">automatic</option>
          <option value="timer">timer</option>
          <option value="sla_breach">sla_breach</option>
        </select>
      </PanelField>

      <PanelField label="Richiede Input">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={requiresInput}
            onChange={(e) => { setRequiresInput(e.target.checked); if (!e.target.checked) setInputField('') }}
          />
          <span style={{ fontSize: 14 }}>{requiresInput ? 'Sì' : 'No'}</span>
        </label>
      </PanelField>

      {requiresInput && (
        <PanelField label="Campo Input">
          <select value={inputField} onChange={(e) => setInputField(e.target.value)} style={inputStyle}>
            <option value="">— nessuno —</option>
            <option value="rootCause">rootCause</option>
            <option value="notes">notes</option>
          </select>
        </PanelField>
      )}

      <PanelField label="Condizione (opzionale)">
        <input
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          placeholder="es. has_linked_change"
          style={inputStyle}
        />
      </PanelField>

      {trigger === 'timer' && (
        <PanelField label="Timer (ore)">
          <input
            type="number"
            min={1}
            value={timerHours}
            onChange={(e) => setTimerHours(e.target.value)}
            placeholder="ore"
            style={inputStyle}
          />
        </PanelField>
      )}

      <button
        onClick={() => {
          const change: PendingTransitionChange = {
            transitionId:  transition.id,
            label,
            trigger,
            requiresInput,
            inputField:  inputField  || null,
            condition:   condition   || null,
            timerHours:  timerHours  ? parseInt(timerHours, 10) : null,
          }
          onSaveLocally(change)
          onSaved({ label, trigger, requiresInput, inputField: change.inputField, condition: change.condition, timerHours: change.timerHours })
          toast.success('Modifica salvata localmente')
        }}
        disabled={unchanged}
        style={saveButtonStyle(unchanged)}
      >
        Salva
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
  color:           'var(--color-slate-dark)',
  outline:         'none',
  backgroundColor: '#fafafa',
  boxSizing:       'border-box',
}

function saveButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding:         '8px 0',
    backgroundColor: disabled ? '#e2e6f0' : colors.brand,
    color:           disabled ? colors.slateLight : colors.white,
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
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-slate-dark)' }}>{title}</span>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 0 }}>
        <X size={16} />
      </button>
    </div>
  )
}

function PanelField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
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
      backgroundColor: colors.brandLight,
      color:           colors.brand,
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

function defToWorkflowKey(def: WorkflowDefinition | null): WorkflowKey {
  if (!def) return 'incident'
  if (def.entityType === 'incident') return 'incident'
  const n = def.name.toLowerCase()
  if (n.includes('standard'))  return 'standard'
  if (n.includes('normal'))    return 'normal'
  if (n.includes('emergency')) return 'emergency'
  return 'standard'
}

export function WorkflowDesignerPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, loading, refetch } = useQuery<{ workflowDefinitionById: WorkflowDefinition | null }>(
    GET_WORKFLOW_DEFINITION_BY_ID,
    { variables: { id }, skip: !id },
  )

  const def = data?.workflowDefinitionById ?? null
  const selectedWorkflow = defToWorkflowKey(def)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [hasChanges,     setHasChanges]     = useState(false)
  const [pendingChanges, setPendingChanges] = useState<PendingTransitionChange[]>([])

  const [saveWorkflowChanges] = useMutation<{ saveWorkflowChanges: { id: string; name: string; version: number } }>(SAVE_WORKFLOW_CHANGES, {
    onError: (e) => toast.error(e.message),
  })

  const handleSaveLocally = useCallback((change: PendingTransitionChange) => {
    setPendingChanges((prev) => {
      const idx = prev.findIndex((c) => c.transitionId === change.transitionId)
      if (idx >= 0) {
        const updated = [...prev]
        updated[idx] = change
        return updated
      }
      return [...prev, change]
    })
    setHasChanges(true)
  }, [])

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

    const accentColor = ACCENT_COLOR

    const stepById: Record<string, string> = {}
    def.steps.forEach((s) => { stepById[s.name] = s.id })

    const newNodes: Node[] = def.steps.map((step, index) => ({
      id:       step.id,
      type:     'workflowStep',
      position: positions[step.name] ?? { x: index * 220, y: 200 },
      data:     { step, accentColor } satisfies StepNodeData,
    }))

    const newEdges: Edge[] = def.transitions.map((tr) => {
      const edgeColor  = TRIGGER_COLOR[tr.trigger] ?? 'var(--color-slate)'
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
        labelStyle:          { fontSize: 12, fontWeight: 500, fill: 'var(--color-slate)' },
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

  const accentColor = ACCENT_COLOR

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
          <button
            onClick={() => navigate('/workflow')}
            style={{
              display:      'inline-flex',
              alignItems:   'center',
              gap:          6,
              marginBottom: 8,
              background:   'none',
              border:       'none',
              cursor:       'pointer',
              color:        'var(--color-slate-light)',
              fontSize:     12,
              padding:      0,
            }}
          >
            <ArrowLeft size={13} />
            Workflow
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>
              {WORKFLOW_LABELS[selectedWorkflow]}
            </h1>
            {def && (
              <span style={{
                fontSize:        11,
                fontWeight:      600,
                padding:         '2px 8px',
                borderRadius:    100,
                backgroundColor: 'var(--color-brand-a08)',
                color:           accentColor,
              }}>
                v{def.version} · Attivo
              </span>
            )}
          </div>
        </div>

        <button
          disabled={(!hasChanges && pendingChanges.length === 0) || !def}
          onClick={async () => {
            if (!def) return
            const positions = nodes.map((n) => ({
              stepId:    n.id,
              positionX: n.position.x,
              positionY: n.position.y,
            }))
            const result = await saveWorkflowChanges({
              variables: {
                definitionId: def.id,
                transitions:  pendingChanges,
                positions,
              },
            })
            const newVersion = result.data?.saveWorkflowChanges?.version ?? (def.version + 1)
            setPendingChanges([])
            setHasChanges(false)
            toast.success(`Workflow salvato — v${newVersion}`)
            refetch()
          }}
          style={{
            padding:         '8px 18px',
            backgroundColor: (hasChanges || pendingChanges.length > 0) && def ? accentColor : '#e2e6f0',
            color:           (hasChanges || pendingChanges.length > 0) && def ? '#ffffff' : 'var(--color-slate-light)',
            border:          'none',
            borderRadius:    7,
            fontSize:        13,
            fontWeight:      600,
            cursor:          (hasChanges || pendingChanges.length > 0) && def ? 'pointer' : 'not-allowed',
            display:         'flex',
            alignItems:      'center',
            gap:             8,
          }}
        >
          Salva modifiche
          {pendingChanges.length > 0 && (
            <span style={{
              fontSize:        11,
              fontWeight:      700,
              padding:         '1px 7px',
              borderRadius:    100,
              backgroundColor: colors.brand,
              color:           colors.white,
            }}>
              {pendingChanges.length}
            </span>
          )}
        </button>
      </div>

      {/* Canvas area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', width: '100%', height: 'calc(100vh - 120px)' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-slate-light)', fontSize: 14 }}>
            Caricamento workflow…
          </div>
        ) : !def ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-slate-light)', fontSize: 14 }}>
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
                onClose={() => setSelectedEdgeId(null)}
                onSaved={(u) => onEdgeSaved(u)}
                onSaveLocally={handleSaveLocally}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: colors.brand }} />
              <span style={{ fontSize: 12, color: colors.slate }}>Nodo / Step</span>
            </div>
            {[
              { color: colors.trigger.manual,    label: 'Manuale' },
              { color: colors.trigger.automatic,  label: 'Automatico' },
              { color: colors.trigger.slaBreach,  label: 'SLA Breach' },
              { color: colors.trigger.timer,      label: 'Timer (auto-close)' },
            ].map(({ color, label }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 20, height: 2, backgroundColor: color, borderRadius: 1 }} />
                <span style={{ fontSize: 12, color: 'var(--color-slate)' }}>{label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
