import { withSession, getSession, ciTypeFromLabels } from './ci-utils.js'
import { calculateRiskScore } from '../../lib/riskScore.js'
import { getTerminalStepNames } from '../../lib/workflowHelpers.js'
import type { GraphQLContext } from '../../context.js'

type Session = ReturnType<typeof getSession>

function toInt(v: unknown, fallback = 0): number {
  if (v == null) return fallback
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}

export async function computeImpactAnalysis(session: Session, tenantId: string, ciIds: string[]) {
  const incidentTerminal = await getTerminalStepNames(session, tenantId, 'incident')

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

  // 2a. Open incidents
  const openResult = await session.executeRead((tx) => tx.run(`
    UNWIND $ciIds AS ciId
    MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci {id: ciId})
    WHERE NOT i.status IN $terminalSteps
    RETURN DISTINCT i.id AS id, i.number AS number, i.title AS title,
           i.severity AS severity, i.status AS status,
           ci.name AS ciName, ci.id AS ciId,
           i.created_at AS createdAt, true AS isOpen
    ORDER BY i.created_at DESC
  `, { ciIds, tenantId, terminalSteps: incidentTerminal }))

  // 2b. Recently resolved incidents (last 30 days)
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const recentIncResult = await session.executeRead((tx) => tx.run(`
    UNWIND $ciIds AS ciId
    MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci {id: ciId})
    WHERE i.created_at >= $since
    AND i.status IN $terminalSteps
    RETURN DISTINCT i.id AS id, i.number AS number, i.title AS title,
           i.severity AS severity, i.status AS status,
           ci.name AS ciName, ci.id AS ciId,
           i.created_at AS createdAt, false AS isOpen
    ORDER BY i.created_at DESC
  `, { ciIds, tenantId, since: since30, terminalSteps: incidentTerminal }))

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

  // 3. Recent RFC-based changes on same CIs (last 60 days)
  const since60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const changeResult = await session.executeRead((tx) => tx.run(`
    UNWIND $ciIds AS ciId
    MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(ci {id: ciId})
    WHERE c.created_at >= $since
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN c.id AS id, c.code AS code, c.title AS title,
           coalesce(wi.current_step, '') AS phase, c.approval_status AS approvalStatus,
           ci.name AS ciName, ci.id AS ciId,
           c.created_at AS createdAt
    ORDER BY c.created_at DESC
    LIMIT 20
  `, { ciIds, tenantId, since: since60 }))

  const recentChanges = changeResult.records.map((r) => ({
    id:        r.get('id') as string,
    code:      (r.get('code') ?? '') as string,
    title:     r.get('title') as string,
    phase:     r.get('phase') as string,
    ciName:    r.get('ciName') as string,
    ciId:      r.get('ciId') as string,
    createdAt: r.get('createdAt') as string,
  }))

  const approvalStatuses = changeResult.records.map((r) => (r.get('approvalStatus') ?? null) as string | null)
  const failedChanges  = approvalStatuses.filter((s) => s === 'rejected').length
  const changeTerminal = await getTerminalStepNames(session, tenantId, 'change')
  const ongoingChanges = recentChanges.filter((c) => !changeTerminal.includes(c.phase)).length

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

async function changeImpactAnalysisQuery(_: unknown, { ciIds }: { ciIds: string[] }, ctx: GraphQLContext) {
  return withSession((session) => computeImpactAnalysis(session, ctx.tenantId, ciIds))
}

export const impactResolvers = {
  Query: { changeImpactAnalysis: changeImpactAnalysisQuery },
}
