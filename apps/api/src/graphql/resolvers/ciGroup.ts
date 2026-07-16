/**
 * Dynamic CI Group membership resolution (ServiceNow-style).
 *
 * A DynamicCIGroup CI aggregates CIs of any type:
 *  - membershipType 'manual'  → members are the HAS_MEMBER outgoing relationships
 *  - membershipType 'dynamic' → members are computed live from the criteria*
 *    fields (CI types whitelist, environment, status, name substring)
 *
 * Groups of groups are not supported in v1: DynamicCIGroup nodes are always
 * excluded from dynamic results.
 */
import { withSession, mapCI, ciTypeFromLabels, runQuery, runQueryOne } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'
import { TYPE_TO_LABEL, ALL_CI_LABELS } from '../../lib/ciLabels.js'
import { NotFoundError } from '../../lib/errors.js'

const GROUP_LABEL = 'DynamicCIGroup'

/** Max members returned for a dynamic group (safety valve on broad criteria). */
const MEMBERS_LIMIT = 500

/** Group property, tolerating both snake_case (canonical) and camelCase keys. */
function prop(props: Props, snake: string, camel: string): string | null {
  const v = props[snake] ?? props[camel]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/**
 * CSV of CI type names → deduped Neo4j labels via the TYPE_TO_LABEL whitelist.
 * Unknown type names are silently ignored (they cannot inject Cypher).
 * DynamicCIGroup itself is never a valid member label.
 */
export function criteriaTypesToLabels(csv: string | null): string[] {
  const requested = (csv ?? '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  const labels = requested
    .map(t => TYPE_TO_LABEL[t])
    .filter((l): l is string => Boolean(l) && l !== GROUP_LABEL)
  return [...new Set(labels)]
}

async function ciGroupMembers(_: unknown, args: { groupId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const group = await runQueryOne<{ props: Props }>(session,
      `MATCH (g:${GROUP_LABEL} {id: $groupId, tenant_id: $tenantId})
       RETURN properties(g) AS props`,
      { groupId: args.groupId, tenantId: ctx.tenantId },
    )
    if (!group) throw new NotFoundError('DynamicCIGroup', args.groupId)

    const membershipType = prop(group.props, 'membership_type', 'membershipType') ?? 'manual'

    let rows: { props: Props; nodeLabels: string[] }[]

    if (membershipType === 'dynamic') {
      // Build the member query from the criteria fields.
      const typeLabels = criteriaTypesToLabels(prop(group.props, 'criteria_ci_types', 'criteriaCiTypes'))
      const memberLabels = typeLabels.length > 0
        ? typeLabels
        : ALL_CI_LABELS.filter(l => l !== GROUP_LABEL)
      const labelPredicate = '(' + memberLabels.map(l => `m:${l}`).join(' OR ') + ')'

      const params: Record<string, unknown> = {
        tenantId:     ctx.tenantId,
        environment:  prop(group.props, 'criteria_environment',   'criteriaEnvironment'),
        status:       prop(group.props, 'criteria_status',        'criteriaStatus'),
        nameContains: prop(group.props, 'criteria_name_contains', 'criteriaNameContains'),
        limit:        MEMBERS_LIMIT,
      }
      rows = await runQuery<{ props: Props; nodeLabels: string[] }>(session,
        `MATCH (m {tenant_id: $tenantId})
         WHERE ${labelPredicate}
           AND NOT m:${GROUP_LABEL}
           AND ($environment IS NULL OR m.environment = $environment)
           AND ($status IS NULL OR m.status = $status)
           AND ($nameContains IS NULL OR toLower(m.name) CONTAINS toLower($nameContains))
         RETURN properties(m) AS props, labels(m) AS nodeLabels
         ORDER BY m.name ASC LIMIT toInteger($limit)`,
        params,
      )
    } else {
      // Manual membership: HAS_MEMBER relationships toward any known CI label.
      const labelPredicate = '(' + ALL_CI_LABELS.map(l => `m:${l}`).join(' OR ') + ')'
      rows = await runQuery<{ props: Props; nodeLabels: string[] }>(session,
        `MATCH (g:${GROUP_LABEL} {id: $groupId, tenant_id: $tenantId})-[:HAS_MEMBER]->(m)
         WHERE ${labelPredicate} AND m.tenant_id = $tenantId
         RETURN properties(m) AS props, labels(m) AS nodeLabels
         ORDER BY m.name ASC`,
        { groupId: args.groupId, tenantId: ctx.tenantId },
      )
    }

    return rows.map((r) => {
      r.props['type'] = ciTypeFromLabels(r.nodeLabels)
      return mapCI(r.props)
    })
  })
}

export const ciGroupResolvers = {
  Query: { ciGroupMembers },
}
