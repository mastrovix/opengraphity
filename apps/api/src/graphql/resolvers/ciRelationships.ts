import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { ciLabelPredicateForTenant } from '../../lib/ciLabelsForTenant.js'
import { cache, metamodelCacheKey } from '../../lib/cache.js'
import { recalculateChainsFrom } from '../../lib/chainCalculator.js'
import { logger } from '../../lib/logger.js'
import { notifyCIGraphChanged } from '../../services/serviceImpact/sync.js'
import { assertRelationAdmitted } from '../../services/cmdbChains/admission.js'

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

/**
 * La relazione è dichiarata dal metamodello fra QUESTI due tipi? O come
 * relazione in uscita del tipo sorgente, o come relazione in entrata del tipo
 * destinazione; `target_type` è l'etichetta dell'altro capo o `any`, e una
 * definizione può elencare più tipi (`DEPENDS_ON|HOSTED_ON|INSTALLED_ON`).
 *
 * Giro nel browser del 14 set 2026 (#56): qui c'era `TYPE_CONSTRAINTS`, una
 * tabella scritta a mano che contraddiceva il metamodello (l'applicazione
 * dichiara «Hosted On → Server», la tabella lo ammetteva solo per le istanze
 * di database), e `DEPENDS_ON` passava fra due CI qualunque.
 */
