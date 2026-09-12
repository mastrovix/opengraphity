import { randomUUID } from 'crypto'
import type { Session } from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type {
  DiscoveredCI,
  SyncSourceConfig,
  CIDiscoveryMetadata,
} from '@opengraphity/discovery'
import { applyMappingRules, inferCIType, normalizeProperties } from '@opengraphity/discovery'
import { CITypeResolver } from './ciTypeResolution.js'
import { logger } from '../lib/logger.js'
import { FIELD_NAME_RE } from '../lib/cypherIdentifiers.js'
import { ValidationError } from '../lib/errors.js'
import { ciNameKey } from '../lib/ciNameKey.js'
import { notifyCIGraphChanged } from '../services/serviceImpact/sync.js'
import { toNum } from './connectors/normalize.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReconciliationStats {
  ciCreated:        number
  ciUpdated:        number
  ciUnchanged:      number
  ciStale:          number
  ciConflicts:      number
  relationsCreated: number
  relationsRemoved: number
}

/** Tipo di conflitto su `SyncConflict.conflict_kind` (ondata 6 · A-11). */
export const CONFLICT_LOCKED_FIELDS = 'locked_fields'
export const CONFLICT_UNKNOWN_CI_TYPE = 'unknown_ci_type'

interface ExistingCI {
  id:            string
  externalId:    string | null
  discoverySource: string | null
  discoveryLocked: string[]
  props:         Record<string, unknown>
}

// Fields that are always managed by the system — never overwrite
const SYSTEM_FIELDS = new Set([
  'id', 'tenant_id', 'created_at', 'updated_at',
  'discovery_external_id', 'discovery_source', 'discovery_source_id',
  'discovery_status', 'discovery_last_seen', 'discovery_stale_since',
  'discovery_locked_fields', 'discovered_at',
])

// ── Main reconciliation function ──────────────────────────────────────────────

export async function reconcileBatch(
  batch:     DiscoveredCI[],
  source:    SyncSourceConfig,
  runId:     string,
  tenantId:  string,
  stats:     ReconciliationStats,
): Promise<void> {
  const session = getSession()
  // Servizi monitorati (ondata 5): gli id dei CI le cui relazioni sono state
  // toccate in questo lotto. UNA notifica alla fine con tutti gli id (non una
  // per relazione): un lotto che tocca 500 relazioni produce comunque una
  // sincronizzazione per mappa, non 500.
  const touched = new Set<string>()
  try {
    // A-11: i tipi attivi del cliente e gli alias della sorgente, UNA volta per
    // lotto. Se il metamodello non si legge il run fallisce: continuare
    // significherebbe inventare etichette, che è il difetto che si sta chiudendo.
    const ciTypes = await CITypeResolver.forSource(tenantId, source)
    for (const raw of batch) {
      const ci = applyMappingRules(raw, source.mapping_rules ?? [])
      await reconcileOne(ci, source, runId, tenantId, stats, session, touched, ciTypes)
    }
  } finally {
    await session.close()
  }
  // Dopo il commit del lotto e senza mai lanciare: la CMDB è già scritta, un
  // errore di coda non deve far fallire la discovery (la passata di sicurezza
  // dei servizi recupera entro 30 minuti).
  await notifyCIGraphChanged(tenantId, [...touched], `discovery.reconciled:${source.id}`)
}

