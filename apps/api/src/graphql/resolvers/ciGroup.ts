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
import { ciLabelsForTenant } from '../../lib/ciLabelsForTenant.js'
import { ciLabelsForTypeNames } from '../../lib/ciTypeNameToLabel.js'
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
 * CSV dei nomi dei tipi CI → etichette Neo4j **del metamodello di questo
 * cliente** (deduplicate, DynamicCIGroup mai un membro valido).
 *
 * ## Il difetto (A-9)
 * Prima la traduzione passava da `TYPE_TO_LABEL` e i nomi ignoti erano
 * «silently ignored»: un gruppo con criterio «solo load_balancer» restava con
 * zero etichette, cadeva nel ramo «nessun criterio di tipo» e restituiva i CI
 * di **tutti** i tipi — l'opposto di quello che l'utente aveva chiesto, senza
 * un errore né un log. Ora un tipo che questo cliente non ha **ferma la
 * lettura del gruppo**, col nome del tipo e i tipi ammessi nel messaggio.
 */
export async function criteriaTypesToLabels(tenantId: string, csv: string | null): Promise<string[]> {
  const requested = (csv ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
  const labels = await ciLabelsForTypeNames(tenantId, requested, 'criteri del gruppo dinamico (criteriaCiTypes)')
  return labels.filter(l => l !== GROUP_LABEL)
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
    let total: number

    if (membershipType === 'dynamic') {
      // Build the member query from the criteria fields.
      const typeLabels = await criteriaTypesToLabels(ctx.tenantId, prop(group.props, 'criteria_ci_types', 'criteriaCiTypes'))
      const memberLabels = typeLabels.length > 0
        ? typeLabels
        : (await ciLabelsForTenant(ctx.tenantId)).filter(l => l !== GROUP_LABEL)
      const labelPredicate = '(' + memberLabels.map(l => `m:${l}`).join(' OR ') + ')'

      const params: Record<string, unknown> = {
        tenantId:     ctx.tenantId,
        environment:  prop(group.props, 'criteria_environment',   'criteriaEnvironment'),
        status:       prop(group.props, 'criteria_status',        'criteriaStatus'),
        nameContains: prop(group.props, 'criteria_name_contains', 'criteriaNameContains'),
        limit:        MEMBERS_LIMIT,
      }
      const criteriaWhere = `
         WHERE ${labelPredicate}
           AND NOT m:${GROUP_LABEL}
           AND ($environment IS NULL OR m.environment = $environment)
           AND ($status IS NULL OR m.status = $status)
           AND ($nameContains IS NULL OR toLower(m.name) CONTAINS toLower($nameContains))`
      rows = await runQuery<{ props: Props; nodeLabels: string[] }>(session,
        `MATCH (m {tenant_id: $tenantId})
         ${criteriaWhere}
         RETURN properties(m) AS props, labels(m) AS nodeLabels
         ORDER BY m.name ASC LIMIT toInteger($limit)`,
        params,
      )
      // Conteggio reale, stessi criteri, senza LIMIT: il taglio a MEMBERS_LIMIT
      // deve essere visibile al client ("500 di N"), non spacciato per il totale.
      const countRow = await runQueryOne<{ total: number }>(session,
        `MATCH (m {tenant_id: $tenantId})
         ${criteriaWhere}
         RETURN count(m) AS total`,
        params,
      )
      if (!countRow) throw new Error(`ciGroupMembers: count query returned no row for group ${args.groupId}`)
      total = Number(countRow.total)
    } else {
      // Manual membership: HAS_MEMBER verso un CI di un tipo di QUESTO cliente
      // (prima un membro di tipo nuovo era escluso dall'elenco in silenzio).
      const labelPredicate = '(' + (await ciLabelsForTenant(ctx.tenantId)).map(l => `m:${l}`).join(' OR ') + ')'
      rows = await runQuery<{ props: Props; nodeLabels: string[] }>(session,
        `MATCH (g:${GROUP_LABEL} {id: $groupId, tenant_id: $tenantId})-[:HAS_MEMBER]->(m)
         WHERE ${labelPredicate} AND m.tenant_id = $tenantId
         RETURN properties(m) AS props, labels(m) AS nodeLabels
         ORDER BY m.name ASC`,
        { groupId: args.groupId, tenantId: ctx.tenantId },
      )
      total = rows.length
    }

    const items = rows.map((r) => {
      r.props['type'] = ciTypeFromLabels(ctx.tenantId, r.nodeLabels)
      return mapCI(r.props)
    })
    return { items, total, truncated: total > items.length }
  })
}

export const ciGroupResolvers = {
  Query: { ciGroupMembers },
}
