import { withSession, getSession, ciTypeFromLabels } from '../ci-utils.js'
import { calculateRiskScore } from '../../../lib/riskScore.js'
import type { GraphQLContext } from '../../../context.js'
import { toInt } from './mappers.js'

type Session = ReturnType<typeof getSession>

export async function computeImpactAnalysis(session: Session, tenantId: string, ciIds: string[]) {
  // 1. Blast radius
  const blastResult = await session.executeRead((tx) => tx.run(`
    UNWIND $ciIds AS ciId
    MATCH (ci {id: ciId, tenant_id: $tenantId})
    WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
    MATCH path = (ci)<-[:DEPENDS_ON|HOSTED_ON*1..5]-(impacted)
    WHERE (impacted:Application OR impacted:Database OR impacted:DatabaseInstance OR impacted:Server OR impacted:Certificate)
    AND impacted.tenant_id = $tenantId
    AND NOT impacted.id IN $ciIds
    WITH impacted, labels(impacted)[0] AS lbl, min(length(path)) AS distance
    RETURN DISTINCT
      impacted.id AS id, impacted.name AS name,
      lbl AS label,
      impacted.environment AS environment,
      distance
    ORDER BY distance ASC, impacted.name ASC
  `, { ciIds, tenantId }))

  const blastRadius = blastResult.records.map((r) => ({
    id:          r.get('id') as string,
    name:        r.get('name') as string,
    type:        ciTypeFromLabels([r.get('label') as string]),
    environment: (r.get('environment') ?? 'unknown') as string,
    distance:    toInt(r.get('distance'), 1),
  }))

  // 2a. Open incidents (any date)
  const openResult = await session.executeRead((tx) => tx.run(`
    UNWIND $ciIds AS ciId
    MATCH (i:Incident {tenant_id: $tenantId})
          -[:AFFECTED_BY]->(ci {id: ciId})
    WHERE NOT i.status IN ['resolved', 'closed']
    RETURN DISTINCT i.id AS id, i.number AS number, i.title AS title,
           i.severity AS severity, i.status AS status,
           ci.name AS ciName, ci.id AS ciId,
           i.created_at AS createdAt, true AS isOpen
    ORDER BY i.created_at DESC
  `, { ciIds, tenantId }))

  // 2b. Recently resolved incidents (last 30 days)
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const recentIncResult = await session.executeRead((tx) => tx.run(`
    UNWIND $ciIds AS ciId
    MATCH (i:Incident {tenant_id: $tenantId})
          -[:AFFECTED_BY]->(ci {id: ciId})
    WHERE i.created_at >= $since
    AND i.status IN ['resolved', 'closed']
    RETURN DISTINCT i.id AS id, i.number AS number, i.title AS title,
           i.severity AS severity, i.status AS status,
           ci.name AS ciName, ci.id AS ciId,
           i.created_at AS createdAt, false AS isOpen
    ORDER BY i.created_at DESC
  `, { ciIds, tenantId, since: since30 }))

  const openIncidents = [
    ...openResult.records,
    ...recentIncResult.records,
  ].map((r) => ({
    id:        r.get('id') as string,
    number:    (r.get('number') ?? '') as string,
    title:     r.get('title') as string,
    severity:  (r.get('severity') ?? 'medium') as string,
    status:    r.get('status') as string,
    ciName:    r.get('ciName') as string,
    ciId:      r.get('ciId') as string,
    createdAt: r.get('createdAt') as string,
    isOpen:    r.get('isOpen') as boolean,
  }))

  const openIncidentsCount = openResult.records.length

  // 3. Recent changes on same CIs (last 60 days)
  const since60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const changeResult = await session.executeRead((tx) => tx.run(`
    UNWIND $ciIds AS ciId
    MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS]->(ci {id: ciId})
    WHERE c.created_at >= $since
    AND c.status <> 'draft'
    RETURN c.id AS id, c.number AS number, c.title AS title,
           c.type AS type, c.status AS status,
           ci.name AS ciName, ci.id AS ciId,
           c.created_at AS createdAt
    ORDER BY c.created_at DESC
    LIMIT 20
  `, { ciIds, tenantId, since: since60 }))

  const recentChanges = changeResult.records.map((r) => ({
    id:        r.get('id') as string,
    number:    (r.get('number') ?? '') as string,
    title:     r.get('title') as string,
    type:      r.get('type') as string,
    status:    r.get('status') as string,
    ciName:    r.get('ciName') as string,
    ciId:      r.get('ciId') as string,
    createdAt: r.get('createdAt') as string,
  }))

  // 4. Environments of affected CIs
  const ciResult = await session.executeRead((tx) => tx.run(`
    UNWIND $ciIds AS ciId
    MATCH (ci {id: ciId, tenant_id: $tenantId})
    WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
    RETURN ci.environment AS env
  `, { ciIds, tenantId }))

  const affectedEnvs = ciResult.records.map((r) => r.get('env') as string)

  // 5. Risk score
  const productionCIs  = affectedEnvs.filter((e) => e === 'production').length
  const blastRadiusCIs = blastRadius.length
  const failedChanges  = recentChanges.filter((c) => c.status === 'failed').length
  const ongoingChanges    = recentChanges.filter((c) => !['completed', 'failed', 'rejected', 'draft'].includes(c.status)).length

  const { score, level: riskLevel, details } = calculateRiskScore({
    productionCIs,
    blastRadiusCIs,
    openIncidents: openIncidentsCount,
    failedChanges,
    ongoingChanges,
  })

  return {
    riskScore: score,
    riskLevel,
    blastRadius,
    openIncidents,
    recentChanges,
    breakdown: {
      productionCIs,
      blastRadiusCIs,
      openIncidents: openIncidentsCount,
      failedChanges,
      ongoingChanges,
      scoreDetails: details.length > 0 ? details.join(' | ') : 'Nessun fattore di rischio rilevato',
    },
  }
}

export async function changeImpactAnalysisQuery(
  _: unknown,
  { ciIds }: { ciIds: string[] },
  ctx: GraphQLContext,
) {
  return withSession((session) => computeImpactAnalysis(session, ctx.tenantId, ciIds))
}

export async function changeImpactAnalysisField(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:AFFECTS]->(ci)
      RETURN ci.id AS ciId
    `, { id: parent.id, tenantId: ctx.tenantId }))
    const ciIds = r.records.map((rec) => rec.get('ciId') as string)
    if (ciIds.length === 0) return null
    return computeImpactAnalysis(session, ctx.tenantId, ciIds)
  })
}
