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
export type ProblemImpact    = 'low' | 'medium' | 'high' | 'critical'
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

export interface ProblemCreatedPayload {
  id: string
  title: string
  impact: ProblemImpact
  affected_ci_ids: string[]
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
}

export interface SLABreachedPayload {
  entity_id: string
  entity_type: string
  breached_at: string
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

/** Il tipo stabile per l'entità: `incident` → `incident.step_entered`. */
export function stepEnteredEventType(entityType: string): string {
  return `${entityType}.${STEP_ENTERED_SUFFIX}`
}

/** Vero se il tipo è un ingresso-in-un-passo stabile (qualunque entità). */
export function isStepEnteredEventType(eventType: string): boolean {
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
