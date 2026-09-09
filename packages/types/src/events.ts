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
 * nome esplicito del contratto Event Management.
 */
export interface CIHealthChangedPayload {
  id: string
  ci_id: string
  previous_health: CIHealth | null
  new_health: CIHealth
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
