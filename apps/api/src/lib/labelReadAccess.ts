/**
 * WHICH NODES A ROLE MAY READ, BY LABEL (review of 23 Sep 2026, wave 2).
 *
 * Roles are per area and per ticket type (owner's decision, 15 Sep 2026): a
 * role may read requests and not changes, or tickets and not the CMDB. The
 * GraphQL operations check it; the paths that read the graph by LABEL did
 * not. A report section rooted at Change, or a question to the report AI
 * about incidents, returned what the role could not open anywhere else.
 *
 * This module says, for a set of permissions, which labels are closed: each
 * ticket type without its read permission, and every CI label without
 * cmdb.read (the labels of the tenant's own CI types included).
 */
import type { Permission } from '@opengraphity/types'
import { ciLabelsForTenant } from './ciLabelsForTenant.js'

const LABEL_READ_PERMISSION: Readonly<Record<string, Permission>> = {
  Incident:       'incident.read',
  Problem:        'problem.read',
  Change:         'change.read',
  ServiceRequest: 'request.read',
  KBArticle:      'kb.read',
}

const CMDB_READ: Permission = 'cmdb.read'

/** The labels these permissions may not read, in the tenant (its CI types included). */
export async function labelsClosedTo(tenantId: string, permissions: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const closed = new Set<string>()
  for (const [label, permission] of Object.entries(LABEL_READ_PERMISSION)) {
    if (!permissions.has(permission)) closed.add(label)
  }
  if (!permissions.has(CMDB_READ)) {
    closed.add('ConfigurationItem')
    for (const label of await ciLabelsForTenant(tenantId)) closed.add(label)
  }
  return closed
}