async function relationDeclared(
  session: Parameters<typeof runQueryOne>[0], tenantId: string, relationType: string, sLabels: string[], tLabels: string[],
): Promise<boolean> {
  const row = await runQueryOne<{ declared: boolean }>(session, `
    OPTIONAL MATCH (st:CITypeDefinition)-[:HAS_RELATION]->(out:CIRelationDefinition)
      WHERE st.tenant_id IN ['system', $tenantId] AND st.neo4j_label IN $sLabels
        AND out.direction = 'outgoing' AND $relationType IN [x IN split(out.relationship_type, '|') | trim(x)]
        AND (out.target_type = 'any' OR out.target_type IN $tLabels)
    WITH count(out) AS outgoing
    OPTIONAL MATCH (tt:CITypeDefinition)-[:HAS_RELATION]->(inc:CIRelationDefinition)
      WHERE tt.tenant_id IN ['system', $tenantId] AND tt.neo4j_label IN $tLabels
        AND inc.direction = 'incoming' AND $relationType IN [x IN split(inc.relationship_type, '|') | trim(x)]
        AND (inc.target_type = 'any' OR inc.target_type IN $sLabels)
    WITH outgoing, count(inc) AS incoming
    RETURN outgoing + incoming > 0 AS declared
  `, { tenantId, relationType, sLabels, tLabels })
  return row?.declared === true
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
  assertRelationTypeFormat(relationType)

  const session = getSession(undefined, 'WRITE')
  try {
    // Validate against the metamodel-declared relation types (+ core set)
    if (!(await allowedRelTypes(tenantId)).has(relationType)) {
      throw new ValidationError(`Invalid relation type: ${relationType}`, { key: 'errors.ciRelation.unknownType', params: { relation: relationType } })
    }
    // 2. Load source and target CIs in a single query — verify they exist and
    //    belong to the tenant. (One query, not two concurrent session.run() —
    //    a Neo4j session can't run queries in parallel.)
    const endpoints = await runQueryOne<{ sLabels: string[]; tLabels: string[] }>(session, `
      MATCH (s:ConfigurationItem {id: $sourceId, tenant_id: $tenantId})
      MATCH (t:ConfigurationItem {id: $targetId, tenant_id: $tenantId})
      RETURN labels(s) AS sLabels, labels(t) AS tLabels
    `, { sourceId, targetId, tenantId })

    if (!endpoints) throw new NotFoundError('ConfigurationItem', `${sourceId} → ${targetId}`)

    // 3. The metamodel must declare this relation between these two types
    if (!(await relationDeclared(session, tenantId, relationType, endpoints.sLabels, endpoints.tLabels))) {
      const typeOf = (labels: string[]) => labels.find((l) => l !== 'ConfigurationItem') ?? labels[0] ?? '?'
      const source = typeOf(endpoints.sLabels)
      const target = typeOf(endpoints.tLabels)
      throw new ValidationError(
        `${relationType} from ${source} to ${target} is not declared in the metamodel`,
        { key: 'errors.ci.relationNotDeclared', params: { relation: relationType, source, target } },
      )
    }

    // 3b. A CMDB chain must admit it (owner, 24 Sep 2026): the chains say which
    //     relations between CIs may exist; CMDB Health counts any that got in anyway.
    await assertRelationAdmitted(session, tenantId, relationType, endpoints.sLabels, endpoints.tLabels)

    // 4. Cycle detection (DEPENDS_ON only)
    if (relationType === 'DEPENDS_ON') {
      const cycleRow = await runQueryOne<{ hasCycle: boolean }>(session, `
        MATCH path = (target:ConfigurationItem {id: $targetId, tenant_id: $tenantId})-[:DEPENDS_ON*1..10]->(source:ConfigurationItem {id: $sourceId, tenant_id: $tenantId})
        RETURN count(path) > 0 AS hasCycle
      `, { sourceId, targetId, tenantId })
      if (cycleRow?.hasCycle) {
        throw new ValidationError('Adding this relationship would create a cycle', { key: 'errors.ciRelation.cycle' })
      }
    }

    // 5. Create the relationship (relationType is validated, safe to interpolate)
    await session.executeWrite(tx => tx.run(`
      MATCH (a:ConfigurationItem {id: $sourceId, tenant_id: $tenantId}),
            (b:ConfigurationItem {id: $targetId, tenant_id: $tenantId})
      MERGE (a)-[:${relationType}]->(b)
    `, { sourceId, targetId, tenantId }))

    // 6. Recalculate chains: the chain flows downstream, so the target and
    // every CI below it (review of 23 Sep 2026 — only the two ends were, and
    // the source's chain does not depend on this relationship at all).
    await recalculateChainsFrom(targetId, tenantId)

    // 7. Invalidate cache
    cache.invalidate(`${metamodelCacheKey('topology', tenantId)}:`)
    cache.invalidate(`${metamodelCacheKey('ci', tenantId)}:`)

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
  assertRelationTypeFormat(relationType)

  const session = getSession(undefined, 'WRITE')
  try {
    // CM-4 (revisione del 15 set 2026): qui c'era il controllo contro le
    // definizioni del metamodello. Ma togliere un arco non deve dipendere dal
    // fatto che la sua definizione esista ancora: senza definizione l'arco
    // restava nel grafo e NESSUNO poteva più cancellarlo («Invalid relation
    // type»). Basta che i due capi siano CI di questo tenant.
    const ciA = await ciLabelPredicateForTenant('a', tenantId)
    const ciB = await ciLabelPredicateForTenant('b', tenantId)
    const row = await runQueryOne<{ deleted: number }>(session, `
      MATCH (a:ConfigurationItem {id: $sourceId, tenant_id: $tenantId})-[r]->(b:ConfigurationItem {id: $targetId, tenant_id: $tenantId})
      WHERE type(r) = $relType AND ${ciA} AND ${ciB}
      DELETE r
      RETURN count(r) AS deleted
    `, { sourceId, targetId, tenantId, relType: relationType })

    // CM-11: prima rispondeva `true` anche senza aver tolto niente.
    if (Number(row?.deleted ?? 0) === 0) {
      throw new NotFoundError('CIRelationship', `${sourceId} -${relationType}-> ${targetId}`)
    }

    // 3. Recalculate chains: the target and every CI downstream of it.
    await recalculateChainsFrom(targetId, tenantId)

    // 4. Invalidate cache
    cache.invalidate(`${metamodelCacheKey('topology', tenantId)}:`)
    cache.invalidate(`${metamodelCacheKey('ci', tenantId)}:`)

    // 5. Servizi monitorati (ondata 5): stessa notifica dell'aggiunta — una
    //    relazione tolta può far uscire dei componenti dalle mappe vive.
    await notifyCIGraphChanged(tenantId, [sourceId, targetId], `ci_relationship.removed:${relationType}`)

    // 6. Audit log
    void audit(ctx, 'ci_relationship.removed', 'CIRelationship', sourceId, {
      targetId,
      relationType,
    })

    logger.info({ sourceId, targetId, relationType, tenantId }, '[ciRelationship] removed')
    return true
  } finally {
    await session.close()
  }
}

/** Un tipo di relazione Neo4j: MAIUSCOLO_CON_UNDERSCORE, perché finisce nel testo della query. */
function assertRelationTypeFormat(relationType: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(relationType)) {
    throw new ValidationError(`Invalid relation type format: ${relationType}`, { key: 'errors.ciRelation.invalidFormat', params: { relation: relationType } })
  }
}

export const ciRelationshipResolvers = {
  Mutation: { addCIRelationship, removeCIRelationship },
}
