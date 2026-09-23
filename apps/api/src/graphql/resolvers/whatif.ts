import { GraphQLError } from 'graphql'
import { getSession, runQuery, runQueryOne, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { getTerminalStepNames } from '../../lib/workflowHelpers.js'
import { serviceRelPatternForTenant } from '../../lib/ciMetamodelForTenant.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function impactLevel(dist: number, action: string): string {
  if (action === 'remove') {
    // Removal: levels shifted up by one
    if (dist <= 2) return 'critical'
    if (dist === 3) return 'high'
    return 'medium'
  }
  // Impact analysis (default)
  if (dist <= 1) return 'critical'
  if (dist === 2) return 'high'
  if (dist === 3) return 'medium'
  return 'low'
}

/** Open incidents linked to any of $impactedIds (tenant-scoped, non-terminal). */
export const OPEN_INCIDENTS_ON_CIS_CYPHER = `
  MATCH (ci)<-[:AFFECTED_BY]-(inc:Incident {tenant_id: $tenantId})
  WHERE ci.id IN $impactedIds AND ci.tenant_id = $tenantId AND NOT inc.status IN $terminalSteps
  RETURN count(DISTINCT inc) AS cnt
`

// ── whatIfAnalysis ───────────────────────────────────────────────────────────

interface WhatIfArgs { ciId: string; action: string; depth?: number | null }