async function reconcileOne(
  discovered: DiscoveredCI,
  source:     SyncSourceConfig,
  runId:      string,
  tenantId:   string,
  stats:      ReconciliationStats,
  session:    Session,
  touched:    Set<string>,
  ciTypes:    CITypeResolver,
): Promise<void> {
  const rawType = discovered.ci_type ?? inferCIType(discovered)
  // A-11 — LA PORTA. Prima l'etichetta era il PascalCase della stringa in
  // arrivo, senza nessun controllo: un `ci_type` che non esiste creava un CI
  // con un'etichetta che nessuna pagina mostra, e il run lo contava «creato».
  const resolution = ciTypes.resolve(rawType)
  if (!resolution.ok) {
    await createUnknownTypeConflict(session, discovered, rawType, resolution.reason, source, runId, tenantId, new Date().toISOString())
    stats.ciConflicts++
    return
  }
  const ciType   = resolution.type.name
  const label    = resolution.type.label
  const now      = new Date().toISOString()

  // ── 1. Find existing CI by external_id + source ───────────────────────────
  const existing = await findExisting(session, discovered.external_id, source.id, tenantId, label)

  if (!existing) {
    // ── 2a. Create new CI (MERGE on the discovery key: idempotent) ──────────
    const created = await createCI(session, discovered, ciType, label, source, runId, tenantId, now)
    if (created) {
      stats.ciCreated++
    } else {
      // Lost a race with a concurrent sync of the same source (findExisting saw
      // nothing, MERGE matched the node the other run just created). The node
      // is touched (last_seen) but its properties are left to the next run,
      // which goes through the regular update + locked-field conflict path.
      stats.ciUnchanged++
      logger.warn({ externalId: discovered.external_id, sourceId: source.id, runId }, '[reconcile] CI created concurrently by another run — skipped property update')
    }
  } else {
    // ── 2b. Check for conflicts with locked fields ───────────────────────────
    const conflicts = detectConflicts(discovered, existing)
    if (conflicts.length > 0) {
      await createConflict(session, discovered, existing, conflicts, source, runId, tenantId, now)
      stats.ciConflicts++
      return
    }

    // ── 2c. Update existing CI ───────────────────────────────────────────────
    const changed = await updateCI(session, discovered, existing, label, source, now, tenantId)
    if (changed) {
      stats.ciUpdated++
    } else {
      stats.ciUnchanged++
    }
  }

  // ── 3. Sync relations ────────────────────────────────────────────────────
  if (discovered.relationships && discovered.relationships.length > 0) {
    const delta = await syncRelations(session, discovered, source, tenantId, touched)
    stats.relationsCreated += delta.created
    stats.relationsRemoved += delta.removed
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAFE_LABEL_RE = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Discovered property keys come from connectors (cloud tags, CSV headers, JSON
 * keys). They are never interpolated into Cypher any more (SET ci += $props),
 * but a key that is not a plain snake_case identifier is still a connector
 * bug: fail loud so the mapping is fixed upstream instead of polluting the CMDB.
 * Exported for tests.
 */
export function assertDiscoveredPropertyKeys(props: Record<string, unknown>, externalId: string): void {
  const bad = Object.keys(props).filter(k => !FIELD_NAME_RE.test(k))
  if (bad.length) {
    throw new ValidationError(
      `[reconcile] CI ${externalId}: property keys must match ${FIELD_NAME_RE.source} — ` +
      `invalid: ${bad.map(k => JSON.stringify(k.slice(0, 60))).join(', ')} (normalize them in the connector mapping)`,
    )
  }
}

// `ciTypeToLabel` non esiste più (ondata 6 · A-11): era il PascalCase della
// stringa in arrivo, cioè il modo in cui la discovery inventava etichette.
// L'etichetta viene dal tipo risolto nel metamodello (./ciTypeResolution.ts).

async function findExisting(
  session:    Session,
  externalId: string,
  sourceId:   string,
  tenantId:   string,
  label:      string,
): Promise<ExistingCI | null> {
  try {
    const result = await session.executeRead(tx => tx.run(
      `MATCH (ci:ConfigurationItem {
         discovery_external_id: $externalId,
         discovery_source_id:   $sourceId,
         tenant_id:             $tenantId
       })
       RETURN ci.id AS id, properties(ci) AS props`,
      { externalId, sourceId, tenantId },
    ))
    if (!result.records.length) return null
    const r    = result.records[0]!
    const props = r.get('props') as Record<string, unknown>
    const locked = props['discovery_locked_fields']
    return {
      id:              r.get('id') as string,
      externalId,
      discoverySource: props['discovery_source'] as string | null,
      discoveryLocked: Array.isArray(locked) ? locked as string[] : [],
      props,
    }
  } catch (err) {
    // A DB error here must NOT look like "CI not found": returning null makes
    // the engine CREATE a duplicate of an existing CI. Propagate — the sync
    // run fails visibly instead of corrupting the CMDB.
    logger.error({ err, externalId, label }, '[reconcile] findExisting failed — aborting reconcile for this CI')
    throw err instanceof Error ? err : new Error(String(err))
  }
}

/**
 * Cypher for the idempotent create. MERGE on the discovery key
 * (tenant_id, discovery_source_id, discovery_external_id) — the same key
 * findExisting looks up and the one backed by the `ci_discovery_key_unique`
 * constraint (packages/neo4j/src/init.ts) — so two runs racing on the same
 * external id converge on ONE node instead of creating a duplicate.
 * The type label is added ON CREATE only: a node whose type changed upstream
 * keeps being matched by the key (like findExisting) rather than duplicated.
 * Exported for tests.
 */
export function createCICypher(label: string): string {
  return `MERGE (ci:ConfigurationItem {tenant_id: $key.tenant_id, discovery_source_id: $key.discovery_source_id, discovery_external_id: $key.discovery_external_id})
     ON CREATE SET ci:${label}, ci += $props
     ON MATCH SET ci.discovery_last_seen = $now, ci.updated_at = $now
     RETURN ci.id = $props.id AS created`
}

/** @returns true when this call created the node, false when MERGE matched an existing one. */
async function createCI(
  session:    Session,
  ci:         DiscoveredCI,
  ciType:     string,
  label:      string,
  source:     SyncSourceConfig,
  runId:      string,
  tenantId:   string,
  now:        string,
): Promise<boolean> {
  const id    = randomUUID()
  const props = normalizeProperties(ci.properties)
  assertDiscoveredPropertyKeys(props, ci.external_id)
  const meta: CIDiscoveryMetadata = {
    discovery_external_id:  ci.external_id,
    discovery_source:       ci.source,
    discovery_source_id:    source.id,
    discovery_status:       'active',
    discovery_last_seen:    now,
    discovery_locked_fields: [],
    discovered_at:          now,
  }

  const allProps: Record<string, unknown> = {
    ...props,
    ...meta,
    id,
    tenant_id:  tenantId,
    name:       ci.name,
    name_key:   ciNameKey(ci.name),   // riconoscimento per nome degli allarmi (lib/ciNameKey.ts)
    type:       ciType,
    created_at: now,
    updated_at: now,
  }
  const key = {
    tenant_id:             tenantId,
    discovery_source_id:   source.id,
    discovery_external_id: ci.external_id,
  }

  // Properties travel as ONE map parameter — keys never touch the query text.
  const result = await session.executeWrite(tx => tx.run(createCICypher(label), { key, props: allProps, now }))
  const rec = result.records[0]
  if (!rec) throw new Error(`[reconcile] MERGE for CI ${ci.external_id} (source ${source.id}) returned no row`)
  const created = rec.get('created') === true

  if (created) logger.debug({ id, name: ci.name, ciType }, '[reconcile] CI created')
  return created
}

function detectConflicts(
  discovered: DiscoveredCI,
  existing:   ExistingCI,
): string[] {
  if (!existing.discoveryLocked.length) return []
  const conflicts: string[] = []
  const props = normalizeProperties(discovered.properties)
  for (const field of existing.discoveryLocked) {
    if (field in props && String(props[field]) !== String(existing.props[field])) {
      conflicts.push(field)
    }
  }
  return conflicts
}

async function updateCI(
  session:   Session,
  ci:        DiscoveredCI,
  existing:  ExistingCI,
  label:     string,
  source:    SyncSourceConfig,
  now:       string,
  tenantId:  string,
): Promise<boolean> {
  const newProps = normalizeProperties(ci.properties)
  assertDiscoveredPropertyKeys(newProps, ci.external_id)
  const updates: Record<string, unknown> = {}
  const changedFields: string[] = []
  const oldValues: Record<string, unknown> = {}
  const newValues: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(newProps)) {
    if (SYSTEM_FIELDS.has(k)) continue
    if (existing.discoveryLocked.includes(k)) continue
    if (String(existing.props[k]) !== String(v)) {
      updates[k] = v
      changedFields.push(k)
      oldValues[k] = existing.props[k]
      newValues[k] = v
    }
  }

  updates['name']                 = ci.name
  updates['name_key']             = ciNameKey(ci.name)
  updates['discovery_last_seen']  = now
  updates['discovery_status']     = 'active'
  updates['updated_at']           = now

  if (changedFields.length === 0) return false

  await session.executeWrite(tx => tx.run(
    `MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId}) SET ci += $updates`,
    { id: existing.id, tenantId, updates },
  ))

  // Record the change for sync history
  const changeId = randomUUID()
  await session.executeWrite(tx => tx.run(
    `CREATE (r:SyncChangeRecord {
       id:             $id,
       ci_id:          $ciId,
       source_id:      $sourceId,
       tenant_id:      $tenantId,
       changed_at:     $changedAt,
       changed_fields: $changedFields,
       old_values:     $oldValues,
       new_values:     $newValues
     })`,
    {
      id:            changeId,
      ciId:          existing.id,
      sourceId:      source.id,
      tenantId,
      changedAt:     now,
      changedFields: JSON.stringify(changedFields),
      oldValues:     JSON.stringify(oldValues),
      newValues:     JSON.stringify(newValues),
    },
  ))

  return true
}

async function createConflict(
  session:    Session,
  discovered: DiscoveredCI,
  existing:   ExistingCI,
  conflicts:  string[],
  source:     SyncSourceConfig,
  runId:      string,
  tenantId:   string,
  now:        string,
): Promise<void> {
  const id = randomUUID()
  await session.executeWrite(tx => tx.run(
    `CREATE (c:SyncConflict {
       id: $id, source_id: $sourceId, tenant_id: $tenantId, run_id: $runId,
       external_id: $externalId, ci_type: $ciType,
       conflict_fields: $conflictFields,
       conflict_kind: '${CONFLICT_LOCKED_FIELDS}',
       status: 'open',
       discovered_ci: $discoveredCi,
       existing_ci_id: $existingCiId,
       match_reason: 'external_id',
       created_at: $now
     })`,
    {
      id,
      sourceId:       source.id,
      tenantId,
      runId,
      externalId:     discovered.external_id,
      ciType:         discovered.ci_type ?? inferCIType(discovered),
      conflictFields: JSON.stringify(conflicts),
      discoveredCi:   JSON.stringify(discovered),
      existingCiId:   existing.id,
      now,
    },
  ))
  logger.warn({ id, externalId: discovered.external_id, conflicts }, '[reconcile] Conflict created')
}

/**
 * Il CI non si crea perché il suo tipo non esiste (A-11): resta un
 * `SyncConflict` di tipo `unknown_ci_type` con il motivo E cosa fare (creare il
 * tipo o aggiungere un alias). `existing_ci_id` è vuoto — non c'è nessun CI
 * esistente in ballo, qui il conflitto è fra il dato e il metamodello — e
 * `match_reason` lo dice. Idempotente: uno per (sorgente, external_id, run).
 */
async function createUnknownTypeConflict(
  session:    Session,
  discovered: DiscoveredCI,
  rawType:    string,
  reason:     string,
  source:     SyncSourceConfig,
  runId:      string,
  tenantId:   string,
  now:        string,
): Promise<void> {
  const id = randomUUID()
  await session.executeWrite(tx => tx.run(
    `MERGE (c:SyncConflict {tenant_id: $tenantId, source_id: $sourceId, run_id: $runId, external_id: $externalId, conflict_kind: '${CONFLICT_UNKNOWN_CI_TYPE}'})
     ON CREATE SET
       c.id = $id, c.ci_type = $ciType, c.conflict_fields = $conflictFields, c.status = 'open',
       c.discovered_ci = $discoveredCi, c.existing_ci_id = '', c.match_reason = 'ci_type',
       c.message = $message, c.created_at = $now
     ON MATCH SET c.message = $message, c.discovered_ci = $discoveredCi`,
    {
      id, tenantId, sourceId: source.id, runId,
      externalId:     discovered.external_id,
      ciType:         rawType,
      conflictFields: JSON.stringify(['ci_type']),
      discoveredCi:   JSON.stringify(discovered),
      message:        reason,
      now,
    },
  ))
  logger.warn({ externalId: discovered.external_id, ciType: rawType, sourceId: source.id, runId, tenantId, reason },
    '[reconcile] CI non creato: il ci_type non esiste nel metamodello del cliente')
}

async function syncRelations(
  session:    Session,
  ci:         DiscoveredCI,
  source:     SyncSourceConfig,
  tenantId:   string,
  touched:    Set<string>,
): Promise<{ created: number; removed: number }> {
  let created = 0
  const removed = 0

  const ciResult = await session.executeRead(tx => tx.run(
    `MATCH (ci:ConfigurationItem {discovery_external_id: $externalId, discovery_source_id: $sourceId, tenant_id: $tenantId})
     RETURN ci.id AS id`,
    { externalId: ci.external_id, sourceId: source.id, tenantId },
  ))
  if (!ciResult.records.length) return { created, removed }
  const fromId = ciResult.records[0]!.get('id') as string

  for (const rel of ci.relationships ?? []) {
    const targetResult = await session.executeRead(tx => tx.run(
      `MATCH (ci:ConfigurationItem {discovery_external_id: $externalId, discovery_source_id: $sourceId, tenant_id: $tenantId})
       RETURN ci.id AS id`,
      { externalId: rel.target_external_id, sourceId: source.id, tenantId },
    ))
    if (!targetResult.records.length) continue
    const toId = targetResult.records[0]!.get('id') as string

    const relType = rel.relation_type.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
    if (!SAFE_LABEL_RE.test(relType)) continue

    if (rel.direction === 'outgoing') {
      const r = await session.executeWrite(tx => tx.run(
        // tenant-ok: id dei CI riconciliati in questo run (stesso tenant della sorgente)
        `MATCH (a:ConfigurationItem {id: $fromId}), (b:ConfigurationItem {id: $toId})
         MERGE (a)-[r:${relType}]->(b)
         ON CREATE SET r.created_at = $now, r.discovery_source_id = $sourceId
         RETURN r.created_at AS createdAt`,
        { fromId, toId, now: new Date().toISOString(), sourceId: source.id },
      ))
      if (r.records.length) created++
    } else {
      const r = await session.executeWrite(tx => tx.run(
        // tenant-ok: id dei CI riconciliati in questo run (stesso tenant della sorgente)
        `MATCH (a:ConfigurationItem {id: $toId}), (b:ConfigurationItem {id: $fromId})
         MERGE (a)-[r:${relType}]->(b)
         ON CREATE SET r.created_at = $now, r.discovery_source_id = $sourceId
         RETURN r.created_at AS createdAt`,
        { fromId, toId, now: new Date().toISOString(), sourceId: source.id },
      ))
      if (r.records.length) created++
    }
    // Entrambi i capi: la mappa può includere l'uno o l'altro.
    touched.add(fromId)
    touched.add(toId)
  }

  return { created, removed }
}

// ── Stale detection ───────────────────────────────────────────────────────────

export async function markStale(
  sourceId:  string,
  tenantId:  string,
  runId:     string,
  seenIds:   Set<string>,
): Promise<number> {
  return withSession(async (session) => {
    const result = await session.executeWrite(tx => tx.run(
      `MATCH (ci:ConfigurationItem {discovery_source_id: $sourceId, tenant_id: $tenantId, discovery_status: 'active'})
       WHERE NOT ci.discovery_external_id IN $seenIds
       SET ci.discovery_status = 'stale', ci.discovery_stale_since = $now, ci.updated_at = $now
       RETURN count(ci) AS n`,
      { sourceId, tenantId, seenIds: Array.from(seenIds), now: new Date().toISOString() },
    ))
    return toNum(result.records[0]?.get('n')) ?? 0
  }, true)
}
