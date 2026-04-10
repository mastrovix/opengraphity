import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function impactLevel(dist: number): string {
  if (dist <= 1) return 'critical'
  if (dist === 2) return 'high'
  if (dist === 3) return 'medium'
  return 'low'
}

function toNum(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}

// ── whatIfAnalysis ───────────────────────────────────────────────────────────

interface WhatIfArgs { ciId: string; action: string; depth?: number | null }

async function whatIfAnalysis(_: unknown, args: WhatIfArgs, ctx: GraphQLContext) {
  const { ciId, action } = args
  const depth = Math.min(Math.max(args.depth ?? 5, 1), 10)
  const tenantId = ctx.tenantId

  // ── Query 1: target CI + impacted CIs (single traversal) ──────────────
  type Row = { id: string; name: string; lbls: string[]; env: string | null; status: string | null; distance: unknown; pathNames: string[] }
  let targetName = ''
  let targetType = ''
  let targetEnv: string | null = null
  let targetStatus: string | null = null
  let impactedRows: Row[] = []

  const s1 = getSession(undefined, 'READ')
  try {
    // Load target
    const tgt = await runQueryOne<{ name: string; lbl: string; env: string | null; status: string | null }>(s1, `
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      RETURN ci.name AS name, labels(ci)[0] AS lbl, ci.environment AS env, ci.status AS status
    `, { ciId, tenantId })
    if (!tgt) throw new Error(`CI not found: ${ciId}`)
    targetName = tgt.name
    targetType = tgt.lbl ?? 'Unknown'
    targetEnv = tgt.env
    targetStatus = tgt.status

    // Traversal — single query, deduplicated by CI, shortest path only
    impactedRows = await runQuery<Row>(s1, `
      MATCH (target {id: $ciId, tenant_id: $tenantId})
      MATCH path = (impacted)-[:DEPENDS_ON|HOSTED_ON|USES_CERTIFICATE*1..${depth}]->(target)
      WHERE impacted.tenant_id = $tenantId AND impacted.id <> $ciId
      WITH impacted, path, length(path) AS dist
      ORDER BY dist ASC
      WITH impacted, collect(path)[0] AS bestPath, min(dist) AS distance
      WITH impacted, distance, [n IN nodes(bestPath) | n.name] AS pathNames, labels(impacted) AS lbls
      RETURN impacted.id AS id, impacted.name AS name, lbls,
             impacted.environment AS env, impacted.status AS status,
             distance, pathNames
    `, { ciId, tenantId })
  } finally { await s1.close() }

  const impactedIds = impactedRows.map(r => r.id)

  const impactedCIs = impactedRows.map(r => ({
    id:          r.id,
    name:        r.name,
    type:        r.lbls?.[0] ?? 'Unknown',
    environment: r.env,
    status:      r.status,
    impactLevel: impactLevel(toNum(r.distance)),
    impactPath:  (r.pathNames ?? []).map(String),
    isRedundant: false,
  }))

  // ── Query 2: teams linked to impacted CIs ─────────────────────────────
  type TeamRow = { id: string; name: string; cnt: unknown }
  let teams: TeamRow[] = []
  if (impactedIds.length > 0) {
    const s2 = getSession(undefined, 'READ')
    try {
      teams = await runQuery<TeamRow>(s2, `
        MATCH (ci)-[:OWNED_BY]->(t:Team {tenant_id: $tenantId})
        WHERE ci.id IN $impactedIds
        RETURN DISTINCT t.id AS id, t.name AS name, count(DISTINCT ci) AS cnt
      `, { impactedIds, tenantId })
    } finally { await s2.close() }
  }

  // ── Query 3: open incidents on impacted CIs ───────────────────────────
  let openIncidents = 0
  if (impactedIds.length > 0) {
    const s3 = getSession(undefined, 'READ')
    try {
      const row = await runQueryOne<{ cnt: unknown }>(s3, `
        MATCH (ci)<-[:AFFECTS]-(inc {tenant_id: $tenantId})
        WHERE ci.id IN $impactedIds AND NOT inc.status IN ['resolved', 'closed']
        RETURN count(inc) AS cnt
      `, { impactedIds, tenantId })
      openIncidents = toNum(row?.cnt)
    } finally { await s3.close() }
  }

  // ── Compute results in JS ─────────────────────────────────────────────
  const impactedServices = impactedCIs.filter(c =>
    c.type.toLowerCase().includes('application') || c.type.toLowerCase().includes('service'),
  )

  const totalImpacted = impactedCIs.length
  let riskScore = Math.min(totalImpacted * 10, 50)
  if (impactedServices.length > 0) riskScore += 20
  if (openIncidents > 0) riskScore += 15
  if (action === 'shutdown' || action === 'remove') riskScore += 15
  riskScore = Math.min(riskScore, 100)

  const actionLabel = action === 'shutdown' ? 'Lo spegnimento' : action === 'remove' ? 'La rimozione' : 'La degradazione'
  const summary = `${actionLabel} di ${targetName} impatta ${totalImpacted} CI, ${impactedServices.length} servizi, ${teams.length} team. Rischio: ${riskScore}/100.`

  await audit(ctx, 'whatif_analysis', 'CI', ciId, { action, totalImpacted, riskScore }).catch(() => {})
  logger.info({ ciId, action, totalImpacted, riskScore, tenantId }, '[whatif] analysis complete')

  return {
    targetCI: {
      id: ciId, name: targetName, type: targetType,
      environment: targetEnv, status: targetStatus,
      impactLevel: 'target', impactPath: [], isRedundant: false,
    },
    action,
    impactedCIs,
    impactedServices,
    impactedTeams: teams.map(t => ({ id: t.id, name: t.name, role: 'owner', impactedCICount: toNum(t.cnt) })),
    totalImpacted,
    riskScore,
    hasRedundancy: false,
    openIncidents,
    summary,
  }
}

// ── whatIfCompare ────────────────────────────────────────────────────────────

async function whatIfCompare(_: unknown, args: { scenarios: { ciId: string; action: string }[] }, ctx: GraphQLContext) {
  return Promise.all(args.scenarios.map(s => whatIfAnalysis(_, { ciId: s.ciId, action: s.action }, ctx)))
}

// ── exports ─────────────────────────────────────────────────────────────────

export const whatifResolvers = {
  Query: { whatIfAnalysis, whatIfCompare },
}
