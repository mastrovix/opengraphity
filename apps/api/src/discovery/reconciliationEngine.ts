import { randomUUID } from 'crypto'
import type { Session } from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type {
  DiscoveredCI,
  DiscoveredRelation,
  MappingRule,
  SyncSourceConfig,
  CIDiscoveryMetadata,
} from '@opengraphity/discovery'
import { applyMappingRules, inferCIType, normalizeProperties } from '@opengraphity/discovery'
import { logger } from '../lib/logger.js'

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
  try {
    for (const raw of batch) {
      const ci = applyMappingRules(raw, source.mapping_rules ?? [])
      await reconcileOne(ci, source, runId, tenantId, stats, session)
    }
  } finally {
    await session.close()
  }
}

async function reconcileOne(
  discovered: DiscoveredCI,
  source:     SyncSourceConfig,
  runId:      string,
  tenantId:   string,
  stats:      ReconciliationStats,
  session:    Session,
): Promise<void> {
  const ciType   = discovered.ci_type ?? inferCIType(discovered)
  const label    = ciTypeToLabel(ciType)
  const now      = new Date().toISOString()

  // ── 1. Find existing CI by external_id + source ───────────────────────────
  const existing = await findExisting(session, discovered.external_id, source.id, tenantId, label)

  if (!existing) {
    // ── 2a. Create new CI ────────────────────────────────────────────────────
    await createCI(session, discovered, ciType, label, source, runId, tenantId, now)
    stats.ciCreated++
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
    const delta = await syncRelations(session, discovered, source, tenantId)
    stats.relationsCreated += delta.created
    stats.relationsRemoved += delta.removed
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ciTypeToLabel(ciType: string): string {
  // Convert snake_case ci_type to PascalCase Neo4j label
  return ciType
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

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
    logger.warn({ err, externalId, label }, '[reconcile] findExisting error')
    return null
  }
}

async function createCI(
  session:    Session,
  ci:         DiscoveredCI,
  ciType:     string,
  label:      string,
  source:     SyncSourceConfig,
  runId:      string,
  tenantId:   string,
  now:        string,
): Promise<void> {
  const id    = randomUUID()
  const props = normalizeProperties(ci.properties)
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
    type:       ciType,
    created_at: now,
    updated_at: now,
  }

  // Build SET clause from properties
  const setClause = Object.keys(allProps)
    .map(k => `ci.${k} = $${k}`)
    .join(', ')

  await session.executeWrite(tx => tx.run(
    `CREATE (ci:ConfigurationItem:${label}) SET ${setClause}`,
    allProps,
  ))

  logger.debug({ id, name: ci.name, ciType }, '[reconcile] CI created')
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
  updates['discovery_last_seen']  = now
  updates['discovery_status']     = 'active'
  updates['updated_at']           = now

  if (changedFields.length === 0) return false

  const setClause = Object.keys(updates).map(k => `ci.${k} = $${k}`).join(', ')
  await session.executeWrite(tx => tx.run(
    `MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId}) SET ${setClause}`,
    { id: existing.id, tenantId, ...updates },
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

async function syncRelations(
  session:    Session,
  ci:         DiscoveredCI,
  source:     SyncSourceConfig,
  tenantId:   string,
): Promise<{ created: number; removed: number }> {
  let created = 0
  let removed = 0

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

    if (rel.direction === 'outgoing') {
      const r = await session.executeWrite(tx => tx.run(
        `MATCH (a:ConfigurationItem {id: $fromId}), (b:ConfigurationItem {id: $toId})
         MERGE (a)-[r:${relType}]->(b)
         ON CREATE SET r.created_at = $now, r.discovery_source_id = $sourceId
         RETURN r.created_at AS createdAt`,
        { fromId, toId, now: new Date().toISOString(), sourceId: source.id },
      ))
      if (r.records.length) created++
    } else {
      const r = await session.executeWrite(tx => tx.run(
        `MATCH (a:ConfigurationItem {id: $toId}), (b:ConfigurationItem {id: $fromId})
         MERGE (a)-[r:${relType}]->(b)
         ON CREATE SET r.created_at = $now, r.discovery_source_id = $sourceId
         RETURN r.created_at AS createdAt`,
        { fromId, toId, now: new Date().toISOString(), sourceId: source.id },
      ))
      if (r.records.length) created++
    }
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
    return (result.records[0]?.get('n') as { toNumber(): number } | undefined)?.toNumber() ?? 0
  }, true)
}
