/**
 * CMDB resolvers wired in resolvers/index.ts: only `updateCIFields`.
 *
 * The former `configurationItems/configurationItem/blastRadius/ciTypes`
 * queries, `createConfigurationItem/updateConfigurationItem/addCIDependency`
 * mutations and the `ConfigurationItem.dependencies*` field resolvers were
 * dead code (B-09): never referenced by index.ts nor by the schema, with a
 * tenant/label scoping that diverged from the live dynamic CI resolvers.
 */
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { assertWritablePropertyKey } from '../../lib/cypherIdentifiers.js'
import { runQuery, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { ciTypeFromLabels } from '../../lib/ciTypeFromLabels.js'
import { ciLabelPredicate } from '../../lib/ciLabels.js'
import { toSnakeCase } from '../../lib/mappers.js'
import { withSession } from './ci-utils.js'

type Props = Record<string, unknown>

function mapCI(props: Props, label?: string) {
  return {
    id:          props['id']          as string,
    tenantId:    props['tenant_id']   as string,
    name:        props['name']        as string,
    type:        label ? ciTypeFromLabels([label]) : (props['type'] as string ?? 'unknown'),
    status:      props['status']      as string,
    environment: props['environment'] as string,
    createdAt:   props['created_at']  as string,
    updatedAt:   props['updated_at']  as string,
    // optional technical fields
    ipAddress:   (props['ip_address']  ?? null) as string | null,
    expiryDate:  (props['expiry_date'] ?? null) as string | null,
    location:    (props['location']    ?? null) as string | null,
    vendor:      (props['vendor']      ?? null) as string | null,
    version:     (props['version']     ?? null) as string | null,
    port:        props['port'] != null ? toNumber(props['port']) : null,
    url:         (props['url']         ?? null) as string | null,
    region:      (props['region']      ?? null) as string | null,
    notes:       (props['notes']       ?? null) as string | null,
    chain:       (props['chain']      ?? null) as string | null,
    dependencies: [],
    dependents:   [],
  }
}

/**
 * Builds the parameter map for `SET ci += $updates` from base fields plus the
 * customFields JSON. Every custom key is validated as a snake_case identifier
 * and must not be a system-managed property (tenant_id, id, created_at, …).
 * Exported for tests.
 */
export function buildCIFieldUpdates(
  input: { name?: string; status?: string; environment?: string; description?: string; notes?: string; customFields?: string },
  now: string,
): Record<string, unknown> {
  const updates: Record<string, unknown> = { updated_at: now }
  const baseFields = ['name', 'status', 'environment', 'description', 'notes'] as const
  for (const f of baseFields) {
    if (input[f] !== undefined && input[f] !== null) updates[f] = input[f]
  }
  if (input.customFields) {
    let custom: unknown
    try { custom = JSON.parse(input.customFields) }
    catch (e) {
      throw new ValidationError(`customFields is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!custom || typeof custom !== 'object' || Array.isArray(custom)) {
      throw new ValidationError('customFields must be a JSON object')
    }
    for (const [key, val] of Object.entries(custom as Record<string, unknown>)) {
      updates[assertWritablePropertyKey(toSnakeCase(key), 'customFields')] = val
    }
  }
  return updates
}

async function updateCIFields(
  _: unknown,
  args: {
    id: string
    input: {
      name?: string; status?: string; environment?: string
      description?: string; notes?: string; customFields?: string
    }
  },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  const updates = buildCIFieldUpdates(input, now)

  return withSession(async (session) => {
    // Keys never reach the query text: validated names, then `SET ci += $updates`.
    const cypher = `
      MATCH (ci {id: $id, tenant_id: $tenantId})
      WHERE ${ciLabelPredicate('ci')}
      SET ci += $updates
      RETURN properties(ci) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, { id, tenantId: ctx.tenantId, updates })
    const row = rows[0]
    if (!row) throw new NotFoundError('ConfigurationItem')
    return mapCI(row.props)
  }, true)
}

// ── Export ───────────────────────────────────────────────────────────────────

export const cmdbResolvers = {
  Mutation: { updateCIFields },
}
