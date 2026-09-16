/**
 * Domain-event contract shared by the publisher (apps/api, packages/workflow),
 * the consumers (packages/sla, packages/notifications, escalation consumer)
 * and the SLA scheduler. This is the ONLY thing the packages actually share:
 * the entity models that used to live next to it (Incident, Change, …) were
 * never imported and drifted from the real graph (D-21), so they are gone.
 *
 * The literal unions below describe the values carried in the payloads, not
 * the full domain enums (those live in the GraphQL schema / enum types).
 */

export interface DomainEvent<T = unknown> {
  id: string
  type: string
  tenant_id: string
  timestamp: string
  correlation_id: string
  actor_id: string
  payload: T
}

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical'
export type ChangeType       = 'standard' | 'normal' | 'emergency'
export type ChangeRisk       = 'low' | 'medium' | 'high'
export type CIStatus         = 'operational' | 'degraded' | 'down' | 'maintenance'
/**
 * Salute del CI derivata dal monitoraggio (`ci.health`), separata dal ciclo di
 * vita (`ci.status`: active/inactive/maintenance/decommissioned).
 */
export type CIHealth         = 'operational' | 'degraded' | 'down'
export type CIDependencyType = 'depends_on' | 'hosted_on' | 'connects_to' | 'backed_up_by' | 'protected_by'

// --- Incident ---

export interface IncidentCreatedPayload {
  id: string
  title: string
  severity: IncidentSeverity
  affected_ci_ids: string[]
}

export interface IncidentResolvedPayload {
  id: string
  resolved_at: string
  resolution_note?: string
}

export interface IncidentEscalatedPayload {
  id: string
  escalated_to_id: string
  reason: string
}

// --- Change ---

export interface ChangeCreatedPayload {
  id: string
  title: string
  type: ChangeType
  risk: ChangeRisk
  impacted_ci_ids: string[]
}

export interface ChangeApprovedPayload {
  id: string
  approved_by_id: string
  approved_at: string
}

export interface ChangeRejectedPayload {
  id: string
  rejected_by_id: string
  reason: string
}

export interface ChangeDeployedPayload {
  id: string
  deployed_at: string
  success: boolean
}

// --- Problem ---

/**
 * Il payload di `problem.created` **come viene davvero pubblicato** da
 * `problemService.publishProblemCreated`.
 *
 * Prima questo tipo dichiarava `impact: ProblemImpact` e
 * `affected_ci_ids: string[]`: due campi che nessuno ha mai spedito. Il motore
 * SLA faceva `event as DomainEvent<ProblemCreatedPayload>` e leggeva
 * `.impact` — sempre `undefined`, quindi nessun livello trovato e **nessuno
 * SLA creato per nessun problem, in nessun tenant**. Il cast è ciò che ha
 * tenuto in piedi la bugia per mesi; il test del motore se la costruiva da sé
 * (`impact: 'critical'`, un valore che non è nemmeno del vocabolario
 * dell'impatto) e quindi passava.
 *
 * `priority` è una stringa, non un'unione: la priorità è vocabolario DEL
 * CLIENTE e si rinomina dal Dizionario.
 */
export interface ProblemCreatedPayload {
  id: string
  title: string
  priority: string
  status: string
  assignedTo: string
}

export interface ProblemRootCauseIdentifiedPayload {
  id: string
  root_cause: string
}

export interface ProblemKnownErrorPayload {
  id: string
  workaround: string
}

export interface ProblemResolvedPayload {
  id: string
  resolved_at: string
  resolved_by_change_id: string
}

// --- Service Request ---

export interface RequestCreatedPayload {
  id: string
  title: string
  priority: string
  requested_by_id: string
}

export interface RequestApprovedPayload {
  id: string
  approved_by_id: string
  approved_at: string
}

export interface RequestRejectedPayload {
  id: string
  rejected_by_id: string
  reason: string
}

export interface RequestCompletedPayload {
  id: string
  completed_at: string
  fulfilled_by_id: string
}

// --- CI ---

