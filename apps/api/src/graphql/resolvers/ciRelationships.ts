import { GraphQLError } from 'graphql'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { cache, metamodelCacheKey } from '../../lib/cache.js'
import { calculateChain } from '../../lib/chainCalculator.js'
import { logger } from '../../lib/logger.js'
import { notifyCIGraphChanged } from '../../services/serviceImpact/sync.js'

// Structural relation types always available regardless of the metamodel.
const CORE_REL_TYPES = ['DEPENDS_ON', 'HOSTED_ON', 'USES_CERTIFICATE', 'INSTALLED_ON']

/**
 * Relation types that can be created: the core set plus every relationship_type
 * declared in the metamodel (CIRelationDefinition), so custom/base relations
 * like HAS_MEMBER, REALIZES, ENABLED_BY, PARENT_OF are accepted. Cached per tenant.
 *
 * La chiave è una famiglia dichiarata in `lib/cache.ts`
 * (`METAMODEL_CACHE_PREFIXES`): il canale del metamodello la svuota in OGNI
 * processo quando una relazione viene definita o rimossa (A-16). Prima il TTL
 * di 300 s valeva per processo, e una relazione appena definita veniva
 * rifiutata da un'altra replica con «Invalid relation type» per cinque minuti.
 */
async function allowedRelTypes(tenantId: string): Promise<Set<string>> {
  const key = metamodelCacheKey('allowed_rel_types', tenantId)
  const cached = cache.get<string[]>(key)
  if (cached) return new Set(cached)
  // Own read session — must not share the write session that the caller opens.
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ t: string }>(session, `
      MATCH (r:CIRelationDefinition)
      WHERE r.tenant_id = 'system' OR r.tenant_id = $tenantId
      RETURN DISTINCT r.relationship_type AS t
    `, { tenantId })
    const set = new Set<string>(CORE_REL_TYPES)
    for (const row of rows) row.t?.split('|').forEach((x) => x.trim() && set.add(x.trim()))
    cache.set(key, [...set], 300)
    return set
  } finally {
    await session.close()
  }
}

const TYPE_CONSTRAINTS: Record<string, { source: string[]; target: string[] }> = {
  HOSTED_ON:        { source: ['DatabaseInstance'], target: ['Server'] },
  USES_CERTIFICATE: { source: ['Application'],     target: ['Certificate'] },
  INSTALLED_ON:     { source: ['Certificate'],      target: ['Server'] },
  // DEPENDS_ON has no constraints — any CI to any CI
}

// ── addCIRelationship ────────────────────────────────────────────────────────

