import { memo, useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { ArrowLeft, Pencil, Settings2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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

interface NotifyRuleAction {
  type:   'notify_rule'
  params: { title_key: string; severity: string; channels: string[]; target: string }
}

interface ConditionRow {
  field:    string
  operator: string
  value:    string
}

type AnyAction = {
  type:              string
  params?:           Record<string, unknown>
  conditions?:       ConditionRow[]
  conditions_logic?: 'AND' | 'OR'
}

const COND_FIELDS = ['severity', 'status', 'priority', 'category', 'assigned_team', 'assigned_user'] as const

const COND_OPERATORS: { value: string; label: string; noValue?: boolean }[] = [
  { value: 'eq',         label: 'è uguale a'   },
  { value: 'ne',         label: 'è diverso da' },
  { value: 'gt',         label: 'maggiore di'  },
  { value: 'lt',         label: 'minore di'    },
  { value: 'contains',   label: 'contiene'     },
  { value: 'is_null',    label: 'è vuoto',     noValue: true },
  { value: 'is_not_null',label: 'non è vuoto', noValue: true },
]

const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low']
const PRIORITY_VALUES = ['critical', 'high', 'medium', 'low']

const NR_CHANNELS = ['in_app', 'slack', 'teams', 'email'] as const
const NR_SEVERITIES = ['info', 'success', 'warning', 'error'] as const
const NR_TARGETS = ['all', 'assignee', 'team_owner', 'role:admin', 'role:manager'] as const

interface StepPanelProps {
  step:         WFStep
  definitionId: string
  onClose:      () => void
  onSaved:      (updated: Partial<WFStep>) => void
}

function StepPanel({ step, definitionId, onClose, onSaved }: StepPanelProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'props' | 'notify'>('props')
  const [label, setLabel]         = useState(step.label)

  // Parse initial actions (computed once from props — stable until save)
  const allEnterActions: AnyAction[]  = step.enterActions ? (JSON.parse(step.enterActions) as AnyAction[]) : []
  const initExitActions: AnyAction[]  = step.exitActions  ? (JSON.parse(step.exitActions)  as AnyAction[]) : []
  const existingNR = allEnterActions.find((a) => a.type === 'notify_rule') as NotifyRuleAction | undefined
  const initEnterActions = allEnterActions.filter((a) => a.type !== 'notify_rule')

  // Editable actions
  const [editableEnterActions, setEditableEnterActions] = useState<AnyAction[]>(initEnterActions)
  const [editableExitActions,  setEditableExitActions]  = useState<AnyAction[]>(initExitActions)

  // Inline "add action" form
  const [addingFor,           setAddingFor]           = useState<'enter' | 'exit' | null>(null)
  const [newActionType,       setNewActionType]       = useState('sla_start')
  const [newActionParams,     setNewActionParams]     = useState<Record<string, string>>({})
  const [newActionConditions, setNewActionConditions] = useState<ConditionRow[]>([])
  const [newActionLogic,      setNewActionLogic]      = useState<'AND' | 'OR'>('AND')

  // Inline "edit action" form (one at a time)
  const [editingAction, setEditingAction] = useState<{
    list:             'enter' | 'exit'
    index:            number
    type:             string
    params:           Record<string, string>
    conditions:       ConditionRow[]
    conditions_logic: 'AND' | 'OR'
  } | null>(null)

  const [notifyEnabled,  setNotifyEnabled]  = useState(!!existingNR)
  const [notifyTitleKey, setNotifyTitleKey] = useState(existingNR?.params.title_key  ?? '')
  const [notifySeverity, setNotifySeverity] = useState(existingNR?.params.severity   ?? 'info')
  const [notifyChannels, setNotifyChannels] = useState<string[]>(existingNR?.params.channels ?? ['in_app'])
  const [notifyTarget,   setNotifyTarget]   = useState(existingNR?.params.target     ?? 'all')

  const [save, { loading }] = useMutation<{ updateWorkflowStep: WFStep }>(UPDATE_WORKFLOW_STEP, {
    onCompleted: (data) => {
      toast.success('Step aggiornato')
      onSaved({
        label,
        enterActions: data.updateWorkflowStep?.enterActions ?? null,
        exitActions:  data.updateWorkflowStep?.exitActions  ?? null,
      })
    },
    onError: (e) => toast.error(e.message),
  })

  const buildEnterActions = (): string | null => {
    const actions: AnyAction[] = [...editableEnterActions]
    if (notifyEnabled && notifyTitleKey.trim()) {
      actions.push({
        type: 'notify_rule',
        params: {
          title_key: notifyTitleKey.trim(),
          severity:  notifySeverity,
          channels:  notifyChannels,
          target:    notifyTarget,
        },
      })
    }
    return actions.length > 0 ? JSON.stringify(actions) : null
  }

  const buildExitActions = (): string | null =>
    editableExitActions.length > 0 ? JSON.stringify(editableExitActions) : null

  const enterActionsChanged = JSON.stringify(editableEnterActions) !== JSON.stringify(initEnterActions)
  const exitActionsChanged  = JSON.stringify(editableExitActions)  !== JSON.stringify(initExitActions)
  const propsUnchanged      = label === step.label && !enterActionsChanged && !exitActionsChanged
  const notifyUnchanged     = notifyEnabled === !!existingNR
    && notifyTitleKey === (existingNR?.params.title_key  ?? '')
    && notifySeverity === (existingNR?.params.severity   ?? 'info')
    && JSON.stringify(notifyChannels) === JSON.stringify(existingNR?.params.channels ?? ['in_app'])
    && notifyTarget   === (existingNR?.params.target     ?? 'all')
  const saveDisabled = loading || (propsUnchanged && notifyUnchanged)

  const handleSave = () => {
    save({
      variables: {
        definitionId,
        stepName:     step.name,
        label,
        enterActions: buildEnterActions(),
        exitActions:  buildExitActions(),
      },
    })
  }

  const handleConfirmAdd = (forKey: 'enter' | 'exit') => {
    const validConditions = newActionConditions.filter((c) => c.field && c.operator)
    const action: AnyAction = {
      type:   newActionType,
      params: buildActionParams(newActionType, newActionParams),
      ...(validConditions.length > 0 ? { conditions: validConditions, conditions_logic: newActionLogic } : {}),
    }
    if (forKey === 'enter') setEditableEnterActions((prev) => [...prev, action])
    else                    setEditableExitActions((prev)  => [...prev, action])
    setAddingFor(null)
    setNewActionType('sla_start')
    setNewActionParams({})
    setNewActionConditions([])
    setNewActionLogic('AND')
  }

  const toggleChannel = (ch: string) => {
    setNotifyChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch],
    )
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding:           '6px 14px',
    fontSize:          12,
    fontWeight:        active ? 700 : 400,
    color:             active ? ACCENT_COLOR : 'var(--color-slate-light)',
    cursor:            'pointer',
    background:        'none',
    border:            'none',
    borderBottomWidth: 2,
    borderBottomStyle: 'solid' as const,
    borderBottomColor: active ? ACCENT_COLOR : 'transparent',
    transition:        'color 150ms',
  })

  // ── Shared param fields renderer (used by both add and edit forms) ────────────
  const renderParamFields = (
    type: string,
    params: Record<string, string>,
    setParams: (updater: (p: Record<string, string>) => Record<string, string>) => void,
  ) => {
    const labelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }
    const field = (key: string, label: string, placeholder = '', inputType = 'text') => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>{label}</span>
        <input type={inputType} value={params[key] ?? ''} onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.value }))} placeholder={placeholder} style={inputStyle} />
      </div>
    )

    if (type === 'sla_start' || type === 'sla_stop') return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>sla_type</span>
        <select value={params['sla_type'] ?? 'response'} onChange={(e) => setParams((p) => ({ ...p, sla_type: e.target.value }))} style={inputStyle}>
          <option value="response">response</option>
          <option value="resolve">resolve</option>
        </select>
      </div>
    )
    if (type === 'schedule_job') return (
      <>
        {field('job', 'job', 'auto_close')}
        {field('delay_hours', 'delay_hours', '0', 'number')}
      </>
    )
    if (type === 'cancel_job') return field('job', 'job', 'auto_close')

    if (type === 'create_entity') return (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>entity_type</span>
          <select value={params['entity_type'] ?? 'incident'} onChange={(e) => setParams((p) => ({ ...p, entity_type: e.target.value }))} style={inputStyle}>
            <option value="incident">incident</option>
            <option value="problem">problem</option>
            <option value="change">change</option>
          </select>
        </div>
        {field('title_template', 'title_template', '{title} — escalated')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>link_to_current</span>
          <select value={params['link_to_current'] ?? 'true'} onChange={(e) => setParams((p) => ({ ...p, link_to_current: e.target.value }))} style={inputStyle}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
        {field('copy_fields', 'copy_fields (comma-sep)', 'severity,priority')}
      </>
    )

    if (type === 'assign_to') return (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>target_type</span>
          <select value={params['target_type'] ?? 'team'} onChange={(e) => setParams((p) => ({ ...p, target_type: e.target.value }))} style={inputStyle}>
            <option value="team">team</option>
            <option value="user">user</option>
          </select>
        </div>
        {field('target_id', 'target_id', 'UUID of team/user')}
        {field('target_name', 'target_name (template)', '{assigned_team}')}
      </>
    )

    if (type === 'update_field') return (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>field</span>
          <select value={params['field'] ?? 'severity'} onChange={(e) => setParams((p) => ({ ...p, field: e.target.value }))} style={inputStyle}>
            <option value="severity">severity</option>
            <option value="priority">priority</option>
            <option value="status">status</option>
            <option value="description">description</option>
            <option value="category">category</option>
          </select>
        </div>
        {field('value', 'value', 'critical or {field}')}
      </>
    )

    if (type === 'call_webhook') return (
      <>
        {field('url', 'url', 'https://example.com/hook')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>method</span>
          <select value={params['method'] ?? 'POST'} onChange={(e) => setParams((p) => ({ ...p, method: e.target.value }))} style={inputStyle}>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="GET">GET</option>
          </select>
        </div>
        {field('payload_template', 'payload_template (JSON)', '{}')}
      </>
    )

    return null
  }

  // ── Conditions section (shared by add and edit forms) ─────────────────────────
  const renderConditionsSection = (
    conditions:    ConditionRow[],
    logic:         'AND' | 'OR',
    setConditions: (c: ConditionRow[]) => void,
    setLogic:      (l: 'AND' | 'OR') => void,
  ) => {
    const lbl: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }

    const updateRow = (i: number, patch: Partial<ConditionRow>) =>
      setConditions(conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c))

    const addRow = () => setConditions([...conditions, { field: 'severity', operator: 'eq', value: '' }])
    const removeRow = (i: number) => setConditions(conditions.filter((_, idx) => idx !== i))

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={lbl}>Condizioni</span>

        {conditions.map((cond, i) => {
          const op = COND_OPERATORS.find((o) => o.value === cond.operator)
          const needsValue = !op?.noValue
          const isEnumField = cond.field === 'severity' || cond.field === 'priority'
          const enumOptions = cond.field === 'severity' ? SEVERITY_VALUES : PRIORITY_VALUES

          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e6f0', borderRadius: 6 }}>
              {/* AND/OR connector (from 2nd condition onward) */}
              {i > 0 && conditions.length >= 2 && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                  {(['AND', 'OR'] as const).map((opt) => (
                    <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', color: logic === opt ? ACCENT_COLOR : 'var(--color-slate-light)', fontWeight: logic === opt ? 700 : 400 }}>
                      <input type="radio" name={`logic-${i}`} value={opt} checked={logic === opt} onChange={() => setLogic(opt)} style={{ accentColor: ACCENT_COLOR }} />
                      {opt}
                    </label>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {/* Field */}
                <select
                  value={cond.field}
                  onChange={(e) => updateRow(i, { field: e.target.value, value: '' })}
                  style={{ ...inputStyle, flex: 1, fontSize: 11, padding: '5px 6px' }}
                >
                  {COND_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>

                {/* Remove */}
                <button onClick={() => removeRow(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 2, flexShrink: 0, display: 'flex' }}>
                  <X size={11} />
                </button>
              </div>

              {/* Operator */}
              <select
                value={cond.operator}
                onChange={(e) => updateRow(i, { operator: e.target.value })}
                style={{ ...inputStyle, fontSize: 11, padding: '5px 6px' }}
              >
                {COND_OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              {/* Value */}
              {needsValue && (
                isEnumField ? (
                  <select
                    value={cond.value}
                    onChange={(e) => updateRow(i, { value: e.target.value })}
                    style={{ ...inputStyle, fontSize: 11, padding: '5px 6px' }}
                  >
                    <option value="">— seleziona —</option>
                    {enumOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <input
                    value={cond.value}
                    onChange={(e) => updateRow(i, { value: e.target.value })}
                    placeholder="valore..."
                    style={{ ...inputStyle, fontSize: 11, padding: '5px 6px' }}
                  />
                )
              )}
            </div>
          )
        })}

        <button
          onClick={addRow}
          style={{ padding: '4px 8px', backgroundColor: 'transparent', border: '1px dashed #94a3b8', borderRadius: 5, fontSize: 11, color: 'var(--color-slate-light)', cursor: 'pointer', textAlign: 'left' }}
        >
          + Aggiungi condizione
        </button>
      </div>
    )
  }

  const cancelBtnStyle: React.CSSProperties = {
    flex: 1, padding: '6px 0', backgroundColor: '#f1f5f9', border: '1px solid #e2e6f0',
    borderRadius: 6, fontSize: 12, cursor: 'pointer', color: 'var(--color-slate)',
  }

  const renderActionList = (
    actions: AnyAction[],
    onRemove: (i: number) => void,
    forKey: 'enter' | 'exit',
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {actions.map((a, i) => {
        const isEditing = editingAction?.list === forKey && editingAction?.index === i
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* Badge row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <button
                onClick={() => {
                  if (isEditing) {
                    setEditingAction(null)
                  } else {
                    setAddingFor(null)
                    setEditingAction({
                      list:             forKey,
                      index:            i,
                      type:             a.type,
                      params:           paramsToRaw(a.type, a.params),
                      conditions:       (a.conditions ?? []) as ConditionRow[],
                      conditions_logic: a.conditions_logic ?? 'AND',
                    })
                  }
                }}
                style={{
                  background:   'none',
                  border:       isEditing ? '1px solid #06b6d4' : '1px solid transparent',
                  borderRadius: 5,
                  padding:      1,
                  cursor:       'pointer',
                  display:      'flex',
                  transition:   'border-color 150ms',
                }}
              >
                <ActionBadge type={a.type} params={a.params} />
              </button>
              <button
                onClick={() => { setEditingAction(null); onRemove(i) }}
                title={t('workflow.removeAction')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 2, flexShrink: 0, display: 'flex' }}
              >
                <X size={12} />
              </button>
            </div>

            {/* Inline edit form */}
            {isEditing && editingAction && (
              <div style={{ border: '1px solid #06b6d4', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, backgroundColor: '#ecfeff' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#0891b2' }}>
                  {actionLabel(t, a.type, a.params)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {t('workflow.actionType')}
                  </span>
                  <select
                    value={editingAction.type}
                    onChange={(e) => setEditingAction((prev) => prev ? { ...prev, type: e.target.value, params: {} } : null)}
                    style={inputStyle}
                  >
                    <option value="sla_start">sla_start</option>
                    <option value="sla_stop">sla_stop</option>
                    <option value="schedule_job">schedule_job</option>
                    <option value="cancel_job">cancel_job</option>
                    <option value="create_entity">create_entity</option>
                    <option value="assign_to">assign_to</option>
                    <option value="update_field">update_field</option>
                    <option value="call_webhook">call_webhook</option>
                  </select>
                </div>
                {renderParamFields(
                  editingAction.type,
                  editingAction.params,
                  (updater) => setEditingAction((prev) => prev ? { ...prev, params: updater(prev.params) } : null),
                )}
                {renderConditionsSection(
                  editingAction.conditions,
                  editingAction.conditions_logic,
                  (c) => setEditingAction((prev) => prev ? { ...prev, conditions: c } : null),
                  (l) => setEditingAction((prev) => prev ? { ...prev, conditions_logic: l } : null),
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => {
                      const validConditions = editingAction.conditions.filter((c) => c.field && c.operator)
                      const updated: AnyAction = {
                        type:   editingAction.type,
                        params: buildActionParams(editingAction.type, editingAction.params),
                        ...(validConditions.length > 0 ? { conditions: validConditions, conditions_logic: editingAction.conditions_logic } : {}),
                      }
                      if (forKey === 'enter') setEditableEnterActions((prev) => prev.map((x, idx) => idx === i ? updated : x))
                      else                    setEditableExitActions((prev)  => prev.map((x, idx) => idx === i ? updated : x))
                      setEditingAction(null)
                    }}
                    style={{ ...saveButtonStyle(false), flex: 1, padding: '6px 0' }}
                  >
                    Aggiorna
                  </button>
                  <button onClick={() => setEditingAction(null)} style={cancelBtnStyle}>
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Add form */}
      {addingFor === forKey ? (
        <div style={{ border: '1px solid #e2e6f0', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, backgroundColor: '#f8fafc' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {t('workflow.actionType')}
            </span>
            <select value={newActionType} onChange={(e) => { setNewActionType(e.target.value); setNewActionParams({}) }} style={inputStyle}>
              <option value="sla_start">sla_start</option>
              <option value="sla_stop">sla_stop</option>
              <option value="schedule_job">schedule_job</option>
              <option value="cancel_job">cancel_job</option>
              <option value="create_entity">create_entity</option>
              <option value="assign_to">assign_to</option>
              <option value="update_field">update_field</option>
              <option value="call_webhook">call_webhook</option>
            </select>
          </div>
          {renderParamFields(newActionType, newActionParams, (updater) => setNewActionParams((p) => updater(p)))}
          {renderConditionsSection(
            newActionConditions,
            newActionLogic,
            setNewActionConditions,
            setNewActionLogic,
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => handleConfirmAdd(forKey)} style={{ ...saveButtonStyle(false), flex: 1, padding: '6px 0' }}>
              {t('common.confirm')}
            </button>
            <button onClick={() => { setAddingFor(null); setNewActionParams({}); setNewActionConditions([]); setNewActionLogic('AND') }} style={cancelBtnStyle}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setEditingAction(null); setAddingFor(forKey); setNewActionType('sla_start'); setNewActionParams({}); setNewActionConditions([]); setNewActionLogic('AND') }}
          style={{ padding: '5px 10px', backgroundColor: 'transparent', border: `1px dashed ${ACCENT_COLOR}`, borderRadius: 6, fontSize: 12, color: ACCENT_COLOR, cursor: 'pointer', textAlign: 'left' }}
        >
          + {t('workflow.addAction')}
        </button>
      )}
    </div>
  )

  return (
    <div style={panelStyle}>
      <PanelHeader title="Modifica Step" onClose={onClose} />

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', marginBottom: 4 }}>
        <button style={tabStyle(activeTab === 'props')}  onClick={() => setActiveTab('props')}>Proprietà</button>
        <button style={tabStyle(activeTab === 'notify')} onClick={() => setActiveTab('notify')}>Notifiche</button>
      </div>

      {activeTab === 'props' && (
        <>
          <PanelField label="Label">
            <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
          </PanelField>

          <PanelField label="Name">
            <code style={{ fontSize: 12, color: 'var(--color-slate)' }}>{step.name}</code>
          </PanelField>

          <PanelField label="Type">
            <code style={{ fontSize: 12, color: 'var(--color-slate)' }}>{step.type}</code>
          </PanelField>

          <PanelField label="Enter Actions">
            {renderActionList(
              editableEnterActions,
              (i) => setEditableEnterActions((prev) => prev.filter((_, idx) => idx !== i)),
              'enter',
            )}
          </PanelField>

          <PanelField label="Exit Actions">
            {renderActionList(
              editableExitActions,
              (i) => setEditableExitActions((prev) => prev.filter((_, idx) => idx !== i)),
              'exit',
            )}
          </PanelField>
        </>
      )}

      {activeTab === 'notify' && (
        <>
          <PanelField label="Notifica all'ingresso">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <div
                onClick={() => setNotifyEnabled((p) => !p)}
                style={{
                  width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
                  backgroundColor: notifyEnabled ? ACCENT_COLOR : '#cbd5e1',
                  position: 'relative', transition: 'background 200ms', flexShrink: 0,
                }}
              >
                <div style={{
                  position: 'absolute', top: 2, left: notifyEnabled ? 18 : 2,
                  width: 16, height: 16, borderRadius: '50%', background: '#fff',
                  transition: 'left 200ms', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </div>
              <span style={{ fontSize: 13, color: 'var(--color-slate)' }}>
                {notifyEnabled ? 'Attiva' : 'Disattiva'}
              </span>
            </label>
          </PanelField>

          {notifyEnabled && (
            <>
              <PanelField label="Chiave titolo (i18n)">
                <input
                  value={notifyTitleKey}
                  onChange={(e) => setNotifyTitleKey(e.target.value)}
                  placeholder="es. notification.custom.step.title"
                  style={inputStyle}
                />
              </PanelField>

              <PanelField label="Severità">
                <select value={notifySeverity} onChange={(e) => setNotifySeverity(e.target.value)} style={inputStyle}>
                  {NR_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </PanelField>

              <PanelField label="Canali">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {NR_CHANNELS.map((ch) => (
                    <label key={ch} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={notifyChannels.includes(ch)}
                        onChange={() => toggleChannel(ch)}
                        style={{ accentColor: ACCENT_COLOR }}
                      />
                      {ch === 'in_app' ? 'In-App' : ch.charAt(0).toUpperCase() + ch.slice(1)}
                    </label>
                  ))}
                </div>
              </PanelField>

              <PanelField label="Destinatari">
                <select value={notifyTarget} onChange={(e) => setNotifyTarget(e.target.value)} style={inputStyle}>
                  {NR_TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </PanelField>
            </>
          )}
        </>
      )}

      <button
        onClick={handleSave}
        disabled={saveDisabled}
        style={saveButtonStyle(saveDisabled)}
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

// ── Action descriptions ───────────────────────────────────────────────────────

const ACTION_DESCRIPTIONS: Record<string, string> = {
  sla_start:    'Avvia timer SLA',
  sla_stop:     'Ferma timer SLA',
  schedule_job: 'Pianifica job automatico',
  cancel_job:   'Annulla job pianificato',
  notify_rule:  'Regola notifica',
}
void ACTION_DESCRIPTIONS // used as fallback reference; i18n is primary

function actionLabel(t: (key: string) => string, type: string, params?: Record<string, unknown>): string {
  const base = t(`workflow.actions.${type}`)

  if (type === 'sla_start' || type === 'sla_stop') {
    const slaType = params?.['sla_type'] as string | undefined
    if (slaType === 'response') return `${base} ${t('workflow.actions.sla_response')}`
    if (slaType === 'resolve')  return `${base} ${t('workflow.actions.sla_resolve')}`
    return base
  }

  if (type === 'schedule_job') {
    const job   = params?.['job']         as string | undefined
    const hours = params?.['delay_hours'] as number | string | undefined
    if (job) {
      const raw      = t(`workflow.actions.${job}`)
      const display  = raw !== `workflow.actions.${job}` ? raw : job
      const verb     = base.split(' ')[0]
      return hours
        ? `${verb} ${display} ${t('workflow.actions.after')} ${hours}h`
        : `${verb} ${display}`
    }
    return base
  }

  if (type === 'cancel_job') {
    const job = params?.['job'] as string | undefined
    if (job) {
      const raw     = t(`workflow.actions.${job}`)
      const display = raw !== `workflow.actions.${job}` ? raw : job
      return `${base.split(' ')[0]} ${display}`
    }
    return base
  }

  if (type === 'create_entity') {
    const et = params?.['entity_type'] as string | undefined
    return et ? `${base}: ${et}` : base
  }

  if (type === 'assign_to') {
    const tt = params?.['target_type'] as string | undefined
    const tid = (params?.['target_id'] ?? params?.['target_name']) as string | undefined
    return tid ? `${base} → ${tt ?? ''} ${tid.slice(0, 8)}` : base
  }

  if (type === 'update_field') {
    const f = params?.['field'] as string | undefined
    const v = params?.['value'] as string | undefined
    return f ? `${base}: ${f}=${v ?? '?'}` : base
  }

  if (type === 'call_webhook') {
    const url = params?.['url'] as string | undefined
    if (url) {
      try { return `${base}: ${new URL(url).hostname}` } catch { return base }
    }
    return base
  }

  return base
}

function paramsToRaw(type: string, params?: Record<string, unknown>): Record<string, string> {
  if (!params) return {}
  if (type === 'sla_start' || type === 'sla_stop') return { sla_type: String(params['sla_type'] ?? 'response') }
  if (type === 'schedule_job') return { job: String(params['job'] ?? ''), delay_hours: String(params['delay_hours'] ?? '') }
  if (type === 'cancel_job')   return { job: String(params['job'] ?? '') }
  if (type === 'create_entity') return {
    entity_type:     String(params['entity_type']     ?? 'incident'),
    title_template:  String(params['title_template']  ?? ''),
    link_to_current: String(params['link_to_current'] ?? 'true'),
    copy_fields:     Array.isArray(params['copy_fields']) ? (params['copy_fields'] as string[]).join(',') : String(params['copy_fields'] ?? ''),
  }
  if (type === 'assign_to') return {
    target_type: String(params['target_type'] ?? 'team'),
    target_id:   String(params['target_id']   ?? ''),
    target_name: String(params['target_name'] ?? ''),
  }
  if (type === 'update_field') return {
    field: String(params['field'] ?? 'severity'),
    value: String(params['value'] ?? ''),
  }
  if (type === 'call_webhook') return {
    url:              String(params['url']              ?? ''),
    method:           String(params['method']           ?? 'POST'),
    payload_template: String(params['payload_template'] ?? ''),
  }
  return {}
}

function buildActionParams(type: string, raw: Record<string, string>): Record<string, unknown> {
  if (type === 'sla_start' || type === 'sla_stop') {
    return { sla_type: raw['sla_type'] ?? 'response' }
  }
  if (type === 'schedule_job') {
    return { job: raw['job'] ?? '', delay_hours: raw['delay_hours'] ? Number(raw['delay_hours']) : 0 }
  }
  if (type === 'cancel_job') {
    return { job: raw['job'] ?? '' }
  }
  if (type === 'create_entity') {
    const copyFields = raw['copy_fields'] ? raw['copy_fields'].split(',').map((s) => s.trim()).filter(Boolean) : []
    return {
      entity_type:     raw['entity_type']    ?? 'incident',
      title_template:  raw['title_template'] ?? '',
      link_to_current: raw['link_to_current'] !== 'false',
      ...(copyFields.length > 0 ? { copy_fields: copyFields } : {}),
    }
  }
  if (type === 'assign_to') {
    return {
      target_type: raw['target_type'] ?? 'team',
      ...(raw['target_id']   ? { target_id:   raw['target_id']   } : {}),
      ...(raw['target_name'] ? { target_name: raw['target_name'] } : {}),
    }
  }
  if (type === 'update_field') {
    return { field: raw['field'] ?? 'severity', value: raw['value'] ?? '' }
  }
  if (type === 'call_webhook') {
    return {
      url:              raw['url']              ?? '',
      method:           raw['method']           ?? 'POST',
      payload_template: raw['payload_template'] ?? '',
    }
  }
  return {}
}

function ActionBadge({ type, params }: { type: string; params?: Record<string, unknown> }) {
  const { t } = useTranslation()
  return (
    <span
      title={type}
      style={{
        fontSize:        10,
        padding:         '2px 6px',
        borderRadius:    4,
        backgroundColor: colors.brandLight,
        color:           colors.brand,
        fontWeight:      500,
        cursor:          'default',
      }}
    >
      {actionLabel(t, type, params)}
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
