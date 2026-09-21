import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { getSession, runQuery, runQueryOne, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { enqueueTenantScan } from '../../anomaly/anomalyEngine.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { cache } from '../../lib/cache.js'
import { validateStringLength } from '../../lib/validation.js'
import { audit } from '../../lib/audit.js'
import { requirePermission } from '../../lib/permissions.js'
import {
  ANOMALY_RULE_SPECS, ANOMALY_SEVERITIES, anomalyRuleOptions, anomalyRuleProblem, loadAnomalyRuleConfigs,
  saveAnomalyRuleConfig, type AnomalyRuleConfig, type AnomalyRuleOptions,
} from '../../anomaly/ruleConfig.js'

/** Mirrors `enum ResolutionStatus` in schema-anomaly.ts — re-checked here so the stored status can never be an arbitrary string. */
export const RESOLUTION_STATUSES = ['resolved', 'false_positive', 'accepted_risk'] as const
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number]

export function assertResolutionStatus(value: unknown): ResolutionStatus {
  if (typeof value !== 'string' || !(RESOLUTION_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`Invalid resolutionStatus ${JSON.stringify(value)} — expected one of: ${RESOLUTION_STATUSES.join(', ')}`)
  }
  return value as ResolutionStatus
}

type Props = Record<string, unknown>

// Neo4j DateTime objects have a toString() that returns ISO string
function toStr(v: unknown): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  return String(v)
}

