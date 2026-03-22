import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { anomalyScannerQueue } from '../../anomaly/anomalyEngine.js'

type Props = Record<string, unknown>

// Neo4j DateTime objects have a toString() that returns ISO string
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

export const anomalyResolvers = {
  Query: {
    anomalies: async (
      _: unknown,
      args: { status?: string; severity?: string; ruleKey?: string; limit?: number; offset?: number },
      ctx: GraphQLContext,
    ) => {
      const { status, severity, ruleKey, limit = 50, offset = 0 } = args
      const session = getSession()
      try {
        // Build filter clause — same params used for both queries
        const conditions: string[] = ['a.tenant_id = $tenantId']
        if (status)   conditions.push('a.status   = $status')
        if (severity) conditions.push('a.severity = $severity')
        if (ruleKey)  conditions.push('a.rule_key = $ruleKey')
        const where = 'WHERE ' + conditions.join(' AND ')

        const params = { tenantId: ctx.tenantId, status: status ?? null, severity: severity ?? null, ruleKey: ruleKey ?? null, offset, limit }

        // Two separate queries — same pattern as incident resolver
        const itemRows = await runQuery<{ props: Props }>(session, `
          MATCH (a:Anomaly)
          ${where}
          WITH a ORDER BY a.detected_at DESC
          SKIP toInteger($offset) LIMIT toInteger($limit)
          RETURN properties(a) AS props
        `, params)

        const countRows = await runQuery<{ total: unknown }>(session, `
          MATCH (a:Anomaly)
          ${where}
          RETURN count(a) AS total
        `, params)

        const total = toNum(countRows[0]?.total)
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
          totalScans: row ? toNum(row.totalScans) : 0,
        }
      } finally {
        await session.close()
      }
    },

    anomalyStats: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
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
        return {
          total:         toNum(row['total']),
          open:          toNum(row['open']),
          critical:      toNum(row['critical']),
          high:          toNum(row['high']),
          medium:        toNum(row['medium']),
          low:           toNum(row['low']),
          falsePositive: toNum(row['falsePositive']),
          acceptedRisk:  toNum(row['acceptedRisk']),
        }
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
          resolutionStatus: args.resolutionStatus,
          note:             args.note,
          resolvedBy:       ctx.userId || 'unknown',
          now,
        })
        if (!row) throw new Error('Anomaly not found')
        return mapAnomaly(row.props)
      } finally {
        await session.close()
      }
    },

    runAnomalyScanner: async () => {
      try {
        await anomalyScannerQueue.add('scan-manual', {}, { jobId: `manual-${Date.now()}` })
      } catch (err) {
        // Queue unavailable (Redis down etc.) — log and return false
        console.error('[anomaly] runAnomalyScanner: failed to enqueue job:', err)
        return false
      }
      return true
    },
  },
}
