import type { ConfigurationItem, Team } from './ci.js'
import type { User } from './user.js'
import type { Problem } from './problem.js'
import type { Incident } from './incident.js'

export type ChangeType = 'standard' | 'normal' | 'emergency'
export type ChangeRisk = 'low' | 'medium' | 'high'
export type ChangeStatus =
  | 'draft'
  | 'review'
  | 'approved'
  | 'rejected'
  | 'in_progress'
  | 'completed'
  | 'failed'

export interface Change {
  // --- Stored on Neo4j ---
  id: string
  tenant_id: string
  title: string
  description?: string
  type: ChangeType
  risk: ChangeRisk
  status: ChangeStatus
  window_start: string
  window_end: string
  created_at: string
  updated_at: string

  // --- Populated at runtime by query (NOT stored on Neo4j) ---

  /** [:IMPACTS]->(:ConfigurationItem) */
  impacted_cis?: ConfigurationItem[]
  /** [:ASSIGNED_TO]->(:User) */
  assignee?: User
  /** [:RESOLVES]->(:Problem) */
  related_problem?: Problem
  /** <-[:CAUSED]-(:Incident) */
  caused_incidents?: Incident[]

  // NOTE: Team is imported via ci.ts — re-exported for convenience
  team?: Team
}