/**
 * `ci.health_changed` — pubblicato da eventService.recomputeCIHealth quando
 * la salute derivata dal monitoraggio (`ci.health`) cambia. Non riguarda mai
 * `ci.status` (ciclo di vita). `id` e `ci_id` sono lo stesso valore: `id` è la
 * chiave che il dispatcher delle notifiche legge come entity_id, `ci_id` il
 * nome esplicito del contratto Event Management. `name` è il nome del CI: la
 * notifica dice «db-01 — down», non «ci 4d0c9e…» (revisione 2, D3.2).
 */
export interface CIHealthChangedPayload {
  id: string
  ci_id: string
  name: string
  previous_health: CIHealth | null
  new_health: CIHealth
}

// --- Servizi monitorati (mappa del servizio + albero d'impatto) ---

export type ServiceHealth = 'operational' | 'degraded' | 'down' | 'maintenance' | 'unknown'

/**
 * `service.health_changed` — pubblicato dal motore dei servizi monitorati
 * (apps/api services/serviceImpact/engine.ts) quando la salute calcolata di
 * una ServiceMap cambia. `id` e `map_id` sono lo stesso valore (`id` è la
 * chiave che il dispatcher delle notifiche legge come entity_id).
 */
export interface ServiceHealthChangedPayload {
  id: string
  map_id: string
  service_id: string
  name: string
  previous_health: ServiceHealth | null
  new_health: ServiceHealth
  impact_score: number
}

/**
 * `service.incident_opened` — pubblicato quando il monitoraggio apre l'incident
 * di un servizio (apps/api services/serviceImpact/incident.ts) perché la salute
 * ha raggiunto la soglia `open_incident_from` della mappa. Come per
 * `service.health_changed`, `id` e `map_id` sono lo stesso valore: l'entità di
 * questo evento è il SERVIZIO (l'incident è un suo dato), così le due notifiche
 * del servizio puntano alla stessa pagina.
 */
export interface ServiceIncidentOpenedPayload {
  id: string
  map_id: string
  service_id: string
  name: string
  incident_id: string
  incident_number: string
  health: ServiceHealth
  impact_score: number
}

// --- Event Management (allarmi dal monitoraggio) ---

export type MonitoringEventStatus   = 'firing' | 'resolved' | 'suppressed' | 'flapping'
export type MonitoringEventSeverity = 'info' | 'warning' | 'critical'

/** `event.received` (nuovo o ripetuto), `event.resolved`, `event.orphan` (nessun CI riconosciuto). */
export interface MonitoringEventPayload {
  id: string
  fingerprint: string
  title: string
  severity: MonitoringEventSeverity
  status: MonitoringEventStatus
  resource: string
  count: number
  ci_id: string | null
  source_id: string
  /** Sempre 'event': il dispatcher delle notifiche lo usa per il link. */
  entity_type: 'event'
  entity_id: string
}

export interface CIDependencyAddedPayload {
  from_id: string
  to_id: string
  type: CIDependencyType
}

// --- SLA ---

export interface SLAWarningPayload {
  entity_id: string
  entity_type: string
  minutes_remaining: number
  /** `resolve`: preavviso della risoluzione; `response`: la presa in carico è scaduta. */
  target: 'resolve' | 'response'
  /** Numero e titolo del ticket: il corpo della notifica dice di quale si tratta. */
  number: string
  title: string
  /** Gravità e stato veri del ticket (E-8); facoltativi per gli eventi già in coda. */
  severity?: string | null
  status?: string | null
}

export interface SLABreachedPayload {
  entity_id: string
  entity_type: string
  number: string
  title: string
  breached_at: string
  /**
   * La gravità e lo stato VERI del ticket (revisione totale · E-8): la card
   * Slack/Teams della violazione li scriveva cablati — «Severity: HIGH ·
   * Status: open» per qualunque incident, anche un critical in escalation.
   * Facoltativi: gli eventi già in coda prima del rimedio non li hanno.
   */
  severity?: string | null
  status?: string | null
}

