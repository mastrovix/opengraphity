import type { Session } from 'neo4j-driver'

// Unica sorgente per i tipi di step: engine (timer_wait, sub_workflow), API e
// web (parallel_fork/join) usavano liste diverse dello stesso enum. Dall'ondata
// 10 vive in `@opengraphity/types`, che leggono anche il disegnatore e l'API:
// là accanto c'è scritto QUALI il motore esegue davvero.
import type { DomainEvent, WorkflowStepEnteredPayload, WorkflowStepType } from '@opengraphity/types'
export type { WorkflowStepType }

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
// The triggers that conclude a timed wait live with the step types in
// `@opengraphity/types` (26 Sep 2026): the API passes that read them must not
// have to load the engine. Re-exported here for the engine and its callers.
export { WAIT_EXIT_TRIGGERS } from '@opengraphity/types'

export const WORKFLOW_ACTION_TYPES = [
  'sla_start',
  'sla_stop',
  'sla_pause',
  'sla_resume',
  'notify',
  'publish_event',
  'notify_rule',
  'create_entity',
  'assign_to',
  'update_field',
  'call_webhook',
  'create_approval_request',
  'create_task',
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
  /** Obbligatorio per `entity_type: 'change'`: un valore del vocabolario `change_type` del cliente. */
  change_type?:    string
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

/**
 * I campi riservati di `update_field` stanno in `@opengraphity/types`
 * (`workflowFields.ts`) perché li leggono anche l'API in scrittura e il
 * **disegnatore** — e il web non dipende da questo pacchetto. Qui si
 * ri-esporta per i chiamanti del motore: una definizione sola.
 */
export { stepFieldRejection, isStepFieldWritable } from '@opengraphity/types'

/**
 * UN COMPITO DA FARE, creato entrando in un passo (20 set 2026).
 *
 * Nasce dalle richieste di servizio: «Nuovo portatile» approvata deve far
 * partire del lavoro vero — il Desk prepara la macchina, i Sistemi creano
 * l'utenza — e finché quel lavoro non è fatto la richiesta non è evasa.
 * L'azione è del MOTORE, quindi vale per qualunque entità: incident, problem
 * e change la ereditano senza che nessuno scriva una riga in più.
 *
 * `team_id` è la squadra scelta disegnando il workflow: il caso base, e il
 * più frequente («crea l'utenza» va sempre ai Sistemi). Le altre due strade
 * decise dal proprietario — la squadra che sta in un campo del modulo e
 * quella che supporta il CI scelto — arrivano nelle ondate 4 e 5, e sono
 * altri parametri accanto a questo.
 */
export interface CreateTaskParams {
  /** Il titolo del compito, con i segnaposto `{{campo}}` come gli altri template. */
  title_template: string
  /** Facoltativa: cosa c'è da fare, per chi lo trova in «I miei compiti». */
  description?:   string
  /** La squadra che lo deve fare, scelta disegnando il workflow. */
  team_id?:       string
  /**
   * …oppure il nome di un CAMPO del modulo da cui leggere la squadra. Il
   * campo può essere di due generi, e per chi disegna è la stessa domanda:
   *  - un campo SQUADRA → la squadra scelta nella risposta. È la strada per
   *    cui «Sede: Milano» finisce al Desk di Milano, col campo riempito a
   *    mano da chi smista o da una formula;
   *  - un campo CI → chi SUPPORTA il CI scelto. «Accesso ad applicazione»
   *    con Applicazione = App portale clienti manda il compito a chi la
   *    tiene su.
   *
   * Se ci sono sia questo sia `team_id` vince il campo: è il dato della
   * singola richiesta, e batte la scelta fatta una volta per tutte.
   */
  team_from_field?: string
  /** Fra quanti giorni scade. Vuoto = nessuna scadenza. */
  due_in_days?:   string | number
  /**
   * LA SEQUENZA: il titolo di un altro compito dello stesso passo. Finché
   * quello non è chiuso, questo sta fermo («in attesa»). Vuoto = parte
   * subito, ed è il caso normale — chi non usa le sequenze non se ne
   * accorge. Il proprietario l'ha chiesto così: «ci possono essere task in
   * sequenza e task in parallelo, dipende dalla service request».
   */
  after?:         string
}

export interface CallWebhookParams {
  url:               string
  method:            'GET' | 'POST' | 'PUT'
  headers?:          Record<string, string>
  payload_template?: string
}

/**
 * Chi deve approvare. Prima c'era solo il RUOLO: «tutti gli admin», o tutti
 * quelli di un ruolo — e per un catalogo servizi non basta, perché
 * l'approvazione di una spesa è del responsabile di budget, non di chi
 * amministra il prodotto (moduli del catalogo, ondata 3).
 *
 * I tre si possono combinare: l'insieme degli approvatori è l'UNIONE, senza
 * ripetizioni. Se nessuno dei tre è indicato vale il ruolo `admin`, come
 * prima.
 */
export interface CreateApprovalRequestParams {
  title_template: string
  approver_role?: string
  /**
   * Le persone che approvano, e le squadre (approvano i loro membri).
   *
   * DUE FORME, un solo lettore: una lista JSON quando i parametri li scrive
   * l'API, una stringa di id separati da virgola quando li scrive il
   * disegnatore — il suo editor tiene i parametri come `Record<string, string>`
   * e non può produrre un array. `approverIdList()` è l'unico posto che le
   * legge, così la differenza non si propaga.
   */
  approver_user_ids?: string[] | string
  approver_team_ids?: string[] | string
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
  /** Il passo che esegue l'azione e la sua posizione: servono al retry del webhook per rileggere gli header. */
  stepId?:          string
  /**
   * La posizione nella lista CONCATENATA `[…uscita, …ingresso]`: è quella che
   * il retry del webhook usa per rileggere gli header dal passo, e non si
   * tocca. NON è un'identità stabile dell'azione: dipende da quante azioni di
   * uscita ha il passo che si sta lasciando, quindi la stessa azione
   * d'ingresso cambia numero a seconda da dove si arriva. Chi ha bisogno di
   * riconoscere un'azione usa `actionPhase` + `actionPosition`.
   */
  actionIndex?:     number
  /** Se l'azione è fra quelle di USCITA dal passo lasciato o d'INGRESSO in quello nuovo. */
  actionPhase?:     'enter' | 'exit'
  /** La posizione dentro la PROPRIA lista: stabile, non dipende dall'altro passo. */
  actionPosition?:  number
  notes?:           string
  entityData:       Record<string, unknown>      // entity properties for template/condition eval
  isWebhookRetry?:  boolean
  /*
   * No callbacks any more (wave 7 · B1): the actions that write the graph are
   * done by the handlers registered in the process (stepActionHandlers.ts),
   * for every path. The context is who, the notes and the entity's data.
   */
}

// ── Step / Transition / Definition ────────────────────────────────────────────

/**
 * Etichette per lingua (giro nel browser del 14 set 2026, #22): `label` resta
 * l'etichetta di base, `labels` le traduzioni di quelle SPEDITE. Il tipo e le
 * funzioni stanno in @opengraphity/types.
 */
import type { LocalizedLabels } from '@opengraphity/types'
export type { LocalizedLabels }

export interface WorkflowStepDef {
  id:           string
  name:         string
  label:        string
  labels?:      LocalizedLabels
  type:         WorkflowStepType
  enterActions: WorkflowActionConfig[]
  exitActions:  WorkflowActionConfig[]
  /**
   * Proprietà aggiuntive persistite così come sono sul nodo WorkflowStep
   * (chiavi snake_case: is_initial, is_terminal, is_open, category,
   * on_enter_create, step_order, purpose). `purpose` è lo SCOPO del passo
   * (`WORKFLOW_STEP_PURPOSES` in @opengraphity/types): è quello che le regole
   * di dominio riconoscono, al posto del nome (B-4). Lette da portale, reportAI e dagli hook
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
  labels?:       LocalizedLabels
  condition:     string | null
  requiresInput: boolean
  inputField:    string | null
}

export interface WorkflowDefinition {
  id:              string
  tenantId:        string
  name:            string
  entityType:      string
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
  /**
   * Stato dell'ISTANZA (non del ticket): `completed` quando l'istanza entra in
   * un passo **terminale** (`is_terminal`, con ripiego su `type='end'`: una
   * nozione sola, la stessa di `workflowHelpers`), `cancelled` quando la
   * change viene annullata (`changeMutations`: lo scriveva già, fuori dal
   * vocabolario — B-20), `failed` per un'istanza che non può proseguire.
   */
  status:       'active' | 'completed' | 'cancelled' | 'failed'
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
  /**
   * Who signs the note on the ticket when it is not a person: the name of the
   * rule that asked for the transition (U-8). It travels with the step-entered
   * event, so the single note of an automatic assignment keeps it (D12).
   */
  actorLabel?: string | null
  /**
   * L'istanza DEVE appartenere a questo tenant. Era facoltativo («difesa in
   * profondità») e 8 chiamanti su 14 non lo passavano, quindi la query non
   * filtrava per tenant nella maggioranza dei cammini: la difesa dichiarata
   * era spenta, e un futuro chiamante che prendesse `instanceId` dall'input
   * dell'utente avrebbe ereditato il buco (revisione totale · E-31). Ora è
   * obbligatorio: chi chiama il motore sa per quale organizzazione lo fa.
   */
  tenantId:    string
}

/** Frase dell'errore per chi lo mostra: chiave i18n del web e parametri. */
export interface TransitionErrorI18n {
  key:     string
  params?: Record<string, string>
}

export interface TransitionResult {
  success:    boolean
  instance:   WorkflowInstance
  execution:  WorkflowStepExecution
  actionsRun: WorkflowActionType[]
  error?:     string
  errorI18n?: TransitionErrorI18n
  /**
   * LA TRANSIZIONE È STATA RIFIUTATA DA UNA GUARDIA, non è andata storta
   * (20 set 2026). Le due cose si trattano in modo opposto e finora si
   * distinguevano solo leggendo il messaggio:
   *
   *  - un ERRORE (config corrotta, condizione sconosciuta) si rilancia, e chi
   *    esegue in coda ritenta;
   *  - un RIFIUTO è una risposta: la condizione dice «non ancora». Ritentarla
   *    non serve — non dipende dal tempo ma da qualcuno che chiuda un
   *    compito o completi un assessment — e con i tentativi si esauriscono
   *    anche gli eventi, che finiscono marcati «lost».
   *
   * Con la guardia sui compiti il caso è diventato ordinario: un'escalation
   * da SLA su un arco guardato ritentava fino a perdere l'evento, e
   * l'incident che doveva escalare non escalava, in silenzio.
   */
  refusedByCondition?: string
  /**
   * Errors from step actions (sla_start, publish_event, timer scheduling, …)
   * that failed AFTER the transition was persisted. The transition itself
   * succeeded, but these side effects did NOT run — callers must surface them,
   * never discard them.
   */
  actionErrors?: string[]
}


/**
 * L'ingresso di un'istanza in un passo, detto a chi ascolta DOPO che la
 * transizione è persistita (`WorkflowEngine.onStepEntered`).
 *
 * Esiste perché il motore è l'unico punto da cui passa OGNI transizione —
 * manuale, automatica, da change, da regola, da timer — mentre gli eventi di
 * dominio li pubblicavano solo alcuni cammini: un problem risolto dalla sua
 * change o una richiesta chiusa dal workflow non avvisavano nessuno, e il loro
 * SLA restava aperto per sempre (giro del 14 set 2026).
 */
export interface StepEnteredInfo {
  tenantId:    string
  instanceId:  string
  entityType:  string
  entityId:    string
  fromStep:    string
  /** Il passo lasciato era quello iniziale: la prima presa in carico. */
  fromInitial: boolean
  toStep:      string
  category:    string | null
  terminal:    boolean
  enteredAt:   string
  actorId:     string
  triggerType: string
  /**
   * Le note della transizione, se chi l'ha chiesta ne ha messe. Servono a chi
   * scrive la nota interna sul ticket: era scritta solo dalla transizione
   * manuale dell'incident, quindi le transizioni automatiche non lasciavano
   * traccia nella storia (revisione totale · B-4).
   */
  notes?:      string | null
  /** Who signs the note when it is not a person (TransitionInput.actorLabel). */
  actorLabel?: string | null
  /**
   * The domain event of this entry (`workflow.step_entered`), already written
   * to the outbox in the transition's own transaction (wave 7 · B2): the
   * listener publishes THIS event, so that a process stopping between the
   * commit and the listener leaves it to the outbox repeater, not lost.
   */
  event:        DomainEvent<WorkflowStepEnteredPayload>
}

export type StepEnteredListener = (info: StepEnteredInfo) => Promise<void>
