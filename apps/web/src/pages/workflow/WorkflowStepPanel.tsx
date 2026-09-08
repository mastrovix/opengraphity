import { useState, useMemo } from 'react'
import { useConfirm } from '@/hooks/useConfirm'
import { useQuery } from '@apollo/client/react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { colors } from '@/lib/tokens'
import { GET_WORKFLOW_DEFINITION_BY_ID } from '@/graphql/queries'
import { ConditionRowEditor, type Condition } from '@/components/ConditionRowEditor'
import { ActionParamsEditor } from '@/components/ActionParamsEditor'
import {
  WORKFLOW_STEP_ACTION_TYPES, fromWorkflowOperator, toWorkflowOperator,
} from '@/lib/automationOperators'
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
import { Input, Select } from '@/components/ui/FormControls'

const ACCENT_COLOR = colors.brand

const NR_CHANNELS   = ['in_app', 'slack', 'teams', 'email'] as const
const NR_SEVERITIES = ['info', 'success', 'warning', 'error'] as const
const NR_TARGETS    = ['all', 'assignee', 'team_owner', 'role:admin', 'role:manager'] as const

// ── inputStyle alias ─────────────────────────────────────────────────────────

const inputStyle = panelInputStyle

// ── Adapter di vocabolario (F-20) ─────────────────────────────────────────────
//
// Gli step di workflow persistono gli operatori di `packages/workflow`
// (`eq/ne/gt/lt/…`), mentre l'editor condiviso parla quello di auto-trigger e
// business rule (`equals/not_equals/…`). Il formato SALVATO non cambia: la
// conversione avviene qui, al confine, in entrambe le direzioni.
//  - lettura: un operatore senza equivalente (`gte/lte/in/not_in`) viene
//    mantenuto tale e quale (ConditionRowEditor lo evidenzia in rosso);
//  - scrittura: `toWorkflowOperator` lancia su operatore non mappabile →
//    il bottone Conferma/Aggiorna è disabilitato con il messaggio d'errore.

function conditionsToUI(rows: ConditionRow[] | undefined): Condition[] {
  return (rows ?? []).map((c) => {
    const r = fromWorkflowOperator(c.operator)
    return { field: c.field, operator: r.ok ? r.value : r.raw, value: c.value ?? '' }
  })
}

/** UI → persistito. Scarta le righe incomplete, lancia su operatore non mappabile. */
function conditionsToWorkflow(rows: Condition[]): ConditionRow[] {
  return rows
    .filter((c) => c.field && c.operator)
    .map((c) => ({ field: c.field, operator: toWorkflowOperator(c.operator), value: c.value }))
}

/** Messaggio d'errore della conversione, o null se le condizioni sono salvabili. */
function conditionsError(rows: Condition[]): string | null {
  try { conditionsToWorkflow(rows); return null }
  catch (e) { return e instanceof Error ? e.message : String(e) }
}

// ── Sezione condizioni (logica AND/OR + righe dell'editor condiviso) ─────────

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
}

function ConditionsSection({ entityType, conditions, logic, onConditions, onLogic }: {
  entityType:   string
  conditions:   Condition[]
  logic:        'AND' | 'OR'
  onConditions: (c: Condition[]) => void
  onLogic:      (l: 'AND' | 'OR') => void
}) {
  const updateRow = (i: number, patch: Partial<Condition>) =>
    onConditions(conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c))
  const addRow    = () => onConditions([...conditions, { field: '', operator: 'equals', value: '' }])
  const removeRow = (i: number) => onConditions(conditions.filter((_, idx) => idx !== i))
  const error     = conditionsError(conditions)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={sectionLabelStyle}>Condizioni</span>

      {conditions.length >= 2 && (
        <div style={{ display: 'flex', gap: 8 }}>
          {(['AND', 'OR'] as const).map((opt) => (
            <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-table)', cursor: 'pointer', color: logic === opt ? ACCENT_COLOR : 'var(--color-slate-light)', fontWeight: logic === opt ? 700 : 400 }}>
              <input type="radio" value={opt} checked={logic === opt} onChange={() => onLogic(opt)} style={{ accentColor: ACCENT_COLOR }} />
              {opt}
            </label>
          ))}
        </div>
      )}

      {conditions.map((cond, i) => (
        <div key={i} style={{ padding: '8px 10px', background: 'var(--color-slate-bg)', border: '1px solid #e2e6f0', borderRadius: 6 }}>
          <ConditionRowEditor
            layout="stack"
            entityType={entityType}
            condition={cond}
            onChange={(patch) => updateRow(i, patch)}
            onRemove={() => removeRow(i)}
          />
        </div>
      ))}

      {error && (
        <div role="alert" style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-danger)' }}>
          {error}
        </div>
      )}

      <button
        onClick={addRow}
        style={{ padding: '4px 8px', backgroundColor: 'transparent', border: '1px dashed #94a3b8', borderRadius: 5, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', cursor: 'pointer', textAlign: 'left' }}
      >
        + Aggiungi condizione
      </button>
    </div>
  )
}

