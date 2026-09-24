/**
 * What the reader may do on a ticket of one type, as the API decides it.
 *
 * Review of 23 Sep 2026: the ticket pages showed Edit, Declare major, the
 * workflow transitions, assignment, CIs and links to read-only roles, and
 * every one ended in a permission error. The four detail pages and their lists
 * ask this one hook, so they cannot drift apart from each other or from
 * `apps/api/src/lib/operationPermissions.ts`:
 *  - `canWrite` — the type's own `.write`: create, edit, move through the
 *    workflow, assign, the type's own CI links;
 *  - `canWork`  — `ticket.work`: affected CIs, related tickets, watchers,
 *    comments and custom fields, on every type.
 * Both are false while the user is still being read.
 */
import type { Permission } from '@opengraphity/types'
import { useMe } from './useMe'

export type TicketKind = 'incident' | 'problem' | 'change' | 'service_request'

export const TICKET_WRITE_PERMISSION: Record<TicketKind, Permission> = {
  incident:        'incident.write',
  problem:         'problem.write',
  change:          'change.write',
  service_request: 'request.write',
}

export function useTicketRights(kind: TicketKind): { canWrite: boolean; canWork: boolean } {
  const { can } = useMe()
  return { canWrite: can(TICKET_WRITE_PERMISSION[kind]), canWork: can('ticket.work') }
}
