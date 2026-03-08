import type { ConfigurationItem, Team } from './ci.js'
import type { User } from './user.js'
import type { Problem } from './problem.js'

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical'
export type IncidentStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export interface Incident {
  // --- Stored on Neo4j ---
  id: string
  tenant_id: string
  title: string
  description?: string
  severity: IncidentSeverity
  status: IncidentStatus
  created_at: string
  updated_at: string
  resolved_at?: string

  // --- Populated at runtime by query (NOT stored on Neo4j) ---

  /** [:AFFECTED_BY]->(:ConfigurationItem) */
  affected_cis?: ConfigurationItem[]
  /** [:ASSIGNED_TO]->(:User) */
  assignee?: User
  /** [:ASSIGNED_TO]->(:Team) */
  team?: Team
  /** [:CAUSED_BY]->(:Problem) */
  caused_by?: Problem
}