// --- Ingresso in un passo di workflow (ondata 4, D-22) ----------------------

/**
 * Il suffisso del tipo di evento STABILE per l'ingresso in un passo:
 * `incident.step_entered`, `problem.step_entered`.
 *
 * ## Il difetto che chiude
 * Il tipo dell'evento era composto col NOME del passo
 * (`publishEvent('incident.' + stepName)`), e il nome del passo è
 * personalizzabile. Dopo una rinomina l'API pubblicava
 * `incident.lavorazione`: nessuna regola di notifica corrispondeva, nessun
 * webhook aveva quel tipo fra i suoi, e **niente lo diceva** — il dispatcher
 * usciva su `if (!rule) return`.
 *
 * ## Il contratto
 * Il nome del passo resta nel PAYLOAD (`step_name`, e con lui etichetta,
 * scopo, categoria e id): è un dettaglio del passo, non l'identità
 * dell'evento. L'identità è il tipo stabile, che una rinomina non tocca.
 *
 * Il tipo composto col nome continua a essere pubblicato come **alias** per
 * gli abbonamenti esistenti (regole di notifica dei tenant, webhook in
 * uscita): togliere quell'alias spegnerebbe in silenzio le 35 regole di
 * fabbrica e ogni regola già scritta, che è esattamente il difetto.
 */
export const STEP_ENTERED_SUFFIX = 'step_entered'

/**
 * L'evento generico del motore di workflow: un ingresso in un passo, con i
 * fatti del passo e SENZA il ticket. Non è l'evento di dominio dell'entità
 * (quello è `<entità>.step_entered`): le automazioni `on_transition` lo
 * consumano, le regole di notifica no.
 */

/** Il tipo stabile per l'entità: `incident` → `incident.step_entered`. */
export function stepEnteredEventType(entityType: string): string {
  return `${entityType}.${STEP_ENTERED_SUFFIX}`
}

/**
 * Vero se il tipo è un ingresso-in-un-passo stabile DI UN'ENTITÀ (qualunque).
 *
 * `workflow.step_entered` — l'evento generico del motore, che porta il passo e
 * non il ticket — finisce con lo stesso suffisso ma NON è di un'entità: il
 * dispatcher delle notifiche lo trattava come entità «workflow», cercava
 * regole per `workflow.<passo>`, non le trovava e scriveva un avviso a OGNI
 * transizione di qualunque ticket (revisione totale · C-3): rumore nei log e
 * un messaggio che diceva il falso.
 */
export function isStepEnteredEventType(eventType: string): boolean {
  if (eventType === WORKFLOW_STEP_ENTERED_EVENT) return false
  return eventType.endsWith(`.${STEP_ENTERED_SUFFIX}`)
}

/** L'entità di un tipo stabile (`incident.step_entered` → `incident`), null se non lo è. */
export function stepEnteredEntityType(eventType: string): string | null {
  if (!isStepEnteredEventType(eventType)) return null
  return eventType.slice(0, -(STEP_ENTERED_SUFFIX.length + 1)) || null
}

/**
 * Il tipo composto col nome del passo — l'ALIAS storico, mantenuto per gli
 * abbonamenti già scritti. Non usarlo per decidere niente: è un alias, non
 * un'identità.
 */
export function legacyStepEventType(entityType: string, stepName: string): string {
  return `${entityType}.${stepName}`
}

/**
 * I fatti del passo che ogni evento stabile porta con sé. `step_purpose` è
 * `null` quando il cliente non ha dichiarato lo scopo: è legittimo, e non si
 * indovina dal nome.
 */
export interface StepEnteredFacts {
  step_id:       string
  step_name:     string
  step_label:    string
  step_purpose:  string | null
  step_category: string | null
}


/**
 * L'ingresso di un ticket in un passo, pubblicato per OGNI transizione del
 * motore di workflow (manuale, automatica, da change, da regola, da timer).
 *
 * Non è per le notifiche (quelle hanno `<entità>.step_entered` e gli alias):
 * è il fatto che serve a chi deve sapere che un ticket è stato preso in carico
 * o è concluso, qualunque cammino l'abbia portato lì — lo SLA prima di tutti.
 */
