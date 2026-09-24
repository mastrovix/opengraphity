import { randomUUID } from 'crypto'
import { runQuery, runQueryOne, toNumber } from '@opengraphity/neo4j'
import {
  encryptCredentials,
  decryptCredentials,
  getAllConnectors,
  getConnector,
} from '@opengraphity/discovery'
import type { GraphQLContext } from '../../context.js'
import { scheduleSourceSync, syncQueueOf } from '../../discovery/syncWorker.js'
import { CONFLICT_LOCKED_FIELDS, CONFLICT_UNKNOWN_CI_TYPE } from '../../discovery/reconciliationEngine.js'
import { CITypeResolver } from '../../discovery/ciTypeResolution.js'
import { withSession } from './ci-utils.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { validateStringLength, validateCronExpression } from '../../lib/validation.js'
import { audit } from '../../lib/audit.js'
import { notifyCIGraphChanged } from '../../services/serviceImpact/sync.js'
import { notAdmittedError, relationAdmission } from '../../services/cmdbChains/admission.js'
import { initialCIStatus } from '../../lib/ciLifecycle.js'
import { normalizeProperties } from '@opengraphity/discovery'

/**
 * Le proprietà scoperte come le scrive il motore di riconciliazione (revisione
 * totale · D-3): appiattite sul nodo, con i tag come proprietà, mai una stringa
 * JSON — le pagine CMDB e la validazione del metamodello leggono le proprietà,
 * non un campo `properties`. I nomi strutturali non si sovrascrivono da qui.
 */
const RESOLVE_RESERVED_PROPS = new Set(['id', 'tenant_id', 'name', 'name_key', 'type', 'status', 'created_at', 'updated_at'])
function flatDiscoveredProps(properties: Record<string, unknown>, tags: Record<string, string>): Record<string, unknown> {
  const flat = normalizeProperties({ ...properties, ...tags })
  for (const key of Object.keys(flat)) {
    if (RESERVED_PREFIX_RE.test(key) || RESOLVE_RESERVED_PROPS.has(key)) delete flat[key]
  }
  return flat
}
const RESERVED_PREFIX_RE = /^(discovery_|discovered_)/

function encryptionKey(): string {
  const k = process.env['DISCOVERY_ENCRYPTION_KEY']
  if (!k) throw new Error('DISCOVERY_ENCRYPTION_KEY is not set — cannot process discovery credentials')
  return k
}

type Props = Record<string, unknown>