async function whatIfAnalysis(_: unknown, args: WhatIfArgs, ctx: GraphQLContext) {
  const { ciId, action } = args
  const depth = Math.min(Math.max(args.depth ?? 5, 1), 10)
  const tenantId = ctx.tenantId

  // ── Query 1: target CI + impacted CIs (single traversal) ──────────────
  type Row = { id: string; name: string; lbls: string[]; env: string | null; status: string | null; distance: unknown; pathNames: string[] }
  let targetName: string
  let targetType: string
  let targetEnv: string | null
  let targetStatus: string | null
  let impactedRows: Row[]

  const s1 = getSession(undefined, 'READ')
  try {
    // Load target
    const tgt = await runQueryOne<{ name: string; lbl: string; env: string | null; status: string | null }>(s1, `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      RETURN ci.name AS name, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS lbl, ci.environment AS env, ci.status AS status
    `, { ciId, tenantId })
    if (!tgt) throw new GraphQLError(`CI not found: ${ciId}`, { extensions: { code: 'NOT_FOUND' } })
    targetName = tgt.name
    targetType = tgt.lbl ?? 'Unknown'
    targetEnv = tgt.env
    targetStatus = tgt.status

    // Traversal — single query, deduplicated by CI, shortest path only.
    // CM-3: le relazioni dei servizi del tenant, non una lista scritta qui.
    const relPattern = await serviceRelPatternForTenant(tenantId)
    impactedRows = await runQuery<Row>(s1, `
      MATCH (target:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      MATCH path = (impacted)-[:${relPattern}*1..${depth}]->(target)
      WHERE impacted.tenant_id = $tenantId AND impacted.id <> $ciId
      WITH impacted, path, length(path) AS dist
      ORDER BY dist ASC
      WITH impacted, collect(path)[0] AS bestPath, min(dist) AS distance
      WITH impacted, distance, [n IN nodes(bestPath) | n.name] AS pathNames,
           [l IN labels(impacted) WHERE l <> 'ConfigurationItem'] AS lbls
      RETURN impacted.id AS id, impacted.name AS name, lbls,
             impacted.environment AS env, impacted.status AS status,
             distance, pathNames
    `, { ciId, tenantId })
  } finally { await s1.close() }

  const impactedIds = impactedRows.map(r => r.id)

  const impactedCIs = impactedRows.map(r => ({
    id:          r.id,
    name:        r.name,
    // Giro del 14 set 2026 (#59): `labels()[0]` era sempre `ConfigurationItem`.
    type:        r.lbls?.[0] ?? 'Unknown',
    environment: r.env,
    status:      r.status,
    impactLevel: impactLevel(toNumber(r.distance), action),
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
      const terminalSteps = await getTerminalStepNames(s3, tenantId, 'incident')
      // Incidents point at their CIs: (Incident)-[:AFFECTED_BY]->(ci)
      // (incidentService.createIncident / addAffectedCI). Exported below so the
      // relationship is pinned by a test — a wrong type here is a silent 0.
      const row = await runQueryOne<{ cnt: unknown }>(s3, OPEN_INCIDENTS_ON_CIS_CYPHER, { impactedIds, tenantId, terminalSteps })
      openIncidents = toNumber(row?.cnt)
    } finally { await s3.close() }
  }

  // ── Query 4: services whose map includes the target or an impacted CI ──
  // Giro del 14 set 2026 (#59): i servizi erano i CI impattati con
  // «application» o «service» nel nome dell'etichetta, quindi un database con
  // un servizio dipendente (mostrato nel suo dettaglio) diceva «0 services».
  // La sorgente è la stessa del dettaglio del CI: le mappe che lo includono.
  type ServiceRow = { id: string; name: string; env: string | null; status: string | null; ciId: string }
  let serviceRows: ServiceRow[]
  {
    const s4 = getSession(undefined, 'READ')
    try {
      serviceRows = await runQuery<ServiceRow>(s4, `
        MATCH (m:ServiceMap {tenant_id: $tenantId})-[:INCLUDES]->(ci:ConfigurationItem)
        WHERE ci.tenant_id = $tenantId AND ci.id IN $ciIds
        MATCH (ba:ConfigurationItem {tenant_id: $tenantId})-[:HAS_SERVICE_MAP]->(m)
        RETURN ba.id AS id, coalesce(m.name, ba.name) AS name, ba.environment AS env, ba.status AS status, ci.id AS ciId
      `, { tenantId, ciIds: [ciId, ...impactedIds] })
    } finally { await s4.close() }
  }
  const distanceOf = new Map<string, { distance: number; path: string[] }>([[ciId, { distance: 0, path: [targetName] }]])
  for (const r of impactedRows) distanceOf.set(r.id, { distance: toNumber(r.distance), path: (r.pathNames ?? []).map(String) })
  const closest = new Map<string, ServiceRow & { distance: number; path: string[] }>()
  for (const row of serviceRows) {
    const d = distanceOf.get(row.ciId)
    if (!d) continue
    const prev = closest.get(row.id)
    if (!prev || d.distance < prev.distance) closest.set(row.id, { ...row, ...d })
  }
  const impactedServices = [...closest.values()]
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .map((svc) => ({
      id:          svc.id,
      name:        svc.name,
      type:        'BusinessApplication',
      environment: svc.env,
      status:      svc.status,
      impactLevel: impactLevel(svc.distance, action),
      impactPath:  svc.path,
      isRedundant: false,
    }))

  // ── Compute results in JS ─────────────────────────────────────────────
  const totalImpacted = impactedCIs.length
  let riskScore = Math.min(totalImpacted * 10, 50)
  if (impactedServices.length > 0) riskScore += 20
  if (openIncidents > 0) riskScore += 15
  if (action === 'remove') riskScore += 15
  riskScore = Math.min(riskScore, 100)

  // Per chi legge l'API: la pagina compone la frase nella lingua dell'utente
  // dai contatori (prima era una frase italiana composta qui).
  const summary = `${action === 'remove' ? 'Removing' : 'An outage of'} ${targetName} impacts ${totalImpacted} CIs, ${impactedServices.length} services, ${teams.length} teams. Risk: ${riskScore}/100.`

  // `audit` registra da sé un errore di scrittura (lib/audit.ts): niente catch muto.
  void audit(ctx, 'whatif_analysis', 'CI', ciId, { action, totalImpacted, riskScore })
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
    impactedTeams: teams.map(t => ({ id: t.id, name: t.name, role: 'owner', impactedCICount: toNumber(t.cnt) })),
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