export const WORKFLOW_STEP_ENTERED_EVENT = 'workflow.step_entered'

/**
 * Un ticket assegnato a un gruppo (revisione del 14 set 2026 · SL-10): la
 * policy SLA che dipende dal team si sceglieva solo alla creazione, quando il
 * team non c'è quasi mai. Il motore SLA riconsidera la policy qui.
 */
export const TICKET_TEAM_ASSIGNED_EVENT = 'ticket.team_assigned'

/**
 * La relazione ticket → CI impattato, per tipo di ticket — revisione del 14 set
 * 2026 · F12. I tre nomi sono storici e restano (rinominarli vuol dire
 * riscrivere dati e ogni query degli allarmi, dei servizi e dei report); qui
 * sono in un posto solo, così chi legge «i ticket di un CI» non ne dimentica
 * uno — il dettaglio del CI mostrava incident e change, ma non i problem.
 */
export const TICKET_CI_RELATIONSHIP = {
  incident: 'AFFECTED_BY',
  problem:  'AFFECTS',
  change:   'AFFECTS_CI',
  /** Revisione del 15 set 2026 · CM-8: le richieste di servizio si collegano ai CI (prima non potevano). */
  service_request: 'CONCERNS_CI',
} as const

/** I tipi di ticket che si collegano ai CI, e per cui l'amministratore può escludere dei tipi di CI. */
export type TicketCIType = keyof typeof TICKET_CI_RELATIONSHIP
export const TICKET_CI_TYPES = Object.keys(TICKET_CI_RELATIONSHIP) as readonly TicketCIType[]

export function isTicketCIType(value: unknown): value is TicketCIType {
  return typeof value === 'string' && (TICKET_CI_TYPES as readonly string[]).includes(value)
}

/** Tutte, per un pattern Cypher `-[:A|B|C|D]->`. */
export const TICKET_CI_RELATIONSHIPS_PATTERN = Object.values(TICKET_CI_RELATIONSHIP).join('|')

export interface TicketTeamAssignedPayload {
  entity_type: 'incident' | 'problem' | 'service_request' | 'change'
  entity_id:   string
  team_id:     string
}

export interface WorkflowStepEnteredPayload {
  entity_type:  string
  entity_id:    string
  from_step:    string
  /** Il passo lasciato era l'iniziale: la prima presa in carico. */
  from_initial: boolean
  step_name:    string
  step_category: string | null
  step_terminal: boolean
  entered_at:   string
  trigger_type: string
}


/**
 * I tipi di ticket che hanno uno SLA: quelli per cui il motore SLA crea e
 * chiude l'orologio. La change NON c'è: la pagina SLA Policies la offriva, ma
 * nessun evento di change arriva al motore, e una policy per le change non si
 * applicava mai (giro del 14 set 2026).
 */
export const SLA_ENTITY_TYPES = ['incident', 'problem', 'service_request'] as const

/**
 * Il preavviso SLA di fabbrica: quanti minuti prima della scadenza di
 * risoluzione parte `sla.warning`. Era una costante nello scheduler, uguale per
 * tutti; ora è un campo della policy (revisione del 14 set 2026 · NT-8/F6) e
 * questo è solo il valore con cui nascono le policy e con cui la migrazione ha
 * valorizzato quelle esistenti.
 */
export const DEFAULT_SLA_WARNING_MINUTES = 30
export type SlaEntityType = typeof SLA_ENTITY_TYPES[number]

/**
 * I tipi che hanno una categoria da cui una policy SLA può dipendere. Erano i
 * soli incident; ora anche problem (categoria del Dizionario) e richieste di
 * servizio (la categoria della voce del catalogo da cui nascono) — verifica
 * «Cosa resta cablato», ondata 2.
 */
export const SLA_CATEGORY_ENTITY_TYPES: readonly SlaEntityType[] = ['incident', 'problem', 'service_request']
