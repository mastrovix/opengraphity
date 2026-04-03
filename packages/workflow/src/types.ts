export type WorkflowStepType = 'start' | 'standard' | 'end'

export type WorkflowTrigger =
  | 'manual'       // richiede azione utente
  | 'automatic'    // sistema lo fa da solo
  | 'sla_breach'   // SLA engine lo triggera
  | 'timer'        // BullMQ job

export type WorkflowActionType =
  | 'sla_start'
  | 'sla_stop'
  | 'sla_pause'
  | 'sla_resume'
  | 'notify'
  | 'publish_event'
  | 'schedule_job'
  | 'cancel_job'
  | 'notify_rule'
  | 'create_entity'
  | 'assign_to'
  | 'update_field'
  | 'call_webhook'

// ── Typed params per action type ──────────────────────────────────────────────

export interface CreateEntityParams {
  entity_type:     'incident' | 'problem' | 'change'
  title_template:  string
  link_to_current: boolean
  copy_fields?:    string[]
}

export interface AssignToParams {
  target_type:  'team' | 'user'
  target_id?:   string
  target_name?: string
}

export interface UpdateFieldParams {
  field: string
  value: string | number | boolean
}

export interface CallWebhookParams {
  url:               string
  method:            'GET' | 'POST' | 'PUT'
  headers?:          Record<string, string>
  payload_template?: string
}

// ── Conditions ────────────────────────────────────────────────────────────────

export type ConditionOperator =
  | 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'in' | 'not_in' | 'contains'
  | 'is_null' | 'is_not_null'

export interface ConditionDef {
  field:    string
  operator: ConditionOperator
  value?:   unknown
}

// ── Action config ─────────────────────────────────────────────────────────────

export interface WorkflowActionConfig {
  type:              WorkflowActionType
  params:            Record<string, unknown>
  conditions?:       ConditionDef[]
  conditions_logic?: 'AND' | 'OR'
}

// ── Action context ─────────────────────────────────────────────────────────────
// Passed by callers so that packages/workflow never imports from apps/api.

export interface ActionContext {
  userId:           string
  notes?:           string
  entityData:       Record<string, unknown>      // entity properties for template/condition eval
  isWebhookRetry?:  boolean
  createEntity?: (type: string, data: Record<string, unknown>) => Promise<string>
  assignTo?:    (entityId: string, targetType: string, targetId: string) => Promise<void>
  updateField?: (entityId: string, field: string, value: unknown) => Promise<void>
  publishEvent?: (type: string, payload: Record<string, unknown>) => Promise<void>
}

// ── Step / Transition / Definition ────────────────────────────────────────────

export interface WorkflowStepDef {
  id:           string
  name:         string
  label:        string
  type:         WorkflowStepType
  enterActions: WorkflowActionConfig[]
  exitActions:  WorkflowActionConfig[]
}

export interface WorkflowTransitionDef {
  id:            string
  fromStepName:  string
  toStepName:    string
  trigger:       WorkflowTrigger
  label:         string
  condition:     string | null
  requiresInput: boolean
  inputField:    string | null
}

export interface WorkflowDefinition {
  id:          string
  tenantId:    string
  name:        string
  entityType:  string
  version:     number
  active:      boolean
  steps:       WorkflowStepDef[]
  transitions: WorkflowTransitionDef[]
}

export interface WorkflowInstance {
  id:           string
  tenantId:     string
  definitionId: string
  entityId:     string
  entityType:   string
  currentStep:  string
  status:       'active' | 'completed' | 'failed'
  createdAt:    string
  updatedAt:    string
}

export interface WorkflowStepExecution {
  id:          string
  tenantId:    string
  instanceId:  string
  stepName:    string
  enteredAt:   string
  exitedAt:    string | null
  durationMs:  number | null
  triggeredBy: string
  triggerType: WorkflowTrigger
  notes:       string | null
}

export interface TransitionInput {
  instanceId:  string
  toStepName:  string
  triggeredBy: string
  triggerType: WorkflowTrigger
  notes?:      string
}

export interface TransitionResult {
  success:    boolean
  instance:   WorkflowInstance
  execution:  WorkflowStepExecution
  actionsRun: WorkflowActionType[]
  error?:     string
}
