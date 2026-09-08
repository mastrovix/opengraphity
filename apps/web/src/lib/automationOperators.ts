/**
 * Vocabolario UNICO di operatori e azioni dell'automazione.
 *
 * Due motori distinti nel backend, due vocaboli persistiti diversi:
 *
 *  1. Auto-trigger / business rule (`apps/api/src/lib/conditionEvaluator.ts`,
 *     `actionExecutor.ts`): operatori `equals | not_equals | is_null |
 *     is_not_null | greater_than | less_than | contains`; azioni `set_field,
 *     assign_team, …`.
 *  2. Azioni degli step di workflow (`packages/workflow/src/actions.ts`,
 *     `types.ts`): operatori `eq | ne | gt | lt | gte | lte | in | not_in |
 *     contains | is_null | is_not_null`; azioni `sla_start, schedule_job, …`.
 *
 * Il formato SALVATO nel DB non cambia (nessuna migrazione): l'UI condivisa
 * parla il vocabolario 1 e, per gli step di workflow, un adapter esplicito
 * (`toWorkflowOperator` / `fromWorkflowOperator`) converte al confine.
 * Un operatore fuori vocabolario è un errore, non un passthrough.
 */
import { lookupOrError } from '@/lib/tokens'

// ── Entità ITIL vs CMDB ─────────────────────────────────────────────────────

export const ITIL_ENTITIES: ReadonlySet<string> = new Set(['incident', 'problem', 'change', 'service_request'])

export function isITILEntity(entityType: string): boolean {
  return ITIL_ENTITIES.has(entityType)
}

export const ENTITY_LABELS: Record<string, string> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'Service Request',
}

export const EVENT_LABELS: Record<string, string> = {
  on_create: 'creato', on_update: 'aggiornato', on_timer: 'creato',
  on_sla_breach: 'in breach SLA', on_field_change: 'modificato',
  on_transition: 'transizionato',
}

export const FIELD_TYPE_LABELS: Record<string, string> = {
  string: 'testo', number: 'numero', date: 'data', boolean: 'booleano', enum: 'enum',
  user: 'utente', team: 'team',
}

export function fieldTypeLabel(fieldType: string): string {
  return lookupOrError(FIELD_TYPE_LABELS, fieldType, 'FIELD_TYPE_LABELS', `?${fieldType}`)
}

// ── Operatori (vocabolario 1: auto-trigger / business rule) ─────────────────

export type AutomationOperator =
  | 'equals' | 'not_equals' | 'contains'
  | 'greater_than' | 'less_than'
  | 'is_null' | 'is_not_null'

export interface OperatorOption { value: AutomationOperator; label: string }

const EQ:  OperatorOption = { value: 'equals',       label: '=' }
const NE:  OperatorOption = { value: 'not_equals',   label: '≠' }
const CT:  OperatorOption = { value: 'contains',     label: 'contiene' }
const GT:  OperatorOption = { value: 'greater_than', label: '>' }
const LT:  OperatorOption = { value: 'less_than',    label: '<' }
const NUL: OperatorOption = { value: 'is_null',      label: 'è nullo' }
const NN:  OperatorOption = { value: 'is_not_null',  label: 'non è nullo' }

export const ALL_OPERATORS: OperatorOption[] = [EQ, NE, CT, GT, LT, NUL, NN]

export const OPERATORS_BY_FIELD_TYPE: Record<string, OperatorOption[]> = {
  enum:    [EQ, NE, NUL, NN],
  string:  [EQ, NE, CT, NUL, NN],
  number:  [EQ, NE, GT, LT, NUL, NN],
  date:    [EQ, NE, { ...GT, label: 'dopo' }, { ...LT, label: 'prima' }, NUL, NN],
  boolean: [EQ, NUL, NN],
  user:    [EQ, NE, NUL, NN],
  team:    [EQ, NE, NUL, NN],
}

export function operatorsForFieldType(fieldType: string): OperatorOption[] {
  return lookupOrError(OPERATORS_BY_FIELD_TYPE, fieldType, 'OPERATORS_BY_FIELD_TYPE', ALL_OPERATORS)
}

export const OPERATOR_LABELS: Record<string, string> = Object.fromEntries(ALL_OPERATORS.map((o) => [o.value, o.label]))

export function operatorLabel(op: string): string {
  return lookupOrError(OPERATOR_LABELS, op, 'OPERATOR_LABELS', `?${op}`)
}

/** Operatori senza valore (is_null / is_not_null). */
export const NO_VALUE_OPERATORS: ReadonlySet<string> = new Set(['is_null', 'is_not_null'])

// ── Operatori (vocabolario 2: step di workflow) + adapter ───────────────────

export type WorkflowStepOperator =
  | 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'in' | 'not_in' | 'contains'
  | 'is_null' | 'is_not_null'

const TO_WORKFLOW: Record<AutomationOperator, WorkflowStepOperator> = {
  equals: 'eq', not_equals: 'ne', greater_than: 'gt', less_than: 'lt',
  contains: 'contains', is_null: 'is_null', is_not_null: 'is_not_null',
}

const FROM_WORKFLOW: Partial<Record<WorkflowStepOperator, AutomationOperator>> = {
  eq: 'equals', ne: 'not_equals', gt: 'greater_than', lt: 'less_than',
  contains: 'contains', is_null: 'is_null', is_not_null: 'is_not_null',
}

/** UI (equals…) → formato persistito negli step (eq…). Lancia su operatore sconosciuto. */
export function toWorkflowOperator(op: string): WorkflowStepOperator {
  const w = TO_WORKFLOW[op as AutomationOperator]
  if (!w) throw new Error(`[automationOperators] operatore UI non mappabile su workflow: "${op}"`)
  return w
}

/**
 * Formato persistito (eq…) → UI. `gte/lte/in/not_in` non hanno equivalente
 * nell'editor condiviso: vengono restituiti come `unsupported` e l'editor li
 * mostra come errore invece di riscriverli in silenzio.
 */
export function fromWorkflowOperator(op: string): { ok: true; value: AutomationOperator } | { ok: false; raw: string } {
  const a = FROM_WORKFLOW[op as WorkflowStepOperator]
  return a ? { ok: true, value: a } : { ok: false, raw: op }
}

// ── Azioni (vocabolario 1: actionExecutor) ──────────────────────────────────

export const AUTOMATION_ACTION_LABELS: Record<string, string> = {
  set_field: 'Imposta campo', assign_team: 'Assegna team', assign_user: 'Assegna utente',
  transition_workflow: 'Transizione', create_notification: 'Notifica',
  create_comment: 'Commento', set_priority: 'Imposta priorità',
  execute_script: 'Esegui script', call_webhook: 'Chiama webhook', set_sla: 'Imposta SLA',
}

export const AUTOMATION_ACTION_TYPES = Object.keys(AUTOMATION_ACTION_LABELS)

export function automationActionLabel(type: string): string {
  return lookupOrError(AUTOMATION_ACTION_LABELS, type, 'AUTOMATION_ACTION_LABELS', `?${type}`)
}

// ── Azioni (vocabolario 2: packages/workflow WorkflowActionType) ────────────

/** Tipi selezionabili nel pannello step (notify_rule ha una sua tab dedicata). */
export const WORKFLOW_STEP_ACTION_TYPES = [
  'sla_start', 'sla_stop', 'schedule_job', 'cancel_job',
  'create_entity', 'assign_to', 'update_field', 'call_webhook', 'create_approval_request',
] as const

export type WorkflowStepActionType = typeof WORKFLOW_STEP_ACTION_TYPES[number]
