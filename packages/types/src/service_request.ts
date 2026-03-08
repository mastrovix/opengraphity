import type { User, } from './user.js'
import type { Team } from './ci.js'

export type ServiceRequestStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'in_fulfillment'
  | 'completed'
  | 'cancelled'

export type ServiceRequestPriority = 'low' | 'medium' | 'high'

export interface ServiceRequest {
  // --- Stored on Neo4j ---
  id: string
  tenant_id: string
  title: string
  description?: string
  status: ServiceRequestStatus
  priority: ServiceRequestPriority
  due_date?: string
  created_at: string
  updated_at: string
  completed_at?: string

  // --- Populated at runtime by query (NOT stored on Neo4j) ---

  /** [:REQUESTED_BY]->(:User) */
  requested_by?: User
  /** [:ASSIGNED_TO]->(:User) */
  assignee?: User
  /** [:FULFILLED_BY]->(:Team) */
  fulfilled_by?: Team
}
