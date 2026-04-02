import { randomUUID } from 'crypto'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import {
  encryptCredentials,
  decryptCredentials,
  getAllConnectors,
  getConnector,
} from '@opengraphity/discovery'
import type { GraphQLContext } from '../../context.js'
import { syncQueue } from '../../discovery/syncWorker.js'

const ENCRYPTION_KEY = process.env['DISCOVERY_ENCRYPTION_KEY'] ?? ''

type Props = Record<string, unknown>

function toStr(v: unknown): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return String(v)
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof (v as { toNumber(): number }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v ?? 0)
}

function mapSource(p: Props) {
  return {
    id:                 toStr(p['id']),
    tenantId:           toStr(p['tenant_id']),
    name:               toStr(p['name']),
    connectorType:      toStr(p['connector_type']),
    config:             toStr(p['config']),
    mappingRules:       toStr(p['mapping_rules'] ?? '[]'),
    scheduleCron:       p['schedule_cron']         ? toStr(p['schedule_cron'])         : null,
    enabled:            Boolean(p['enabled']),
    lastSyncAt:         p['last_sync_at']          ? toStr(p['last_sync_at'])          : null,
    lastSyncStatus:     p['last_sync_status']      ? toStr(p['last_sync_status'])      : null,
    lastSyncDurationMs: p['last_sync_duration_ms'] ? toNum(p['last_sync_duration_ms']) : null,
    createdAt:          toStr(p['created_at']),
    updatedAt:          toStr(p['updated_at']),
  }
}

function mapRun(p: Props) {
  return {
    id:               toStr(p['id']),
    sourceId:         toStr(p['source_id']),
    tenantId:         toStr(p['tenant_id']),
    syncType:         toStr(p['sync_type']),
    status:           toStr(p['status']),
    ciCreated:        toNum(p['ci_created']),
    ciUpdated:        toNum(p['ci_updated']),
    ciUnchanged:      toNum(p['ci_unchanged']),
    ciStale:          toNum(p['ci_stale']),
    ciConflicts:      toNum(p['ci_conflicts']),
    relationsCreated: toNum(p['relations_created']),
    relationsRemoved: toNum(p['relations_removed']),
    durationMs:       p['duration_ms']    ? toNum(p['duration_ms'])    : null,
    errorMessage:     p['error_message']  ? toStr(p['error_message'])  : null,
    startedAt:        toStr(p['started_at']),
    completedAt:      p['completed_at']   ? toStr(p['completed_at'])   : null,
  }
}

function mapConflict(p: Props) {
  return {
    id:             toStr(p['id']),
    sourceId:       toStr(p['source_id']),
    tenantId:       toStr(p['tenant_id']),
    runId:          toStr(p['run_id']),
    externalId:     toStr(p['external_id']),
    ciType:         toStr(p['ci_type']),
    conflictFields: toStr(p['conflict_fields'] ?? '[]'),
    resolution:     p['resolution']  ? toStr(p['resolution'])  : null,
    status:         toStr(p['status']),
    discoveredCi:   toStr(p['discovered_ci'] ?? '{}'),
    existingCiId:   toStr(p['existing_ci_id']),
    matchReason:    toStr(p['match_reason']),
    createdAt:      toStr(p['created_at']),
    resolvedAt:     p['resolved_at'] ? toStr(p['resolved_at']) : null,
  }
}

