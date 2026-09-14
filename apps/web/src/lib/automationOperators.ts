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

/**
 * Participi passati, perché servono UNA frase: l'anteprima compone «Quando un
 * Incident viene …». `on_timer` è «creato» di proposito — un trigger a timer
 * scatta alla creazione e l'anteprima aggiunge «dopo N minuti» da sé.
 *
 * Per una TENDINA non vanno bene («viene dopo timer» è una frase, «dopo
 * timer» è una voce di menu): quelle sono `EVENT_OPTION_KEYS`.
 */
export const EVENT_PARTICIPLE_KEYS: Record<string, string> = {
  on_create:    'automation.eventParticiple.onCreate',
  on_update:    'automation.eventParticiple.onUpdate',
  on_timer:     'automation.eventParticiple.onCreate',
  on_sla_breach: 'automation.eventParticiple.onSlaBreach',
  on_field_change: 'automation.eventParticiple.onFieldChange',
  on_transition: 'automation.eventParticiple.onTransition',
}

export function eventParticipleKey(eventType: string): string {
  return lookupOrError(EVENT_PARTICIPLE_KEYS, eventType, 'EVENT_PARTICIPLE_KEYS', `?${eventType}`)
}

/**
 * Gli stessi eventi come VOCI DI MENU, in un posto solo.
 *
 * Il difetto (terza revisione, visto nel browser): la pagina dei trigger
 * teneva una sua copia di queste etichette e mostrava «creato»,
 * «aggiornato»…; la pagina delle business rule non ne aveva nessuna e
 * mostrava `on_create`, `on_update`, `on_transition` — il nome interno, nella
 * tendina, all'amministratore. Due pagine gemelle, lo stesso vocabolario,
 * due rese diverse.
 */
export const EVENT_OPTION_KEYS: Record<string, string> = {
  on_create:    'automation.eventOption.onCreate',
  on_update:    'automation.eventOption.onUpdate',
  on_timer:     'automation.eventOption.onTimer',
  on_sla_breach: 'automation.eventOption.onSlaBreach',
  on_field_change: 'automation.eventOption.onFieldChange',
  on_transition: 'automation.eventOption.onTransition',
}

export function eventOptionKey(eventType: string): string {
  return lookupOrError(EVENT_OPTION_KEYS, eventType, 'EVENT_OPTION_KEYS', `?${eventType}`)
}


export const FIELD_TYPE_KEYS: Record<string, string> = {
  string: 'automation.fieldType.string', number: 'automation.fieldType.number',
  date:   'automation.fieldType.date',   boolean: 'automation.fieldType.boolean',
  enum:   'automation.fieldType.enum',   user:    'automation.fieldType.user',
  team:   'automation.fieldType.team',
}

export function fieldTypeKey(fieldType: string): string {
  return lookupOrError(FIELD_TYPE_KEYS, fieldType, 'FIELD_TYPE_KEYS', `?${fieldType}`)
}

// ── Operatori (vocabolario 1: auto-trigger / business rule) ─────────────────

export type AutomationOperator =
  | 'equals' | 'not_equals' | 'contains'
  | 'greater_than' | 'less_than'
  | 'is_null' | 'is_not_null'

/**
 * `labelKey` e una CHIAVE i18n, non un'etichetta: il vocabolario vive qui, la
 * lingua la decide il client (convenzione: un nome che finisce in `Key` e una
 * chiave). `=`, `>` e `<` restano segni: non c'e niente da tradurre.
 */
export interface OperatorOption { value: AutomationOperator; labelKey: string }

const EQ:  OperatorOption = { value: 'equals',       labelKey: 'automation.operator.equals' }
const NE:  OperatorOption = { value: 'not_equals',   labelKey: 'automation.operator.notEquals' }
const CT:  OperatorOption = { value: 'contains',     labelKey: 'automation.operator.contains' }
const GT:  OperatorOption = { value: 'greater_than', labelKey: 'automation.operator.greaterThan' }
const LT:  OperatorOption = { value: 'less_than',    labelKey: 'automation.operator.lessThan' }
const NUL: OperatorOption = { value: 'is_null',      labelKey: 'automation.operator.isNull' }
const NN:  OperatorOption = { value: 'is_not_null',  labelKey: 'automation.operator.isNotNull' }

export const ALL_OPERATORS: OperatorOption[] = [EQ, NE, CT, GT, LT, NUL, NN]

export const OPERATORS_BY_FIELD_TYPE: Record<string, OperatorOption[]> = {
  enum:    [EQ, NE, NUL, NN],
  string:  [EQ, NE, CT, NUL, NN],
  number:  [EQ, NE, GT, LT, NUL, NN],
  date:    [EQ, NE, { ...GT, labelKey: 'automation.operator.after' }, { ...LT, labelKey: 'automation.operator.before' }, NUL, NN],
  boolean: [EQ, NUL, NN],
  user:    [EQ, NE, NUL, NN],
  team:    [EQ, NE, NUL, NN],
}

export function operatorsForFieldType(fieldType: string): OperatorOption[] {
  return lookupOrError(OPERATORS_BY_FIELD_TYPE, fieldType, 'OPERATORS_BY_FIELD_TYPE', ALL_OPERATORS)
}

export const OPERATOR_KEYS: Record<string, string> = Object.fromEntries(ALL_OPERATORS.map((o) => [o.value, o.labelKey]))

export function operatorKey(op: string): string {
  return lookupOrError(OPERATOR_KEYS, op, 'OPERATOR_KEYS', `?${op}`)
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
  if (!w) throw new Error(`[automationOperators] UI operator that does not map onto a workflow one: "${op}"`)
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

export const AUTOMATION_ACTION_KEYS: Record<string, string> = {
  set_field:           'automation.action.setField',
  assign_team:         'automation.action.assignTeam',
  assign_user:         'automation.action.assignUser',
  transition_workflow: 'automation.action.transitionWorkflow',
  create_notification: 'automation.action.createNotification',
  create_comment:      'automation.action.createComment',
  set_priority:        'automation.action.setPriority',
  execute_script:      'automation.action.executeScript',
  call_webhook:        'automation.action.callWebhook',
  set_sla:             'automation.action.setSla',
}

export const AUTOMATION_ACTION_TYPES = Object.keys(AUTOMATION_ACTION_KEYS)

export function automationActionKey(type: string): string {
  return lookupOrError(AUTOMATION_ACTION_KEYS, type, 'AUTOMATION_ACTION_KEYS', `?${type}`)
}

// ── Azioni (vocabolario 2: packages/workflow WorkflowActionType) ────────────

/** Tipi selezionabili nel pannello step (notify_rule ha una sua tab dedicata). */
export const WORKFLOW_STEP_ACTION_TYPES = [
  'sla_start', 'sla_stop', 'schedule_job', 'cancel_job',
  'create_entity', 'assign_to', 'update_field', 'call_webhook', 'create_approval_request',
] as const

export type WorkflowStepActionType = typeof WORKFLOW_STEP_ACTION_TYPES[number]