function anomalyParams(raw: unknown, id: string): Array<{ key: string; value: string }> {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Anomaly ${id}: description_params is not a map`)
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value) }))
}

function mapAnomaly(p: Props) {
  return {
    id:               toStr(p['id']),
    ruleKey:          toStr(p['rule_key']),
    title:            toStr(p['title']),
    severity:         toStr(p['severity']),
    status:           toStr(p['status']),
    entityId:         toStr(p['entity_id']),
    entityType:       toStr(p['entity_type']),
    entitySubtype:    toStr(p['entity_subtype']),
    entityName:       toStr(p['entity_name']),
    description:      toStr(p['description']),
    // Null su un'anomalia registrata prima del 14 set 2026 e non più riscontrata:
    // resta la sua frase storica. Ogni scansione riscrive quelle ancora aperte.
    descriptionParams: p['description_params'] == null ? null : anomalyParams(p['description_params'], toStr(p['id'])),
    detectedAt:       toStr(p['detected_at']),
    resolvedAt:       p['resolved_at']        ? toStr(p['resolved_at'])        : null,
    resolutionStatus: p['resolution_status']  ? toStr(p['resolution_status'])  : null,
    resolutionNote:   p['resolution_note']    ? toStr(p['resolution_note'])    : null,
    resolvedBy:       p['resolved_by']        ? toStr(p['resolved_by'])        : null,
    // G-ANO-8: il nome lo risolve il field resolver (una lettura sola per riga
    // mostrata, e solo se il client lo chiede).
    resolvedByName:   null as string | null,
    resolvedReason:   p['resolved_reason']    ? toStr(p['resolved_reason'])    : null,
    tenantId:         toStr(p['tenant_id']),
  }
}

/** La regola come la espone l'API: con le scelte possibili e il motivo per cui non gira, se c'è. */
function mapRuleConfig(config: AnomalyRuleConfig, options: AnomalyRuleOptions, openCount: number) {
  const spec = ANOMALY_RULE_SPECS[config.ruleKey]
  const problem = anomalyRuleProblem(config, options)
  const i18n = problem?.extensions['i18n'] as { key: string; params?: Record<string, string | number> } | undefined
  return {
    ruleKey: config.ruleKey, enabled: config.enabled, severity: config.severity,
    ciTypes: config.ciTypes, relations: config.relations, threshold: config.threshold,
    incidentSeverities: config.incidentSeverities, forbidden: config.forbidden,
    spec: {
      ciTypes: spec.ciTypes, relations: spec.relations, incidentSeverities: spec.incidentSeverities, forbidden: spec.forbidden,
      thresholdMin: spec.threshold?.min ?? null, thresholdMax: spec.threshold?.max ?? null,
    },
    isDefault: config.isDefault, updatedAt: config.updatedAt,
    problem: problem ? {
      key: i18n?.key ?? 'errors.anomalyRule.invalid',
      params: Object.entries(i18n?.params ?? {}).map(([key, value]) => ({ key, value: String(value) })),
      message: problem.message,
    } : null,
    openCount,
  }
}

async function openCountsByRule(tenantId: string): Promise<Map<string, number>> {
  const session = getSession()
  try {
    const rows = await runQuery<{ ruleKey: string; n: unknown }>(session, `
      MATCH (a:Anomaly {tenant_id: $tenantId, status: 'open'})
      RETURN a.rule_key AS ruleKey, count(a) AS n
    `, { tenantId })
    return new Map(rows.map((r) => [r.ruleKey, toNumber(r.n)]))
  } finally {
    await session.close()
  }
}

const ANOMALY_ALLOWED_FIELDS = new Set(['title', 'severity', 'status', 'ruleKey', 'detectedAt'])

/** Quanto vive la cache dei riquadri delle anomalie (G-ANO-7). */
const ANOMALY_STATS_TTL_SECONDS = 10

export const anomalyResolvers = {
  /**
   * G-ANO-8: il NOME di chi ha risolto, letto solo se il client lo chiede. Un
   * id che non è più un utente del tenant (persona rimossa) non diventa una
   * stringa tecnica a schermo: resta vuoto.
   */
  Anomaly: {
    resolvedByName: async (parent: { resolvedBy: string | null }, _: unknown, ctx: GraphQLContext) => {
      if (!parent.resolvedBy) return null
      const session = getSession(undefined, 'READ')
      try {
        const row = await runQueryOne<{ name: string | null }>(session,
          'MATCH (u:User {id: $id, tenant_id: $tenantId}) RETURN u.name AS name',
          { id: parent.resolvedBy, tenantId: ctx.tenantId })
        return row?.name ?? null
      } finally {
        await session.close()
      }
    },
  },

  Query: {
    anomalyRules: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const [configs, options, counts] = await Promise.all([
        loadAnomalyRuleConfigs(ctx.tenantId), anomalyRuleOptions(ctx.tenantId), openCountsByRule(ctx.tenantId),
      ])
      return configs.map((c) => mapRuleConfig(c, options, counts.get(c.ruleKey) ?? 0))
    },

    anomalyRuleOptions: async (_: unknown, __: unknown, ctx: GraphQLContext) => ({
      ...await anomalyRuleOptions(ctx.tenantId),
      severities: [...ANOMALY_SEVERITIES],
    }),

    anomalies: async (
      _: unknown,
      args: { limit?: number; offset?: number; filters?: string; sortField?: string; sortDirection?: string },
      ctx: GraphQLContext,
    ) => {
      const { limit = 50, offset = 0, filters, sortField, sortDirection } = args
      const ANOMALY_SORT_WHITELIST: Record<string, string> = {
        title:      'title',
        severity:   'severity',
        status:     'status',
        entityName: 'entity_name',
        detectedAt: 'detected_at',
      }
      const sortCol = sortField && ANOMALY_SORT_WHITELIST[sortField]
      const orderByClause = sortCol
        ? `a.${sortCol} ${sortDirection?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`
        : 'a.detected_at DESC'
      const session = getSession()
      try {
        const conditions: string[] = ['a.tenant_id = $tenantId']

        const params: Record<string, unknown> = { tenantId: ctx.tenantId, offset, limit }
        const advWhere = filters ? buildAdvancedWhere(filters, params, ANOMALY_ALLOWED_FIELDS, 'a') : ''
        if (advWhere) conditions.push(`(${advWhere})`)
        const where = 'WHERE ' + conditions.join(' AND ')

        // Two separate queries — same pattern as incident resolver
        const itemRows = await runQuery<{ props: Props }>(session, `
          // tenant-ok: il WHERE interpolato parte da a.tenant_id = $tenantId (conditions, riga 75)
          MATCH (a:Anomaly)
          ${where}
          WITH a ORDER BY ${orderByClause}
          SKIP toInteger($offset) LIMIT toInteger($limit)
          RETURN properties(a) AS props
        `, params)

        const countRows = await runQuery<{ total: unknown }>(session, `
          // tenant-ok: stesso $where della query di pagina, tenant per primo (conditions, riga 75)
          MATCH (a:Anomaly)
          ${where}
          RETURN count(a) AS total
        `, params)

        const total = toNumber(countRows[0]?.total)
        return { items: itemRows.map(r => mapAnomaly(r.props)), total }
      } finally {
        await session.close()
      }
    },

    anomaly: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const session = getSession()
      try {
        const row = await runQueryOne<{ props: Props }>(session, `
          MATCH (a:Anomaly {id: $id, tenant_id: $tenantId})
          RETURN properties(a) AS props
        `, { id: args.id, tenantId: ctx.tenantId })
        return row ? mapAnomaly(row.props) : null
      } finally {
        await session.close()
      }
    },

    anomalyScanStatus: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const session = getSession()
      try {
        const row = await runQueryOne<{ lastScanAt: unknown; totalScans: unknown }>(session, `
          MATCH (c:AnomalyConfig {tenant_id: $tenantId})
          RETURN c.last_scan_at AS lastScanAt, c.total_scans AS totalScans
        `, { tenantId: ctx.tenantId })
        return {
          lastScanAt: row ? toStr(row.lastScanAt) || null : null,
          totalScans: row ? toNumber(row.totalScans) : 0,
        }
      } finally {
        await session.close()
      }
    },

    anomalyStats: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const cacheKey = `anomaly-stats:${ctx.tenantId}`
      const cached = cache.get<ReturnType<typeof mapAnomaly>>(cacheKey)
      if (cached) return cached

      const session = getSession()
      try {
        type Row = Record<string, unknown>
        const row = await runQueryOne<Row>(session, `
          MATCH (a:Anomaly {tenant_id: $tenantId})
          RETURN
            count(a) AS total,
            count(CASE WHEN a.status = 'open'           THEN 1 END) AS open,
            count(CASE WHEN a.status = 'false_positive' THEN 1 END) AS falsePositive,
            count(CASE WHEN a.status = 'accepted_risk'  THEN 1 END) AS acceptedRisk,
            count(CASE WHEN a.severity = 'critical' AND a.status = 'open' THEN 1 END) AS critical,
            count(CASE WHEN a.severity = 'high'     AND a.status = 'open' THEN 1 END) AS high,
            count(CASE WHEN a.severity = 'medium'   AND a.status = 'open' THEN 1 END) AS medium,
            count(CASE WHEN a.severity = 'low'      AND a.status = 'open' THEN 1 END) AS low
        `, { tenantId: ctx.tenantId })
        if (!row) return { total: 0, open: 0, critical: 0, high: 0, medium: 0, low: 0, falsePositive: 0, acceptedRisk: 0 }
        const result = {
          total:         toNumber(row['total']),
          open:          toNumber(row['open']),
          critical:      toNumber(row['critical']),
          high:          toNumber(row['high']),
          medium:        toNumber(row['medium']),
          low:           toNumber(row['low']),
          falsePositive: toNumber(row['falsePositive']),
          acceptedRisk:  toNumber(row['acceptedRisk']),
        }
        /**
         * TTL corto (revisione totale · G-ANO-7): la cache era di 60 secondi
         * e la invalidavano solo l'accodamento dello scan e la risoluzione —
         * lo SCAN, che gira in un altro processo, non poteva invalidarla.
         * Quindi a scan finito i riquadri restavano quelli di prima per un
         * minuto, mentre la tabella sotto era già aggiornata: due numeri che
         * si contraddicevano nella stessa pagina. Dieci secondi bastano a
         * evitare la raffica di query di un caricamento e non sopravvivono a
         * uno scan.
         */
        cache.set(cacheKey, result, ANOMALY_STATS_TTL_SECONDS)
        return result
      } finally {
        await session.close()
      }
    },
  },

  Mutation: {
    updateAnomalyRule: async (_: unknown, args: { ruleKey: string; settings: Record<string, unknown> }, ctx: GraphQLContext) => {
      const before = (await loadAnomalyRuleConfigs(ctx.tenantId)).find((c) => c.ruleKey === args.ruleKey)
      const saved = await saveAnomalyRuleConfig(ctx.tenantId, args.ruleKey, { ...args.settings })
      const { isDefault: _b, updatedAt: _bu, ...from } = before ?? ({} as AnomalyRuleConfig)
      const { isDefault: _s, updatedAt: _su, ...to } = saved
      void audit(ctx, 'anomaly.rule_updated', 'AnomalyRuleConfig', args.ruleKey, { from, to })
      const [options, counts] = await Promise.all([anomalyRuleOptions(ctx.tenantId), openCountsByRule(ctx.tenantId)])
      return mapRuleConfig(saved, options, counts.get(saved.ruleKey) ?? 0)
    },

    resolveAnomaly: async (
      _: unknown,
      args: { id: string; resolutionStatus: string; note: string },
      ctx: GraphQLContext,
    ) => {
      validateStringLength(args.note, 'note', 10, 10000)
      const resolutionStatus = assertResolutionStatus(args.resolutionStatus)
      const now = new Date().toISOString()
      const session = getSession(undefined, 'WRITE')
      try {
        const row = await runQueryOne<{ props: Props }>(session, `
          MATCH (a:Anomaly {id: $id, tenant_id: $tenantId})
          SET a.status            = $resolutionStatus,
              a.resolution_status = $resolutionStatus,
              a.resolution_note   = $note,
              a.resolved_by       = $resolvedBy,
              a.resolved_at       = $now
          RETURN properties(a) AS props
        `, {
          id:               args.id,
          tenantId:         ctx.tenantId,
          resolutionStatus,
          note:             args.note,
          // G-ANO-8: se non c'è un utente, la colonna resta VUOTA — «unknown»
          // scritto nel grafo diventava «Risolta da unknown» a schermo.
          resolvedBy:       ctx.userId || null,
          now,
        })
        if (!row) throw new NotFoundError('Anomaly')
        cache.invalidate(`anomaly-stats:${ctx.tenantId}`)
        void audit(ctx, 'anomaly.resolved', 'Anomaly', args.id, { resolutionStatus })
        return mapAnomaly(row.props)
      } finally {
        await session.close()
      }
    },

    /**
     * Enqueues a scan of the CALLER's tenant only (C-18). A queue failure
     * (Redis down) propagates as a GraphQL error: returning `false` hid it.
     */
    runAnomalyScanner: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requirePermission(ctx, 'anomaly.scan')
      await enqueueTenantScan(ctx.tenantId)
      cache.invalidate(`anomaly-stats:${ctx.tenantId}`)
      void audit(ctx, 'anomaly.scan_triggered', 'AnomalyScanner', ctx.tenantId)
      return true
    },
  },
}