// ── StepPanel ─────────────────────────────────────────────────────────────────

interface StepPanelProps {
  step:         WFStep
  definitionId: string
  onClose:      () => void
  onSaved:      (updated: Partial<WFStep>) => void
  onDelete?:    (stepName: string) => void
  onSaveLocally?: (change: {
    stepName:     string
    label:        string
    enterActions: string | null
    exitActions:  string | null
    isInitial?:   boolean
    isTerminal?:  boolean
    isOpen?:      boolean
    category?:    string | null
  }) => void
}

interface ActionDraft {
  type:             string
  params:           Record<string, string>
  conditions:       Condition[]
  conditions_logic: 'AND' | 'OR'
}

const DEFAULT_ACTION_TYPE = WORKFLOW_STEP_ACTION_TYPES[0]

function emptyDraft(): ActionDraft {
  return { type: DEFAULT_ACTION_TYPE, params: {}, conditions: [], conditions_logic: 'AND' }
}

/** Bozza UI → azione persistita (operatori convertiti). Lancia su operatore non mappabile. */
function draftToAction(d: ActionDraft): AnyAction {
  const conditions = conditionsToWorkflow(d.conditions)
  return {
    type:   d.type,
    params: buildActionParams(d.type, d.params),
    ...(conditions.length > 0 ? { conditions, conditions_logic: d.conditions_logic } : {}),
  }
}