async function addCIRelationship(
  _: unknown,
  args: { sourceId: string; targetId: string; relationType: string },
  ctx: GraphQLContext,
): Promise<boolean> {
  const { sourceId, targetId, relationType } = args
  const tenantId = ctx.tenantId

  // 1. Validate relationType format (cheap, no DB)
  if (!/^[A-Z][A-Z0-9_]*$/.test(relationType)) {
    throw new GraphQLError(`Invalid relation type format: ${relationType}`)
  }

  const session = getSession(undefined, 'WRITE')
  try {
    // Validate against the metamodel-declared relation types (+ core set)
    if (!(await allowedRelTypes(tenantId)).has(relationType)) {
      throw new GraphQLError(`Invalid relation type: ${relationType}`)
    }
    // 2. Load source and target CIs in a single query — verify they exist and
    //    belong to the tenant. (One query, not two concurrent session.run() —
    //    a Neo4j session can't run queries in parallel.)
    const endpoints = await runQueryOne<{ sLabels: string[]; tLabels: string[] }>(session, `
      MATCH (s {id: $sourceId, tenant_id: $tenantId})
      MATCH (t {id: $targetId, tenant_id: $tenantId})
      RETURN labels(s) AS sLabels, labels(t) AS tLabels
    `, { sourceId, targetId, tenantId })

    if (!endpoints) throw new GraphQLError(`Source or target CI not found (source: ${sourceId}, target: ${targetId})`)

    // 3. Type constraint validation
    const constraint = TYPE_CONSTRAINTS[relationType]
    if (constraint) {
      const sourceLabels = endpoints.sLabels
      const targetLabels = endpoints.tLabels
      const sourceMatch = constraint.source.some(l => sourceLabels.includes(l))
      const targetMatch = constraint.target.some(l => targetLabels.includes(l))
      if (!sourceMatch) {
        throw new GraphQLError(
          `${relationType} requires source to be one of: ${constraint.source.join(', ')}`,
        )
      }
      if (!targetMatch) {
        throw new GraphQLError(
          `${relationType} requires target to be one of: ${constraint.target.join(', ')}`,
        )
      }
    }

    // 4. Cycle detection (DEPENDS_ON only)
    if (relationType === 'DEPENDS_ON') {
      const cycleRow = await runQueryOne<{ hasCycle: boolean }>(session, `
        MATCH path = (target {id: $targetId})-[:DEPENDS_ON*1..10]->(source {id: $sourceId})
        RETURN count(path) > 0 AS hasCycle
      `, { sourceId, targetId })
      if (cycleRow?.hasCycle) {
        throw new GraphQLError('Adding this relationship would create a cycle')
      }
    }

    // 5. Create the relationship (relationType is validated, safe to interpolate)
    await session.executeWrite(tx => tx.run(`
      MATCH (a {id: $sourceId, tenant_id: $tenantId}),
            (b {id: $targetId, tenant_id: $tenantId})
      MERGE (a)-[:${relationType}]->(b)
    `, { sourceId, targetId, tenantId }))

    // 6. Recalculate chains
    await calculateChain(sourceId, tenantId)
    await calculateChain(targetId, tenantId)

    // 7. Invalidate cache
    cache.invalidate(metamodelCacheKey('topology', tenantId))
    cache.invalidate(metamodelCacheKey('ci', tenantId))

    // 8. Servizi monitorati (ondata 5): il grafo dei CI è cambiato, le mappe
    //    vive che toccano questi due CI si risincronizzano subito. Dopo il
    //    commit e senza mai lanciare: la relazione è già scritta e non si
    //    annulla perché la coda non risponde (la passata di sicurezza recupera).
    await notifyCIGraphChanged(tenantId, [sourceId, targetId], `ci_relationship.added:${relationType}`)

    // 9. Audit log
    void audit(ctx, 'ci_relationship.added', 'CIRelationship', sourceId, {
      targetId,
      relationType,
    })

    logger.info({ sourceId, targetId, relationType, tenantId }, '[ciRelationship] added')
    return true
  } finally {
    await session.close()
  }
}

// ── removeCIRelationship ─────────────────────────────────────────────────────

async function removeCIRelationship(
  _: unknown,
  args: { sourceId: string; targetId: string; relationType: string },
  ctx: GraphQLContext,
): Promise<boolean> {
  const { sourceId, targetId, relationType } = args
  const tenantId = ctx.tenantId

  if (!/^[A-Z][A-Z0-9_]*$/.test(relationType)) {
    throw new GraphQLError(`Invalid relation type format: ${relationType}`)
  }

  const session = getSession(undefined, 'WRITE')
  try {
    if (!(await allowedRelTypes(tenantId)).has(relationType)) {
      throw new GraphQLError(`Invalid relation type: ${relationType}`)
    }
    // 2. Delete the relationship
    const row = await runQueryOne<{ deleted: boolean }>(session, `
      MATCH (a {id: $sourceId, tenant_id: $tenantId})-[r]->(b {id: $targetId, tenant_id: $tenantId})
      WHERE type(r) = $relType
      DELETE r
      RETURN count(r) > 0 AS deleted
    `, { sourceId, targetId, tenantId, relType: relationType })

    // 3. Recalculate chains
    await calculateChain(sourceId, tenantId)
    await calculateChain(targetId, tenantId)

    // 4. Invalidate cache
    cache.invalidate(metamodelCacheKey('topology', tenantId))
    cache.invalidate(metamodelCacheKey('ci', tenantId))

    // 5. Servizi monitorati (ondata 5): stessa notifica dell'aggiunta — una
    //    relazione tolta può far uscire dei componenti dalle mappe vive.
    await notifyCIGraphChanged(tenantId, [sourceId, targetId], `ci_relationship.removed:${relationType}`)

    // 6. Audit log
    void audit(ctx, 'ci_relationship.removed', 'CIRelationship', sourceId, {
      targetId,
      relationType,
      deleted: row?.deleted ?? false,
    })

    logger.info({ sourceId, targetId, relationType, tenantId }, '[ciRelationship] removed')
    return true
  } finally {
    await session.close()
  }
}

export const ciRelationshipResolvers = {
  Mutation: { addCIRelationship, removeCIRelationship },
}
