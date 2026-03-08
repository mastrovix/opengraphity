import type { CIDependencyType, CIStatus } from './ci.js'
import type { IncidentSeverity } from './incident.js'
import type { ChangeType, ChangeRisk } from './change.js'
import type { ProblemImpact } from './problem.js'

export interface DomainEvent<T = unknown> {
  id: string
  type: string
  tenant_id: string
  timestamp: string
  correlation_id: string
  actor_id: string
  payload: T
}

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

export interface CIStatusChangedPayload {
  id: string
  previous_status: CIStatus
  new_status: CIStatus
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
