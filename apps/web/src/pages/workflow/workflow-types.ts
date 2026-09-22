// ── Workflow Types ─────────────────────────────────────────────────────────────

export interface WFStep {
  id:           string
  name:         string
  label:        string
  /** Le traduzioni spedite dell'etichetta (secondo giro UI · V-5: il pannello avvisa prima di perderle). */
  labels?:      { language: string; label: string }[]
  type:         'start' | 'standard' | 'end' | 'parallel_fork' | 'parallel_join' | 'timer_wait' | 'sub_workflow'
  enterActions: string | null
  exitActions:  string | null
  timerDelayMinutes?: number | null
  subWorkflowId?:     string | null
  // Workflow metadata — editable in the designer, single source of truth
  // for "is this the initial step?", "is this a terminal state?", etc.
  isInitial?:   boolean
  isTerminal?:  boolean
  isOpen?:      boolean
  category?:    string | null
  /**
   * Lo SCOPO del passo (vocabolario chiuso `WORKFLOW_STEP_PURPOSES`): che ruolo
   * ha nel processo. È quello che le regole di dominio riconoscono, così un
   * passo rinominato continua a funzionare. `null` = nessuno scopo, legittimo.
   */
  purpose?:     string | null
  /** La SCADENZA del passo (JSON di `StepDeadline`); null = nessuna. */
  deadline?:    string | null
  /**
   * Istanze di workflow ferme ORA su questo step. > 0 ⇒ eliminarlo lascerebbe
   * quei ticket senza step corrente: il pannello spegne «Elimina step» e dice
   * quante sono. `undefined` = la query non l'ha chiesto.
   */
  currentInstances?: number
  // Posizione salvata dal designer; null/undefined → layout di default
  positionX?:   number | null
  positionY?:   number | null
}

export interface WFTransition {
  id:            string
  fromStepName:  string
  toStepName:    string
  trigger:       string
  label:         string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
  timerHours:    number | null
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface PendingTransitionChange {
  transitionId:  string
  label:         string
  trigger:       string
  requiresInput: boolean
  inputField:    string | null
  condition:     string | null
  timerHours:    number | null
}

export interface WorkflowDefinition {
  id:              string
  name:            string
  entityType:      string
  version:         number
  active:          boolean
  steps:           WFStep[]
  transitions:     WFTransition[]
}

/**
 * Quale disposizione della tela usare: è il TIPO DI ENTITÀ del workflow, non il
 * suo nome. `none` per tutto ciò che OpenGrafo non semina — fila automatica.
 */
export type WorkflowKey = 'incident' | 'change' | 'service_request' | 'problem' | 'kb_article' | 'none'
export type StepNodeData = { step: WFStep; accentColor: string }
export type EdgeNodeData  = { transition: WFTransition; color: string }

export interface NotifyRuleAction {
  type:   'notify_rule'
  params: { title_key: string; severity: string; channels: string[]; target: string }
}

export interface ConditionRow {
  field:    string
  operator: string
  value:    string
}

export type AnyAction = {
  type:              string
  params?:           Record<string, unknown>
  conditions?:       ConditionRow[]
  conditions_logic?: 'AND' | 'OR'
}
