import type { Session } from 'neo4j-driver'

// Unica sorgente per i tipi di step: engine (timer_wait, sub_workflow), API e
// web (parallel_fork/join) usavano liste diverse dello stesso enum.
export type WorkflowStepType =
  | 'start' | 'standard' | 'end'
  | 'timer_wait' | 'sub_workflow'
  | 'parallel_fork' | 'parallel_join'

// ── Condizioni di transizione ────────────────────────────────────────────────
// L'engine non conosce il dominio: le condizioni (has_linked_change,
// all_assessments_complete, …) sono registrate dal chiamante con
// workflowEngine.registerCondition e valutate per OGNI trigger, manuale o
// automatico. Una condizione non registrata rende la transizione non valida.

export interface ConditionContext {
  instanceId:   string
  entityId:     string
  entityType:   string
  tenantId:     string
  fromStepName: string
  toStepName:   string
  triggerType:  WorkflowTrigger
  notes?:       string
  entityData:   Record<string, unknown>
}

export type ConditionEvaluator = (session: Session, ctx: ConditionContext) => Promise<boolean>

export type WorkflowTrigger =
  | 'manual'       // richiede azione utente
  | 'automatic'    // sistema lo fa da solo
  | 'sla_breach'   // SLA engine lo triggera
  | 'timer'        // BullMQ job

/**
 * Vocabolario UNICO delle azioni che il motore dei workflow sa eseguire
 * (`runAction`). Esportato come valore perché serve anche a VALIDARE il dato:
 * una definizione con un'azione che il motore non conosce fa fallire la
 * transizione nominandola (B0-5), invece di essere ignorata in silenzio.
 * Non è il vocabolario delle automazioni (lib/actionExecutor.ts): quello è un
 * altro insieme, e la loro unificazione è un'ondata successiva.
 */
export const WORKFLOW_ACTION_TYPES = [
  'sla_start',
  'sla_stop',
  'sla_pause',
  'sla_resume',
  'notify',
  'publish_event',
  'schedule_job',
  'cancel_job',
  'notify_rule',
  'create_entity',
  'assign_to',
  'update_field',
  'call_webhook',
  'create_approval_request',
] as const

export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number]

/** `true` se il motore sa eseguire questo tipo di azione. */
export function isWorkflowActionType(type: unknown): type is WorkflowActionType {
  return typeof type === 'string' && (WORKFLOW_ACTION_TYPES as readonly string[]).includes(type)
}

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

export interface CreateApprovalRequestParams {
  title_template: string
  approver_role?: string
  approval_type?: 'any' | 'all' | 'majority'
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
  createApprovalRequest?: (params: {
    entityId:     string
    entityType:   string
    title:        string
    approverRole?: string
    approvalType?: string
  }) => Promise<string>
}

// ── Step / Transition / Definition ────────────────────────────────────────────

export interface WorkflowStepDef {
  id:           string
  name:         string
  label:        string
  type:         WorkflowStepType
  enterActions: WorkflowActionConfig[]
  exitActions:  WorkflowActionConfig[]
  /**
   * Proprietà aggiuntive persistite così come sono sul nodo WorkflowStep
   * (chiavi snake_case: is_initial, is_terminal, is_open, category,
   * on_enter_create, step_order). Lette da portale, reportAI e dagli hook
   * di ingresso step delle change: il seed deve poterle dichiarare.
   */
  metadata?:    Record<string, string | number | boolean | null>
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
  id:              string
  tenantId:        string
  name:            string
  entityType:      string
  changeSubtype?:  string | null
  version:         number
  active:          boolean
  steps:           WorkflowStepDef[]
  transitions:     WorkflowTransitionDef[]
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
  /**
   * Chi innesca: 'manual' = un utente, e può seguire SOLO archi manuali;
   * i trigger di sistema (automatic/timer/sla_breach) possono seguire
   * qualunque arco, perché il codice che li usa nomina lo step esplicitamente.
   */
  triggerType: WorkflowTrigger
  notes?:      string
  /** Se presente, l'istanza deve appartenere a questo tenant (difesa in profondità). */
  tenantId?:   string
}

export interface TransitionResult {
  success:    boolean
  instance:   WorkflowInstance
  execution:  WorkflowStepExecution
  actionsRun: WorkflowActionType[]
  error?:     string
  /**
   * Errors from step actions (sla_start, publish_event, timer scheduling, …)
   * that failed AFTER the transition was persisted. The transition itself
   * succeeded, but these side effects did NOT run — callers must surface them,
   * never discard them.
   */
  actionErrors?: string[]
}
