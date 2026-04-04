import { memo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  getSmoothStepPath,
  BaseEdge,
  EdgeLabelRenderer,
  ConnectionMode,
} from '@xyflow/react'
import type { NodeProps, EdgeProps, Node, Edge, OnNodesChange, OnEdgesChange } from '@xyflow/react'
import { Pencil, Settings2 } from 'lucide-react'
import { colors } from '@/lib/tokens'
import type { StepNodeData, EdgeNodeData, WorkflowDefinition } from './workflow-types'

// ── Per-workflow positions ─────────────────────────────────────────────────────

export const INCIDENT_POSITIONS: Record<string, { x: number; y: number }> = {
  new:         { x: 0,    y: 280 },
  assigned:    { x: 280,  y: 280 },
  in_progress: { x: 560,  y: 280 },
  escalated:   { x: 840,  y: 0   },
  pending:     { x: 560,  y: 560 },
  resolved:    { x: 1120, y: 280 },
  closed:      { x: 1400, y: 280 },
}

export const STANDARD_POSITIONS: Record<string, { x: number; y: number }> = {
  draft:      { x: 0,    y: 280 },
  approved:   { x: 280,  y: 280 },
  scheduled:  { x: 560,  y: 280 },
  validation: { x: 840,  y: 280 },
  deployment: { x: 1120, y: 280 },
  completed:  { x: 1400, y: 280 },
  failed:     { x: 1120, y: 560 },
}

export const NORMAL_POSITIONS: Record<string, { x: number; y: number }> = {
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

export const EMERGENCY_POSITIONS: Record<string, { x: number; y: number }> = {
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

export const INCIDENT_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
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

export const STANDARD_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'draft→approved':        { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'approved→scheduled':    { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'scheduled→validation':  { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'validation→deployment': { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'deployment→completed':  { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'deployment→failed':     { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'  },
}

export const NORMAL_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
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

export const EMERGENCY_HANDLES: Record<string, { sourceHandle: string; targetHandle: string }> = {
  'draft→emergency_approval':      { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'emergency_approval→validation': { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'emergency_approval→rejected':   { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'  },
  'validation→deployment':         { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'deployment→completed':          { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'deployment→failed':             { sourceHandle: 'src-bottom', targetHandle: 'tgt-top'  },
  'failed→post_review':            { sourceHandle: 'src-right',  targetHandle: 'tgt-left' },
  'rejected→draft':                { sourceHandle: 'src-left',   targetHandle: 'tgt-bottom' },
}

export const INCIDENT_BACK = new Set(['pending→in_progress', 'escalated→in_progress', 'resolved→in_progress'])
export const CHANGE_BACK   = new Set(['rejected→draft'])

// ── Step node visual ──────────────────────────────────────────────────────────

export const STEP_BG: Record<string, string> = {
  start:          '#ECFDF5',
  end:            '#F9FAFB',
  standard:       '#FFFFFF',
  parallel_fork:  '#EFF6FF',
  parallel_join:  '#F0FDF4',
  timer_wait:     '#FFF7ED',
  sub_workflow:   '#F5F3FF',
}

export const TRIGGER_COLOR: Record<string, string> = {
  manual:     colors.trigger.manual,
  automatic:  colors.trigger.automatic,
  sla_breach: colors.trigger.slaBreach,
  timer:      colors.trigger.timer,
}

const ACCENT_COLOR = colors.brand

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
        {step.type === 'start'         ? 'START'
        : step.type === 'end'           ? 'END'
        : step.type === 'parallel_fork' ? '⑂ FORK'
        : step.type === 'parallel_join' ? '⑂ JOIN'
        : step.type === 'timer_wait'    ? '⏱ TIMER'
        : step.type === 'sub_workflow'  ? '⊞ SUB'
        : step.name.replace(/_/g, ' ')}
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

export const nodeTypes = { workflowStep: WorkflowStepNode }
export const edgeTypes  = { workflowEdge: WorkflowEdge }

// ── WorkflowCanvas Component ──────────────────────────────────────────────────

interface WorkflowCanvasProps {
  nodes:          Node[]
  edges:          Edge[]
  onNodesChange:  OnNodesChange
  onEdgesChange:  OnEdgesChange
  onNodeClick:    (e: React.MouseEvent, node: Node) => void
  onEdgeClick:    (e: React.MouseEvent, edge: Edge) => void
  onPaneClick:    () => void
  onReconnect:    (oldEdge: Edge, newConnection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => void
  loading:        boolean
  def:            WorkflowDefinition | null
  children?:      React.ReactNode
}

export function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
  onReconnect,
  loading,
  def,
  children,
}: WorkflowCanvasProps) {
  const accentColor = ACCENT_COLOR

  return (
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
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
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
          onReconnect={onReconnect}
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

      {children}

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
  )
}