export const syncResolvers = {
  Query: {
    syncSources: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const session = getSession()
      try {
        const rows = await runQuery<{ p: Props }>(session,
          `MATCH (n:SyncSource {tenant_id: $tenantId})
           RETURN properties(n) AS p ORDER BY n.name`,
          { tenantId: ctx.tenantId },
        )
        return rows.map(r => mapSource(r.p))
      } finally {
        await session.close()
      }
    },

    syncSource: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const session = getSession()
      try {
        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`,
          { id: args.id, tenantId: ctx.tenantId },
        )
        return row ? mapSource(row.p) : null
      } finally {
        await session.close()
      }
    },

    syncRuns: async (
      _: unknown,
      args: { sourceId: string; limit?: number; offset?: number; sortField?: string; sortDirection?: string },
      ctx: GraphQLContext,
    ) => {
      const limit  = args.limit  ?? 20
      const offset = args.offset ?? 0
      const SYNC_RUN_SORT_WHITELIST: Record<string, string> = {
        syncType:  'sync_type',
        status:    'status',
        startedAt: 'started_at',
        durationMs: 'duration_ms',
      }
      const sortCol = args.sortField && SYNC_RUN_SORT_WHITELIST[args.sortField]
      const orderBy = sortCol
        ? `n.${sortCol} ${args.sortDirection?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`
        : 'n.started_at DESC'
      const session = getSession()
      try {
        type Row = { p: Props; total: unknown }
        const rows = await runQuery<Row>(session,
          `MATCH (n:SyncRun {source_id: $sourceId, tenant_id: $tenantId})
           WITH count(n) AS total, collect(n) AS all
           UNWIND all AS n
           RETURN properties(n) AS p, total
           ORDER BY ${orderBy} SKIP $offset LIMIT $limit`,
          { sourceId: args.sourceId, tenantId: ctx.tenantId, offset, limit },
        )
        const total = rows[0] ? toNum(rows[0].total) : 0
        return { items: rows.map(r => mapRun(r.p)), total }
      } finally {
        await session.close()
      }
    },

    syncConflicts: async (
      _: unknown,
      args: { sourceId?: string; status?: string; limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      const limit  = args.limit  ?? 20
      const offset = args.offset ?? 0
      const session = getSession()
      try {
        const filters: string[] = ['n.tenant_id = $tenantId']
        const params: Record<string, unknown> = { tenantId: ctx.tenantId, offset, limit }
        if (args.sourceId) { filters.push('n.source_id = $sourceId'); params['sourceId'] = args.sourceId }
        if (args.status)   { filters.push('n.status = $status');       params['status']   = args.status }

        type Row = { p: Props; total: unknown }
        const rows = await runQuery<Row>(session,
          `MATCH (n:SyncConflict) WHERE ${filters.join(' AND ')}
           WITH count(n) AS total, collect(n) AS all
           UNWIND all AS n
           RETURN properties(n) AS p, total
           ORDER BY n.created_at DESC SKIP $offset LIMIT $limit`,
          params,
        )
        const total = rows[0] ? toNum(rows[0].total) : 0
        return { items: rows.map(r => mapConflict(r.p)), total }
      } finally {
        await session.close()
      }
    },

    syncStats: async (_: unknown, args: { sourceId?: string }, ctx: GraphQLContext) => {
      const session = getSession()
      try {
        type StatsRow = {
          totalSources: unknown; enabledSources: unknown; lastSyncAt: unknown
          ciManaged: unknown; openConflicts: unknown; totalRuns: unknown
          successRuns: unknown
        }
        const rows = await runQuery<StatsRow>(session, `
          MATCH (s:SyncSource {tenant_id: $tenantId})
          WITH count(s) AS totalSources, sum(CASE WHEN s.enabled THEN 1 ELSE 0 END) AS enabledSources,
               max(s.last_sync_at) AS lastSyncAt
          OPTIONAL MATCH (ci:ConfigurationItem {tenant_id: $tenantId}) WHERE ci.discovery_source IS NOT NULL
          WITH totalSources, enabledSources, lastSyncAt, count(ci) AS ciManaged
          OPTIONAL MATCH (c:SyncConflict {tenant_id: $tenantId, status: 'open'})
          WITH totalSources, enabledSources, lastSyncAt, ciManaged, count(c) AS openConflicts
          OPTIONAL MATCH (r:SyncRun {tenant_id: $tenantId})
          RETURN totalSources, enabledSources, lastSyncAt, ciManaged, openConflicts,
                 count(r) AS totalRuns,
                 sum(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS successRuns
        `, { tenantId: ctx.tenantId })

        const s = rows[0] ?? {}
        const total   = toNum(s.totalRuns)
        const success = toNum(s.successRuns)
        return {
          totalSources:   toNum(s.totalSources),
          enabledSources: toNum(s.enabledSources),
          lastSyncAt:     s.lastSyncAt ? toStr(s.lastSyncAt) : null,
          ciManaged:      toNum(s.ciManaged),
          openConflicts:  toNum(s.openConflicts),
          totalRuns:      total,
          successRate:    total > 0 ? Math.round((success / total) * 100) / 100 : 0,
        }
      } finally {
        await session.close()
      }
    },

    availableConnectors: (_: unknown, __: unknown, _ctx: GraphQLContext) => {
      return getAllConnectors().map(c => ({
        type:             c.type,
        displayName:      c.displayName,
        supportedCITypes: c.supportedCITypes,
        credentialFields: c.getRequiredCredentialFields().map(f => ({
          name:         f.name,
          label:        f.label,
          type:         f.type,
          required:     f.required,
          placeholder:  f.placeholder ?? null,
          helpText:     f.help_text   ?? null,
          options:      null,
          defaultValue: null,
        })),
        configFields: c.getConfigFields().map(f => ({
          name:         f.name,
          label:        f.label,
          type:         f.type,
          required:     f.required,
          placeholder:  null,
          helpText:     f.help_text    ?? null,
          options:      f.options      ?? null,
          defaultValue: f.default_value != null ? String(f.default_value) : null,
        })),
      }))
    },
  },

  Mutation: {
    createSyncSource: async (
      _: unknown,
      args: { input: {
        name: string; connectorType: string; credentials: string
        config: string; mappingRules?: string; scheduleCron?: string; enabled?: boolean
      }},
      ctx: GraphQLContext,
    ) => {
      const { input } = args
      const creds = JSON.parse(input.credentials) as Record<string, string>
      const encryptedCreds = encryptCredentials(creds, ENCRYPTION_KEY)

      const id  = randomUUID()
      const now = new Date().toISOString()
      const session = getSession()
      try {
        await session.executeWrite(tx => tx.run(
          `CREATE (n:SyncSource {
            id: $id, tenant_id: $tenantId, name: $name,
            connector_type: $connectorType, encrypted_credentials: $encryptedCreds,
            config: $config, mapping_rules: $mappingRules,
            schedule_cron: $scheduleCron, enabled: $enabled,
            created_at: $now, updated_at: $now
          })`,
          {
            id, tenantId: ctx.tenantId, name: input.name,
            connectorType: input.connectorType, encryptedCreds,
            config: input.config, mappingRules: input.mappingRules ?? '[]',
            scheduleCron: input.scheduleCron ?? null, enabled: input.enabled ?? true,
            now,
          },
        ))
        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (n:SyncSource {id: $id}) RETURN properties(n) AS p`, { id },
        )
        return mapSource(row!.p)
      } finally {
        await session.close()
      }
    },

    updateSyncSource: async (
      _: unknown,
      args: { id: string; input: {
        name?: string; credentials?: string; config?: string
        mappingRules?: string; scheduleCron?: string; enabled?: boolean
      }},
      ctx: GraphQLContext,
    ) => {
      const { id, input } = args
      const now = new Date().toISOString()
      const sets: string[] = ['n.updated_at = $now']
      const params: Record<string, unknown> = { id, tenantId: ctx.tenantId, now }

      if (input.name         != null) { sets.push('n.name = $name');                    params['name']         = input.name }
      if (input.config       != null) { sets.push('n.config = $config');                params['config']       = input.config }
      if (input.mappingRules != null) { sets.push('n.mapping_rules = $mappingRules');    params['mappingRules'] = input.mappingRules }
      if (input.scheduleCron != null) { sets.push('n.schedule_cron = $scheduleCron');    params['scheduleCron'] = input.scheduleCron }
      if (input.enabled      != null) { sets.push('n.enabled = $enabled');               params['enabled']      = input.enabled }
      if (input.credentials  != null) {
        const creds = JSON.parse(input.credentials) as Record<string, string>
        const enc   = encryptCredentials(creds, ENCRYPTION_KEY)
        sets.push('n.encrypted_credentials = $encryptedCreds')
        params['encryptedCreds'] = enc
      }

      const session = getSession()
      try {
        await session.executeWrite(tx => tx.run(
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) SET ${sets.join(', ')}`,
          params,
        ))
        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (n:SyncSource {id: $id}) RETURN properties(n) AS p`, { id },
        )
        return mapSource(row!.p)
      } finally {
        await session.close()
      }
    },

    deleteSyncSource: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const session = getSession()
      try {
        await session.executeWrite(tx => tx.run(
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) DETACH DELETE n`,
          { id: args.id, tenantId: ctx.tenantId },
        ))
        return true
      } finally {
        await session.close()
      }
    },

    triggerSync: async (
      _: unknown,
      args: { sourceId: string; syncType?: string },
      ctx: GraphQLContext,
    ) => {
      const runId    = randomUUID()
      const now      = new Date().toISOString()
      const syncType = args.syncType ?? 'manual'

      const session = getSession()
      try {
        await session.executeWrite(tx => tx.run(
          `CREATE (r:SyncRun {
            id: $runId, source_id: $sourceId, tenant_id: $tenantId,
            sync_type: $syncType, status: 'queued',
            ci_created: 0, ci_updated: 0, ci_unchanged: 0, ci_stale: 0, ci_conflicts: 0,
            relations_created: 0, relations_removed: 0,
            started_at: $now, updated_at: $now
          })`,
          { runId, sourceId: args.sourceId, tenantId: ctx.tenantId, syncType, now },
        ))

        await syncQueue.add('sync', {
          runId,
          sourceId:  args.sourceId,
          tenantId:  ctx.tenantId,
          syncType,
        }, { jobId: `sync-${runId}` })

        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (r:SyncRun {id: $id}) RETURN properties(r) AS p`, { id: runId },
        )
        return mapRun(row!.p)
      } finally {
        await session.close()
      }
    },

    resolveConflict: async (
      _: unknown,
      args: { conflictId: string; resolution: string },
      ctx: GraphQLContext,
    ) => {
      const now = new Date().toISOString()
      const session = getSession()
      try {
        // Load conflict data
        const conflictRow = await runQueryOne<{ p: Props }>(session,
          `MATCH (c:SyncConflict {id: $id, tenant_id: $tenantId}) RETURN properties(c) AS p`,
          { id: args.conflictId, tenantId: ctx.tenantId },
        )
        if (!conflictRow) throw new Error('Conflict not found')

        const conflict = mapConflict(conflictRow.p)
        const discovered = JSON.parse(conflict.discoveredCi) as Record<string, unknown>
        const discoveredProps  = (discovered['properties']  ?? {}) as Record<string, unknown>
        const discoveredTags   = (discovered['tags']        ?? {}) as Record<string, string>
        const discoveredName   = discovered['name']        as string | undefined
        const discoveredExtId  = discovered['external_id'] as string | undefined
        const discoveredSource = discovered['source']      as string | undefined
        const ciLabel = conflict.ciType
          .split('_')
          .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
          .join('')

        if (args.resolution === 'merged') {
          // Update existing CI with discovered properties
          const propSets: string[] = [
            'ci.updated_at = $now',
            'ci.discovery_source = $source',
            'ci.discovery_external_id = $externalId',
            'ci.discovery_last_seen_at = $now',
          ]
          if (discoveredName) propSets.push('ci.name = $discoveredName')
          const propsJson = JSON.stringify(discoveredProps)
          const tagsJson  = JSON.stringify(discoveredTags)

          await session.executeWrite(tx => tx.run(
            `MATCH (ci:ConfigurationItem {id: $existingCiId, tenant_id: $tenantId})
             SET ${propSets.join(', ')}, ci.properties = $propsJson, ci.tags = $tagsJson`,
            {
              existingCiId:   conflict.existingCiId,
              tenantId:       ctx.tenantId,
              now,
              source:         discoveredSource ?? '',
              externalId:     discoveredExtId  ?? '',
              discoveredName: discoveredName   ?? '',
              propsJson,
              tagsJson,
            },
          ))

        } else if (args.resolution === 'distinct') {
          // Create a brand-new CI from discovered data
          const newCiId = randomUUID()
          await session.executeWrite(tx => tx.run(
            `CREATE (ci:ConfigurationItem:${ciLabel} {
               id: $newCiId,
               tenant_id: $tenantId,
               name: $name,
               ci_type: $ciType,
               status: 'active',
               discovery_source: $source,
               discovery_external_id: $externalId,
               discovery_last_seen_at: $now,
               properties: $propsJson,
               tags: $tagsJson,
               created_at: $now,
               updated_at: $now
             })`,
            {
              newCiId,
              tenantId: ctx.tenantId,
              name:      discoveredName  ?? discoveredExtId ?? 'Unknown',
              ciType:    conflict.ciType,
              source:    discoveredSource ?? '',
              externalId: discoveredExtId ?? '',
              now,
              propsJson:  JSON.stringify(discoveredProps),
              tagsJson:   JSON.stringify(discoveredTags),
            },
          ))

        } else if (args.resolution === 'linked') {
          // Create new CI from discovered data AND link it bidirectionally to existing CI
          const newCiId = randomUUID()
          await session.executeWrite(tx => tx.run(
            `CREATE (ci:ConfigurationItem:${ciLabel} {
               id: $newCiId,
               tenant_id: $tenantId,
               name: $name,
               ci_type: $ciType,
               status: 'active',
               discovery_source: $source,
               discovery_external_id: $externalId,
               discovery_last_seen_at: $now,
               properties: $propsJson,
               tags: $tagsJson,
               created_at: $now,
               updated_at: $now
             })
             WITH ci
             MATCH (existing:ConfigurationItem {id: $existingCiId, tenant_id: $tenantId})
             MERGE (ci)-[:RELATED_TO {created_at: $now}]->(existing)
             MERGE (existing)-[:RELATED_TO {created_at: $now}]->(ci)`,
            {
              newCiId,
              tenantId:    ctx.tenantId,
              name:        discoveredName  ?? discoveredExtId ?? 'Unknown',
              ciType:      conflict.ciType,
              source:      discoveredSource ?? '',
              externalId:  discoveredExtId  ?? '',
              existingCiId: conflict.existingCiId,
              now,
              propsJson:   JSON.stringify(discoveredProps),
              tagsJson:    JSON.stringify(discoveredTags),
            },
          ))
        }

        // Mark conflict as resolved
        await session.executeWrite(tx => tx.run(
          `MATCH (c:SyncConflict {id: $id, tenant_id: $tenantId})
           SET c.status = 'resolved', c.resolution = $resolution, c.resolved_at = $now`,
          { id: args.conflictId, tenantId: ctx.tenantId, resolution: args.resolution, now },
        ))

        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (c:SyncConflict {id: $id}) RETURN properties(c) AS p`, { id: args.conflictId },
        )
        return mapConflict(row!.p)
      } finally {
        await session.close()
      }
    },

    testSyncConnection: async (
      _: unknown,
      args: { sourceId: string },
      ctx: GraphQLContext,
    ) => {
      const session = getSession()
      try {
        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`,
          { id: args.sourceId, tenantId: ctx.tenantId },
        )
        if (!row) return { ok: false, message: 'Source not found', details: null }

        const source = mapSource(row.p)
        const connector = getConnector(source.connectorType)
        if (!connector) return { ok: false, message: `Connector "${source.connectorType}" not registered`, details: null }

        const encRow = await runQueryOne<{ enc: string }>(session,
          `MATCH (n:SyncSource {id: $id}) RETURN n.encrypted_credentials AS enc`,
          { id: args.sourceId },
        )
        const creds = decryptCredentials(encRow!.enc, ENCRYPTION_KEY)
        const syncConfig: import('@opengraphity/discovery').SyncSourceConfig = {
          id:                    source.id,
          tenant_id:             source.tenantId,
          name:                  source.name,
          connector_type:        source.connectorType,
          encrypted_credentials: encRow!.enc,
          config:                JSON.parse(source.config) as Record<string, unknown>,
          mapping_rules:         JSON.parse(source.mappingRules),
          schedule_cron:         source.scheduleCron,
          enabled:               source.enabled,
          last_sync_at:          source.lastSyncAt,
          last_sync_status:      source.lastSyncStatus as 'completed' | 'failed' | null,
          last_sync_duration_ms: source.lastSyncDurationMs,
          created_at:            source.createdAt,
          updated_at:            source.updatedAt,
        }
        const result = await connector.testConnection(syncConfig, creds)
        return {
          ok:      result.ok,
          message: result.message,
          details: result.details ? JSON.stringify(result.details) : null,
        }
      } finally {
        await session.close()
      }
    },
  },
}