function toStr(v: unknown): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return String(v)
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
    lastSyncDurationMs: p['last_sync_duration_ms'] ? toNumber(p['last_sync_duration_ms']) : null,
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
    ciCreated:        toNumber(p['ci_created']),
    ciUpdated:        toNumber(p['ci_updated']),
    ciUnchanged:      toNumber(p['ci_unchanged']),
    ciStale:          toNumber(p['ci_stale']),
    ciConflicts:      toNumber(p['ci_conflicts']),
    relationsCreated: toNumber(p['relations_created']),
    relationsRemoved: toNumber(p['relations_removed']),
    // Runs before 24 Sep 2026 have no counter: nothing was refused then.
    relationsRefused: p['relations_refused'] == null ? 0 : toNumber(p['relations_refused']),
    durationMs:       p['duration_ms']    ? toNumber(p['duration_ms'])    : null,
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
    // I conflitti scritti prima dell'ondata 6 non hanno `conflict_kind`: erano
    // tutti del genere «campo bloccato», quindi il default non inventa niente.
    kind:           toStr(p['conflict_kind'] ?? CONFLICT_LOCKED_FIELDS),
    message:        p['message'] ? toStr(p['message']) : null,
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
      return withSession(async (session) => {
        const rows = await runQuery<{ p: Props }>(session,
          `MATCH (n:SyncSource {tenant_id: $tenantId})
           RETURN properties(n) AS p ORDER BY n.name`,
          { tenantId: ctx.tenantId },
        )
        return rows.map(r => mapSource(r.p))
      })
    },

    syncSource: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      return withSession(async (session) => {
        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`,
          { id: args.id, tenantId: ctx.tenantId },
        )
        return row ? mapSource(row.p) : null
      })
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
      return withSession(async (session) => {
        type Row = { p: Props; total: unknown }
        const rows = await runQuery<Row>(session,
          `MATCH (n:SyncRun {source_id: $sourceId, tenant_id: $tenantId})
           WITH count(n) AS total, collect(n) AS all
           UNWIND all AS n
           RETURN properties(n) AS p, total
           ORDER BY ${orderBy} SKIP toInteger($offset) LIMIT toInteger($limit)`,
          { sourceId: args.sourceId, tenantId: ctx.tenantId, offset, limit },
        )
        const total = rows[0] ? toNumber(rows[0].total) : 0
        return { items: rows.map(r => mapRun(r.p)), total }
      })
    },

    syncConflicts: async (
      _: unknown,
      args: { sourceId?: string; status?: string; limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      const limit  = args.limit  ?? 20
      const offset = args.offset ?? 0
      return withSession(async (session) => {
        const filters: string[] = ['n.tenant_id = $tenantId']
        const params: Record<string, unknown> = { tenantId: ctx.tenantId, offset, limit }
        if (args.sourceId) { filters.push('n.source_id = $sourceId'); params['sourceId'] = args.sourceId }
        if (args.status)   { filters.push('n.status = $status');       params['status']   = args.status }

        type Row = { p: Props; total: unknown }
        const rows = await runQuery<Row>(session,
          // tenant-ok(where-scopato): `filters` parte da `n.tenant_id = $tenantId` (riga sopra)
          `MATCH (n:SyncConflict) WHERE ${filters.join(' AND ')}
           WITH count(n) AS total, collect(n) AS all
           UNWIND all AS n
           RETURN properties(n) AS p, total
           ORDER BY n.created_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)`,
          params,
        )
        const total = rows[0] ? toNumber(rows[0].total) : 0
        return { items: rows.map(r => mapConflict(r.p)), total }
      })
    },

    syncStats: async (_: unknown, args: { sourceId?: string }, ctx: GraphQLContext) => {
      return withSession(async (session) => {
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
        const total   = toNumber(s.totalRuns)
        const success = toNumber(s.successRuns)
        return {
          totalSources:   toNumber(s.totalSources),
          enabledSources: toNumber(s.enabledSources),
          lastSyncAt:     s.lastSyncAt ? toStr(s.lastSyncAt) : null,
          ciManaged:      toNumber(s.ciManaged),
          openConflicts:  toNumber(s.openConflicts),
          totalRuns:      total,
          successRate:    total > 0 ? Math.round((success / total) * 100) / 100 : 0,
        }
      })
    },

    syncChangeHistory: async (
      _: unknown,
      args: { ciId: string; limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      return withSession(async (session) => {
        const limit  = args.limit  ?? 50
        const offset = args.offset ?? 0
        const result = await session.executeRead(tx =>
          tx.run(`
            MATCH (r:SyncChangeRecord {ci_id: $ciId, tenant_id: $tenantId})
            RETURN properties(r) AS p
            ORDER BY r.changed_at DESC
            SKIP toInteger($offset) LIMIT toInteger($limit)
          `, { ciId: args.ciId, tenantId: ctx.tenantId, offset, limit }),
        )
        const countRes = await session.executeRead(tx =>
          tx.run(`MATCH (r:SyncChangeRecord {ci_id: $ciId, tenant_id: $tenantId}) RETURN count(r) AS cnt`, { ciId: args.ciId, tenantId: ctx.tenantId }),
        )
        const total = toNumber(countRes.records[0]?.get('cnt') ?? 0)
        const items = result.records.map(rec => {
          const p = rec.get('p') as Props
          return {
            id:            toStr(p['id']),
            ciId:          toStr(p['ci_id']),
            sourceId:      toStr(p['source_id']),
            tenantId:      toStr(p['tenant_id']),
            changedAt:     toStr(p['changed_at']),
            changedFields: toStr(p['changed_fields'] ?? '[]'),
            oldValues:     toStr(p['old_values']     ?? '{}'),
            newValues:     toStr(p['new_values']     ?? '{}'),
          }
        })
        return { items, total }
      })
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
      validateStringLength(input.name, 'name', 1, 200)
      validateCronExpression(input.scheduleCron)
      const creds = JSON.parse(input.credentials) as Record<string, string>
      const encryptedCreds = encryptCredentials(creds, encryptionKey())

      const id  = randomUUID()
      const now = new Date().toISOString()
      return withSession(async (session) => {
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
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`, { id, tenantId: ctx.tenantId },
        )
        const newSource = mapSource(row!.p)
        // Il cron parte subito, senza aspettare un riavvio dell'API (D-6).
        await scheduleSourceSync({ id, tenantId: ctx.tenantId, cron: newSource.scheduleCron ?? null, enabled: newSource.enabled !== false })
        void audit(ctx, 'sync_source.created', 'SyncSource', id)
        return newSource
      }, true)
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
      // Il cron si valida anche in modifica (revisione totale · D-7): prima lo
      // faceva solo la creazione, e un cron non valido salvato qui impediva
      // l'avvio dell'API alla registrazione dei repeat job.
      if (input.scheduleCron != null) { validateCronExpression(input.scheduleCron); sets.push('n.schedule_cron = $scheduleCron'); params['scheduleCron'] = input.scheduleCron }
      if (input.enabled      != null) { sets.push('n.enabled = $enabled');               params['enabled']      = input.enabled }
      if (input.credentials  != null) {
        const creds = JSON.parse(input.credentials) as Record<string, string>
        const enc   = encryptCredentials(creds, encryptionKey())
        sets.push('n.encrypted_credentials = $encryptedCreds')
        params['encryptedCreds'] = enc
      }

      return withSession(async (session) => {
        await session.executeWrite(tx => tx.run(
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) SET ${sets.join(', ')}`,
          params,
        ))
        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`, { id, tenantId: ctx.tenantId },
        )
        void audit(ctx, 'sync_source.updated', 'SyncSource', id)
        // Il cron in Redis segue la sorgente (D-6): spenta o con un cron nuovo,
        // il vecchio repeat job non resta a scattare.
        const updated = mapSource(row!.p)
        await scheduleSourceSync({ id, tenantId: ctx.tenantId, cron: updated.scheduleCron ?? null, enabled: updated.enabled !== false })
        return updated
      }, true)
    },

    deleteSyncSource: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      return withSession(async (session) => {
        await session.executeWrite(tx => tx.run(
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) DETACH DELETE n`,
          { id: args.id, tenantId: ctx.tenantId },
        ))
        // Niente cron orfano in Redis (D-6): scattava per sempre, e ogni volta
        // il job falliva con «SyncSource not found».
        await scheduleSourceSync({ id: args.id, tenantId: ctx.tenantId, cron: null, enabled: false })
        void audit(ctx, 'sync_source.deleted', 'SyncSource', args.id)
        return true
      }, true)
    },

    triggerSync: async (
      _: unknown,
      args: { sourceId: string; syncType?: string },
      ctx: GraphQLContext,
    ) => {
      const runId    = randomUUID()
      const now      = new Date().toISOString()
      const syncType = args.syncType ?? 'manual'

      return withSession(async (session) => {
        /**
         * La sorgente deve ESISTERE nel tenant (revisione totale · D-17):
         * senza controllo si creava una run `queued` e si accodava il job, che
         * poi falliva prima di aggiornare lo stato — la run restava «in coda»
         * per sempre nell'elenco, e l'admin non capiva cosa aspettasse.
         */
        const source = await runQueryOne<{ id: string }>(session,
          'MATCH (n:SyncSource {id: $sourceId, tenant_id: $tenantId}) RETURN n.id AS id',
          { sourceId: args.sourceId, tenantId: ctx.tenantId })
        if (!source) throw new NotFoundError('SyncSource', args.sourceId)

        await session.executeWrite(tx => tx.run(
          `CREATE (r:SyncRun {
            id: $runId, source_id: $sourceId, tenant_id: $tenantId,
            sync_type: $syncType, status: 'queued',
            ci_created: 0, ci_updated: 0, ci_unchanged: 0, ci_stale: 0, ci_conflicts: 0,
            relations_created: 0, relations_removed: 0, relations_refused: 0,
            started_at: $now, updated_at: $now
          })`,
          { runId, sourceId: args.sourceId, tenantId: ctx.tenantId, syncType, now },
        ))

        await syncQueueOf(ctx.tenantId).add('sync', {
          runId,
          sourceId:  args.sourceId,
          tenantId:  ctx.tenantId,
          syncType,
        }, { jobId: `sync-${runId}` })

        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (r:SyncRun {id: $id, tenant_id: $tenantId}) RETURN properties(r) AS p`, { id: runId, tenantId: ctx.tenantId },
        )
        void audit(ctx, 'sync.triggered', 'SyncRun', runId)
        return mapRun(row!.p)
      }, true)
    },

    resolveConflict: async (
      _: unknown,
      args: { conflictId: string; resolution: string },
      ctx: GraphQLContext,
    ) => {
      const now = new Date().toISOString()
      return withSession(async (session) => {
        // Load conflict data
        const conflictRow = await runQueryOne<{ p: Props }>(session,
          `MATCH (c:SyncConflict {id: $id, tenant_id: $tenantId}) RETURN properties(c) AS p`,
          { id: args.conflictId, tenantId: ctx.tenantId },
        )
        if (!conflictRow) throw new NotFoundError('Conflict', args.conflictId)

        const conflict = mapConflict(conflictRow.p)
        // A-11: un conflitto «tipo sconosciuto» non si risolve da qui. Le tre
        // risoluzioni (merged/distinct/linked) parlano di un CI esistente e di
        // un CI da creare: qui non c'è nessun CI esistente e il tipo da creare
        // non esiste nel metamodello. Risolverlo avrebbe creato l'etichetta
        // inventata che la riconciliazione ha appena rifiutato.
        if (conflict.kind === CONFLICT_UNKNOWN_CI_TYPE) {
          throw new ValidationError(
            `Conflict ${args.conflictId} is of kind ${CONFLICT_UNKNOWN_CI_TYPE}: no CI was created, `
            + `because "${conflict.ciType}" is not a CI type of this tenant. `
            + `${conflict.message ?? ''} Fix it at the root (create the type, or add an alias in the source's `
            + `mapping rules) and run the sync again: the conflict closes by itself.`,
            { key: 'errors.sync.unknownCIType', params: { id: args.conflictId, ciType: conflict.ciType ?? '' } },
          )
        }
        const discovered = JSON.parse(conflict.discoveredCi) as Record<string, unknown>
        // Revisione totale · D-3: il CI che nasce (o si aggiorna) da qui deve
        // avere la FORMA che il motore riconosce — `type` (non `ci_type`),
        // proprietà appiattite (non un JSON), `discovery_source_id`,
        // `discovery_status`, `discovery_last_seen`. Prima erano diverse: al run
        // successivo `findExisting` non trovava il CI (manca
        // `discovery_source_id`) e il MERGE ne creava un ALTRO, uno per run;
        // `markStale` non lo toccava mai e le pagine CMDB non vedevano le
        // proprietà (erano dentro una stringa JSON).
        const discoveredProps  = (discovered['properties']  ?? {}) as Record<string, unknown>
        const discoveredTags   = (discovered['tags']        ?? {}) as Record<string, string>
        const discoveredName   = discovered['name']        as string | undefined
        const discoveredExtId  = discovered['external_id'] as string | undefined
        const discoveredSource = discovered['source']      as string | undefined
        // A-11: l'etichetta viene dal TIPO risolto nel metamodello del cliente,
        // non dal PascalCase della stringa. Prima un conflitto su un `ci_type`
        // che non esiste creava `:ConfigurationItem:Bilanciatore`, cioè un CI
        // che nessuna pagina mostra — lo stesso difetto della riconciliazione,
        // per un'altra strada.
        const sourceRow = await runQueryOne<{ rules: string }>(session,
          `MATCH (n:SyncSource {id: $sourceId, tenant_id: $tenantId}) RETURN coalesce(n.mapping_rules, '[]') AS rules`,
          { sourceId: conflict.sourceId, tenantId: ctx.tenantId },
        )
        const resolver = await CITypeResolver.forSource(ctx.tenantId, {
          mapping_rules: JSON.parse(sourceRow?.rules ?? '[]') as never,
        })
        const resolvedType = resolver.resolve(conflict.ciType)
        if (!resolvedType.ok) {
          throw new ValidationError(
            `Conflict ${args.conflictId} cannot be resolved: ${resolvedType.reason}`,
            { key: 'errors.sync.unresolvable', params: { id: args.conflictId, reason: resolvedType.reason } },
          )
        }
        const ciLabel = resolvedType.type.label

        if (args.resolution === 'merged') {
          // Update existing CI with discovered properties
          const propSets: string[] = [
            'ci.updated_at = $now',
            'ci.discovery_source = $source',
            'ci.discovery_source_id = $sourceId',
            'ci.discovery_external_id = $externalId',
            'ci.discovery_status = \'active\'',
            'ci.discovery_stale_since = null',
            'ci.discovery_last_seen = $now',
          ]
          if (discoveredName) propSets.push('ci.name = $discoveredName', 'ci.name_key = toLower($discoveredName)')   // name_key: lib/ciNameKey.ts

          await session.executeWrite(tx => tx.run(
            `MATCH (ci:ConfigurationItem {id: $existingCiId, tenant_id: $tenantId})
             SET ${propSets.join(', ')}, ci += $props`,
            {
              existingCiId:   conflict.existingCiId,
              tenantId:       ctx.tenantId,
              now,
              source:         discoveredSource ?? '',
              sourceId:       conflict.sourceId,
              externalId:     discoveredExtId  ?? '',
              discoveredName: discoveredName   ?? '',
              // Le proprietà scoperte, appiattite come le scrive il motore.
              props: flatDiscoveredProps(discoveredProps, discoveredTags),
            },
          ))

        } else if (args.resolution === 'distinct') {
          // Create a brand-new CI from discovered data
          const newCiId = randomUUID()
          const initialStatus = await initialCIStatus(ctx.tenantId)
          await session.executeWrite(tx => tx.run(
            `CREATE (ci:ConfigurationItem:${ciLabel} {
               id: $newCiId,
               tenant_id: $tenantId,
               name: $name,
               name_key: toLower($name),
               type: $ciType,
               status: $initialStatus,
               discovery_source: $source,
               discovery_source_id: $sourceId,
               discovery_external_id: $externalId,
               discovery_status: 'active',
               discovery_last_seen: $now,
               discovered_at: $now,
               discovery_locked_fields: [],
               created_at: $now,
               updated_at: $now
             })
             SET ci += $props`,
            {
              newCiId,
              tenantId: ctx.tenantId,
              name:      discoveredName  ?? discoveredExtId ?? 'Unknown',
              ciType:    resolvedType.type.name,
              source:    discoveredSource ?? '',
              sourceId:  conflict.sourceId,
              externalId: discoveredExtId ?? '',
              now,
              initialStatus,
              props: flatDiscoveredProps(discoveredProps, discoveredTags),
            },
          ))

        } else if (args.resolution === 'linked') {
          // The two RELATED_TO are relations between CIs like any other: a CMDB chain
          // must admit them, both ways, before anything is created (owner, 24 Sep 2026).
          const existing = await session.executeRead((tx) => tx.run(
            `MATCH (e:ConfigurationItem {id: $id, tenant_id: $tenantId}) RETURN labels(e) AS labels`,
            { id: conflict.existingCiId, tenantId: ctx.tenantId }))
          const existingLabels = existing.records[0]?.get('labels') as string[] | undefined
          if (!existingLabels) throw new NotFoundError('ConfigurationItem', conflict.existingCiId)
          const newLabels = ['ConfigurationItem', ciLabel]
          const admission = await relationAdmission(session, ctx.tenantId)
          for (const [from, to] of [[newLabels, existingLabels], [existingLabels, newLabels]] as const) {
            if (!admission.admits('RELATED_TO', from, to)) throw notAdmittedError(admission, 'RELATED_TO', from, to)
          }
          // Create new CI from discovered data AND link it bidirectionally to existing CI
          const newCiId = randomUUID()
          const initialStatus = await initialCIStatus(ctx.tenantId)
          await session.executeWrite(tx => tx.run(
            `CREATE (ci:ConfigurationItem:${ciLabel} {
               id: $newCiId,
               tenant_id: $tenantId,
               name: $name,
               name_key: toLower($name),
               type: $ciType,
               status: $initialStatus,
               discovery_source: $source,
               discovery_source_id: $sourceId,
               discovery_external_id: $externalId,
               discovery_status: 'active',
               discovery_last_seen: $now,
               discovered_at: $now,
               discovery_locked_fields: [],
               created_at: $now,
               updated_at: $now
             })
             SET ci += $props
             WITH ci
             MATCH (existing:ConfigurationItem {id: $existingCiId, tenant_id: $tenantId})
             MERGE (ci)-[:RELATED_TO {created_at: $now}]->(existing)
             MERGE (existing)-[:RELATED_TO {created_at: $now}]->(ci)`,
            {
              newCiId,
              tenantId:    ctx.tenantId,
              name:        discoveredName  ?? discoveredExtId ?? 'Unknown',
              ciType:      resolvedType.type.name,
              source:      discoveredSource ?? '',
              sourceId:    conflict.sourceId,
              externalId:  discoveredExtId  ?? '',
              existingCiId: conflict.existingCiId,
              now,
              initialStatus,
              props: flatDiscoveredProps(discoveredProps, discoveredTags),
            },
          ))
          // Servizi monitorati (ondata 5): due RELATED_TO nuove fra CI. Non è
          // una relazione che la costruzione della mappa segue, ma la regola è
          // «ogni scrittura che tocca il grafo dei CI avvisa il motore»: la
          // sincronizzazione che ne segue è a vuoto (solo `synced_at`) e la
          // regola resta una sola, senza eccezioni da ricordare.
          await notifyCIGraphChanged(ctx.tenantId, [newCiId, conflict.existingCiId], 'sync_conflict.linked')
        }

        // Mark conflict as resolved
        await session.executeWrite(tx => tx.run(
          `MATCH (c:SyncConflict {id: $id, tenant_id: $tenantId})
           SET c.status = 'resolved', c.resolution = $resolution, c.resolved_at = $now`,
          { id: args.conflictId, tenantId: ctx.tenantId, resolution: args.resolution, now },
        ))

        // La rilettura è SCOPATA al tenant come tutte le altre (revisione
        // totale · B-31): era l'unica query del file che leggeva un conflitto
        // per solo id.
        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (c:SyncConflict {id: $id, tenant_id: $tenantId}) RETURN properties(c) AS p`,
          { id: args.conflictId, tenantId: ctx.tenantId },
        )
        if (!row) throw new NotFoundError('SyncConflict', args.conflictId)
        void audit(ctx, 'sync_conflict.resolved', 'SyncConflict', args.conflictId, { resolution: args.resolution })
        return mapConflict(row.p)
      }, true)
    },

    testSyncConnection: async (
      _: unknown,
      args: { sourceId: string },
      ctx: GraphQLContext,
    ) => {
      return withSession(async (session) => {
        const row = await runQueryOne<{ p: Props }>(session,
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS p`,
          { id: args.sourceId, tenantId: ctx.tenantId },
        )
        if (!row) return { ok: false, message: 'Source not found', details: null }

        const source = mapSource(row.p)
        const connector = getConnector(source.connectorType)
        if (!connector) return { ok: false, message: `Connector "${source.connectorType}" not registered`, details: null }

        const encRow = await runQueryOne<{ enc: string }>(session,
          `MATCH (n:SyncSource {id: $id, tenant_id: $tenantId}) RETURN n.encrypted_credentials AS enc`,
          { id: args.sourceId, tenantId: ctx.tenantId },
        )
        const creds = decryptCredentials(encRow!.enc, encryptionKey())
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
      })
    },
  },
}
