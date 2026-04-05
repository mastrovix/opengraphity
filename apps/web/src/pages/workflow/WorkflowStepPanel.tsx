import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { colors } from '@/lib/tokens'
import { UPDATE_WORKFLOW_STEP } from '@/graphql/mutations'
import type { WFStep, NotifyRuleAction, ConditionRow, AnyAction } from './workflow-types'
import {
  panelStyle,
  panelInputStyle,
  saveButtonStyle,
  PanelHeader,
  PanelField,
  ActionBadge,
  actionLabel,
  paramsToRaw,
  buildActionParams,
} from './workflow-panel-helpers'

const ACCENT_COLOR = colors.brand

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

const NR_CHANNELS   = ['in_app', 'slack', 'teams', 'email'] as const
const NR_SEVERITIES = ['info', 'success', 'warning', 'error'] as const
const NR_TARGETS    = ['all', 'assignee', 'team_owner', 'role:admin', 'role:manager'] as const

// ── inputStyle alias ─────────────────────────────────────────────────────────

const inputStyle = panelInputStyle

// ── StepPanel ─────────────────────────────────────────────────────────────────

interface StepPanelProps {
  step:         WFStep
  definitionId: string
  onClose:      () => void
  onSaved:      (updated: Partial<WFStep>) => void
}

export function WorkflowStepPanel({ step, definitionId, onClose, onSaved }: StepPanelProps) {
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

  const cancelBtnStyle: React.CSSProperties = {
    flex: 1, padding: '6px 0', backgroundColor: '#f1f5f9', border: '1px solid #e2e6f0',
    borderRadius: 6, fontSize: 12, cursor: 'pointer', color: 'var(--color-slate)',
  }

  // ── Shared param fields renderer ─────────────────────────────────────────────
  const renderParamFields = (
    type: string,
    params: Record<string, string>,
    setParams: (updater: (p: Record<string, string>) => Record<string, string>) => void,
  ) => {
    const labelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }
    const field = (key: string, lbl: string, placeholder = '', inputType = 'text') => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>{lbl}</span>
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

    if (type === 'create_approval_request') return (
      <>
        {field('title_template', 'title_template', 'Pubblicazione: {title}')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>approver_role</span>
          <select value={params['approver_role'] ?? 'admin'} onChange={(e) => setParams((p) => ({ ...p, approver_role: e.target.value }))} style={inputStyle}>
            <option value="admin">admin</option>
            <option value="manager">manager</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>approval_type</span>
          <select value={params['approval_type'] ?? 'any'} onChange={(e) => setParams((p) => ({ ...p, approval_type: e.target.value }))} style={inputStyle}>
            <option value="any">any (1 approver sufficient)</option>
            <option value="all">all (all approvers required)</option>
            <option value="majority">majority</option>
          </select>
        </div>
      </>
    )

    return null
  }

  // ── Conditions section ────────────────────────────────────────────────────────
  const renderConditionsSection = (
    conditions:    ConditionRow[],
    logic:         'AND' | 'OR',
    setConditions: (c: ConditionRow[]) => void,
    setLogic:      (l: 'AND' | 'OR') => void,
  ) => {
    const lbl: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }

    const updateRow = (i: number, patch: Partial<ConditionRow>) =>
      setConditions(conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c))

    const addRow    = () => setConditions([...conditions, { field: 'severity', operator: 'eq', value: '' }])
    const removeRow = (i: number) => setConditions(conditions.filter((_, idx) => idx !== i))

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={lbl}>Condizioni</span>

        {conditions.map((cond, i) => {
          const op = COND_OPERATORS.find((o) => o.value === cond.operator)
          const needsValue  = !op?.noValue
          const isEnumField = cond.field === 'severity' || cond.field === 'priority'
          const enumOptions = cond.field === 'severity' ? SEVERITY_VALUES : PRIORITY_VALUES

          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e6f0', borderRadius: 6 }}>
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
                <select
                  value={cond.field}
                  onChange={(e) => updateRow(i, { field: e.target.value, value: '' })}
                  style={{ ...inputStyle, flex: 1, fontSize: 11, padding: '5px 6px' }}
                >
                  {COND_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <button onClick={() => removeRow(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 2, flexShrink: 0, display: 'flex' }}>
                  <X size={11} />
                </button>
              </div>

              <select
                value={cond.operator}
                onChange={(e) => updateRow(i, { operator: e.target.value })}
                style={{ ...inputStyle, fontSize: 11, padding: '5px 6px' }}
              >
                {COND_OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

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

  // ── Action list renderer ──────────────────────────────────────────────────────
  const renderActionList = (
    actions:  AnyAction[],
    onRemove: (i: number) => void,
    forKey:   'enter' | 'exit',
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {actions.map((a, i) => {
        const isEditing = editingAction?.list === forKey && editingAction?.index === i
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                    <option value="create_approval_request">create_approval_request</option>
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
                  {NR_TARGETS.map((tgt) => <option key={tgt} value={tgt}>{tgt}</option>)}
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
