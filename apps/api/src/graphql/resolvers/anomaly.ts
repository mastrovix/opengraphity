import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { getSession, runQuery, runQueryOne, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { enqueueTenantScan } from '../../anomaly/anomalyEngine.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { cache } from '../../lib/cache.js'
import { validateStringLength } from '../../lib/validation.js'
import { audit } from '../../lib/audit.js'
import { requireRole } from '../../lib/requireRole.js'

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
    detectedAt:       toStr(p['detected_at']),
    resolvedAt:       p['resolved_at']        ? toStr(p['resolved_at'])        : null,
    resolutionStatus: p['resolution_status']  ? toStr(p['resolution_status'])  : null,
    resolutionNote:   p['resolution_note']    ? toStr(p['resolution_note'])    : null,
    resolvedBy:       p['resolved_by']        ? toStr(p['resolved_by'])        : null,
    tenantId:         toStr(p['tenant_id']),
  }
}

const ANOMALY_ALLOWED_FIELDS = new Set(['title', 'severity', 'status', 'ruleKey', 'detectedAt'])

export const anomalyResolvers = {
  Query: {
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
          MATCH (a:Anomaly)
          ${where}
          WITH a ORDER BY ${orderByClause}
          SKIP toInteger($offset) LIMIT toInteger($limit)
          RETURN properties(a) AS props
        `, params)

        const countRows = await runQuery<{ total: unknown }>(session, `
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
        cache.set(cacheKey, result, 60)
        return result
      } finally {
        await session.close()
      }
    },
  },

  Mutation: {
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
          resolvedBy:       ctx.userId || 'unknown',
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
      requireRole(ctx, 'admin', 'operator')
      await enqueueTenantScan(ctx.tenantId)
      cache.invalidate(`anomaly-stats:${ctx.tenantId}`)
      void audit(ctx, 'anomaly.scan_triggered', 'AnomalyScanner', ctx.tenantId)
      return true
    },
  },
}