export function WorkflowStepPanel({ step, definitionId, onClose, onSaved, onSaveLocally, onDelete }: StepPanelProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()

  // Tipo entità del workflow (incident/problem/change/…): serve agli editor
  // condivisi per leggere i campi dal metamodello. La definizione è già in
  // cache (il designer la carica con la stessa query) → nessuna richiesta extra.
  const { data: defData, error: defError } = useQuery<{ workflowDefinitionById: { id: string; entityType: string } | null }>(
    GET_WORKFLOW_DEFINITION_BY_ID,
    { variables: { id: definitionId }, fetchPolicy: 'cache-first' },
  )
  const entityType = defData?.workflowDefinitionById?.entityType ?? ''
  const entityTypeError = defError
    ? defError.message
    : (defData && !defData.workflowDefinitionById ? `definizione workflow "${definitionId}" non trovata` : null)

  const [activeTab, setActiveTab] = useState<'props' | 'notify' | 'metadata'>('props')
  const [label, setLabel]         = useState(step.label)
  const [isInitial,  setIsInitial]  = useState(Boolean(step.isInitial))
  const [isTerminal, setIsTerminal] = useState(Boolean(step.isTerminal))
  const [isOpen,     setIsOpen]     = useState(step.isOpen ?? !step.isTerminal)
  const [category,   setCategory]   = useState(step.category ?? '')

  // Parse initial actions (computed once from props — stable until save).
  // Un JSON corrotto su enter/exit_actions NON deve far cadere l'intera pagina
  // del designer: il pannello mostra l'errore e blocca il Salva (che
  // riscriverebbe le azioni perdendo quelle illeggibili).
  const { allEnterActions, initExitActions, actionsParseError } = useMemo(() => {
    const parseList = (raw: string | null, field: string): AnyAction[] | string => {
      if (!raw) return []
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return `${field}: atteso un array JSON, trovato ${typeof parsed}`
        return parsed as AnyAction[]
      } catch (e) {
        return `${field}: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    const enter = parseList(step.enterActions, 'enter_actions')
    const exit  = parseList(step.exitActions,  'exit_actions')
    const errors = [enter, exit].filter((r): r is string => typeof r === 'string')
    return {
      allEnterActions:   Array.isArray(enter) ? enter : [],
      initExitActions:   Array.isArray(exit)  ? exit  : [],
      actionsParseError: errors.length > 0 ? errors.join(' · ') : null,
    }
  }, [step.enterActions, step.exitActions])
  const existingNR = allEnterActions.find((a) => a.type === 'notify_rule') as NotifyRuleAction | undefined
  const initEnterActions = allEnterActions.filter((a) => a.type !== 'notify_rule')

  // Editable actions
  const [editableEnterActions, setEditableEnterActions] = useState<AnyAction[]>(initEnterActions)
  const [editableExitActions,  setEditableExitActions]  = useState<AnyAction[]>(initExitActions)

  // Inline "add action" form
  const [addingFor, setAddingFor] = useState<'enter' | 'exit' | null>(null)
  const [newAction, setNewAction] = useState<ActionDraft>(emptyDraft)

  // Inline "edit action" form (one at a time)
  const [editingAction, setEditingAction] = useState<(ActionDraft & { list: 'enter' | 'exit'; index: number }) | null>(null)

  const [notifyEnabled,  setNotifyEnabled]  = useState(!!existingNR)
  const [notifyTitleKey, setNotifyTitleKey] = useState(existingNR?.params.title_key  ?? '')
  const [notifySeverity, setNotifySeverity] = useState(existingNR?.params.severity   ?? 'info')
  const [notifyChannels, setNotifyChannels] = useState<string[]>(existingNR?.params.channels ?? ['in_app'])
  const [notifyTarget,   setNotifyTarget]   = useState(existingNR?.params.target     ?? 'all')

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
  const metadataChanged     =
       isInitial  !== Boolean(step.isInitial)
    || isTerminal !== Boolean(step.isTerminal)
    || isOpen     !== (step.isOpen ?? !step.isTerminal)
    || category   !== (step.category ?? '')
  const propsUnchanged      = label === step.label && !enterActionsChanged && !exitActionsChanged && !metadataChanged
  const notifyUnchanged     = notifyEnabled === !!existingNR
    && notifyTitleKey === (existingNR?.params.title_key  ?? '')
    && notifySeverity === (existingNR?.params.severity   ?? 'info')
    && JSON.stringify(notifyChannels) === JSON.stringify(existingNR?.params.channels ?? ['in_app'])
    && notifyTarget   === (existingNR?.params.target     ?? 'all')
  const saveDisabled = actionsParseError !== null || (propsUnchanged && notifyUnchanged)

  const handleSave = () => {
    const enterActions = buildEnterActions()
    const exitActions  = buildExitActions()
    const categoryValue = category.trim() ? category.trim() : null
    onSaveLocally?.({
      stepName: step.name, label, enterActions, exitActions,
      isInitial, isTerminal, isOpen, category: categoryValue,
    })
    onSaved({
      label, enterActions, exitActions,
      isInitial, isTerminal, isOpen, category: categoryValue,
    })
  }

  const handleConfirmAdd = (forKey: 'enter' | 'exit') => {
    const action = draftToAction(newAction)   // non lancia: il bottone è disabilitato se conditionsError ≠ null
    if (forKey === 'enter') setEditableEnterActions((prev) => [...prev, action])
    else                    setEditableExitActions((prev)  => [...prev, action])
    setAddingFor(null)
    setNewAction(emptyDraft())
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
    borderRadius: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer', color: 'var(--color-slate)',
  }

  // ── Editor di una bozza (tipo + parametri + condizioni), condiviso tra add/edit ──
  const renderDraftEditor = (draft: ActionDraft, setDraft: (updater: (d: ActionDraft) => ActionDraft) => void) => (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={sectionLabelStyle}>{t('workflow.actionType')}</span>
        <Select
          value={draft.type}
          onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value, params: {} }))}
          style={inputStyle}
        >
          {WORKFLOW_STEP_ACTION_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
        </Select>
      </div>
      <ActionParamsEditor
        vocabulary="workflow_step"
        actionType={draft.type}
        params={draft.params}
        entityType={entityType}
        onChange={(key, value) => setDraft((d) => ({ ...d, params: { ...d.params, [key]: value } }))}
      />
      <ConditionsSection
        entityType={entityType}
        conditions={draft.conditions}
        logic={draft.conditions_logic}
        onConditions={(c) => setDraft((d) => ({ ...d, conditions: c }))}
        onLogic={(l) => setDraft((d) => ({ ...d, conditions_logic: l }))}
      />
    </>
  )

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
                      conditions:       conditionsToUI(a.conditions),
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

            {isEditing && editingAction && (() => {
              const blocked = conditionsError(editingAction.conditions) !== null
              return (
                <div style={{ border: '1px solid #06b6d4', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, backgroundColor: '#ecfeff' }}>
                  <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: '#0891b2' }}>
                    {actionLabel(t, a.type, a.params)}
                  </div>
                  {renderDraftEditor(editingAction, (updater) => setEditingAction((prev) => prev ? { ...prev, ...updater(prev) } : null))}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      disabled={blocked}
                      onClick={() => {
                        const updated = draftToAction(editingAction)
                        if (forKey === 'enter') setEditableEnterActions((prev) => prev.map((x, idx) => idx === i ? updated : x))
                        else                    setEditableExitActions((prev)  => prev.map((x, idx) => idx === i ? updated : x))
                        setEditingAction(null)
                      }}
                      style={{ ...saveButtonStyle(blocked), flex: 1, padding: '6px 0' }}
                    >
                      Aggiorna
                    </button>
                    <button onClick={() => setEditingAction(null)} style={cancelBtnStyle}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )
            })()}
          </div>
        )
      })}

      {addingFor === forKey ? (() => {
        const blocked = conditionsError(newAction.conditions) !== null
        return (
          <div style={{ border: '1px solid #e2e6f0', borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, backgroundColor: 'var(--color-slate-bg)' }}>
            {renderDraftEditor(newAction, (updater) => setNewAction((d) => updater(d)))}
            <div style={{ display: 'flex', gap: 6 }}>
              <button disabled={blocked} onClick={() => handleConfirmAdd(forKey)} style={{ ...saveButtonStyle(blocked), flex: 1, padding: '6px 0' }}>
                {t('common.confirm')}
              </button>
              <button onClick={() => { setAddingFor(null); setNewAction(emptyDraft()) }} style={cancelBtnStyle}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )
      })() : (
        <button
          onClick={() => { setEditingAction(null); setAddingFor(forKey); setNewAction(emptyDraft()) }}
          style={{ padding: '5px 10px', backgroundColor: 'transparent', border: `1px dashed ${ACCENT_COLOR}`, borderRadius: 6, fontSize: 'var(--font-size-body)', color: ACCENT_COLOR, cursor: 'pointer', textAlign: 'left' }}
        >
          + {t('workflow.addAction')}
        </button>
      )}
    </div>
  )

  return (
    <div style={panelStyle}>
      <PanelHeader title="Modifica Step" onClose={onClose} />

      {actionsParseError && (
        <div
          role="alert"
          style={{
            padding: '8px 10px', marginBottom: 8, borderRadius: 6,
            background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger)',
            color: 'var(--color-danger)', fontSize: 'var(--font-size-body)', lineHeight: 1.4,
          }}
        >
          <strong>Azioni dello step corrotte</strong> — {actionsParseError}. Correggi il dato salvato
          (enter/exit_actions dello step <code>{step.name}</code>) prima di modificarlo: il salvataggio è disabilitato
          per non perdere le azioni illeggibili.
        </div>
      )}

      {entityTypeError && (
        <div role="alert" style={{ padding: '6px 10px', marginBottom: 8, borderRadius: 6, background: 'var(--color-danger-bg)', color: 'var(--color-danger)', fontSize: 'var(--font-size-label)' }}>
          Tipo entità del workflow non disponibile ({entityTypeError}): campi e valori delle condizioni non caricabili.
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', marginBottom: 4 }}>
        <button style={tabStyle(activeTab === 'props')}    onClick={() => setActiveTab('props')}>Proprietà</button>
        <button style={tabStyle(activeTab === 'metadata')} onClick={() => setActiveTab('metadata')}>Metadati</button>
        <button style={tabStyle(activeTab === 'notify')}   onClick={() => setActiveTab('notify')}>Notifiche</button>
      </div>

      {activeTab === 'metadata' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
          <PanelField label="Step iniziale">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
              <input type="checkbox" checked={isInitial} onChange={(e) => setIsInitial(e.target.checked)} style={{ accentColor: ACCENT_COLOR }} />
              <span>Il processo parte da questo step</span>
            </label>
          </PanelField>
          <PanelField label="Step terminale">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isTerminal}
                onChange={(e) => { setIsTerminal(e.target.checked); setIsOpen(!e.target.checked) }}
                style={{ accentColor: ACCENT_COLOR }}
              />
              <span>Il processo è chiuso quando arriva qui</span>
            </label>
          </PanelField>
          <PanelField label="Step aperto">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-body)', cursor: 'pointer', opacity: isTerminal ? 0.5 : 1 }}>
              <input type="checkbox" checked={isOpen} disabled={isTerminal} onChange={(e) => setIsOpen(e.target.checked)} style={{ accentColor: ACCENT_COLOR }} />
              <span>L'entità è considerata "aperta" in questo step</span>
            </label>
          </PanelField>
          <PanelField label="Categoria">
            <Input
              list="wf-step-categories"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="es. active, waiting, resolved, closed, failed, draft"
              style={inputStyle}
            />
            <datalist id="wf-step-categories">
              <option value="active" />
              <option value="waiting" />
              <option value="escalated" />
              <option value="resolved" />
              <option value="closed" />
              <option value="failed" />
              <option value="draft" />
            </datalist>
          </PanelField>
        </div>
      )}

      {activeTab === 'props' && (
        <>
          <PanelField label="Label">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
          </PanelField>

          <PanelField label="Name">
            <code style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{step.name}</code>
          </PanelField>

          <PanelField label="Type">
            <code style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>{step.type}</code>
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
              <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                {notifyEnabled ? 'Attiva' : 'Disattiva'}
              </span>
            </label>
          </PanelField>

          {notifyEnabled && (
            <>
              <PanelField label="Chiave titolo (i18n)">
                <Input
                  value={notifyTitleKey}
                  onChange={(e) => setNotifyTitleKey(e.target.value)}
                  placeholder="es. notification.custom.step.title"
                  style={inputStyle}
                />
              </PanelField>

              <PanelField label="Severità">
                <Select value={notifySeverity} onChange={(e) => setNotifySeverity(e.target.value)} style={inputStyle}>
                  {NR_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </PanelField>

              <PanelField label="Canali">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {NR_CHANNELS.map((ch) => (
                    <label key={ch} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 'var(--font-size-body)' }}>
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
                <Select value={notifyTarget} onChange={(e) => setNotifyTarget(e.target.value)} style={inputStyle}>
                  {NR_TARGETS.map((tgt) => <option key={tgt} value={tgt}>{tgt}</option>)}
                </Select>
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
        Salva
      </button>

      {onDelete && !isInitial && (
        <button
          onClick={() => {
            void confirm({ title: `Eliminare lo step "${step.label || step.name}"?`, body: 'Verranno rimosse anche le transizioni collegate.', danger: true }).then((ok) => {
              if (ok) onDelete(step.name)
            })
          }}
          style={{
            marginTop: 8, width: '100%', padding: '8px 12px', borderRadius: 6,
            border: '1px solid var(--color-danger)', background: '#fff',
            color: 'var(--color-danger)', cursor: 'pointer', fontSize: 'var(--font-size-body)', fontWeight: 600,
          }}
        >
          Elimina step
        </button>
      )}
    </div>
  )
}
