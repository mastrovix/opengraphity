import type { ConfigurationItem } from './ci.js'
import type { Incident } from './incident.js'
import type { Change } from './change.js'

export type ProblemStatus = 'open' | 'in_analysis' | 'known_error' | 'resolved' | 'closed'
export type ProblemImpact = 'low' | 'medium' | 'high' | 'critical'

export interface Problem {
  // --- Stored on Neo4j ---
  id: string
  tenant_id: string
  title: string
  description?: string
  status: ProblemStatus
  impact: ProblemImpact
  root_cause?: string
  workaround?: string
  created_at: string
  updated_at: string
  resolved_at?: string

  // --- Populated at runtime by query (NOT stored on Neo4j) ---

  /** [:AFFECTS]->(:ConfigurationItem) */
  affected_cis?: ConfigurationItem[]
  /** <-[:CAUSED_BY]-(:Incident) */
  related_incidents?: Incident[]
  /** [:RESOLVED_BY]->(:Change) */
  resolved_by?: Change
}
