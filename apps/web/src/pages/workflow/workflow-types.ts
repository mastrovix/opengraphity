// ── Workflow Types ─────────────────────────────────────────────────────────────

export interface WFStep {
  id:           string
  name:         string
  label:        string
  type:         'start' | 'standard' | 'end'
  enterActions: string | null
  exitActions:  string | null
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
  id:          string
  name:        string
  entityType:  string
  version:     number
  active:      boolean
  steps:       WFStep[]
  transitions: WFTransition[]
}

export type WorkflowKey = 'incident' | 'standard' | 'normal' | 'emergency'
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
