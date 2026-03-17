import { withSession, mapCI, labelToType, runQuery, runQueryOne } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'

async function allCIs(_: unknown, args: { limit?: number; offset?: number; type?: string; environment?: string; status?: string; search?: string }, ctx: GraphQLContext) {
  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  const params = { tenantId: ctx.tenantId, environment: args.environment ?? null, status: args.status ?? null, search: args.search ?? null, limit, offset }

  return withSession(async (session) => {
    // If a specific type filter is requested, use a simple single-label query
    if (args.type) {
      const labelMap: Record<string, string> = {
        application: 'Application',
        database: 'Database',
        database_instance: 'DatabaseInstance',
        server: 'Server',
        certificate: 'Certificate',
      }
      const label = labelMap[args.type] ?? 'Application'
      const typeParams = { ...params, type: args.type }
      const items = await runQuery<{ props: Props }>(session,
        `MATCH (n:${label} {tenant_id: $tenantId})
         WHERE ($environment IS NULL OR n.environment = $environment)
           AND ($status IS NULL OR n.status = $status)
           AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
         RETURN properties(n) AS props ORDER BY n.name ASC SKIP toInteger($offset) LIMIT toInteger($limit)`,
        typeParams
      )
      const countResult = await runQuery<{ total: unknown }>(session,
        `MATCH (n:${label} {tenant_id: $tenantId})
         WHERE ($environment IS NULL OR n.environment = $environment)
           AND ($status IS NULL OR n.status = $status)
           AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
         RETURN count(n) AS total`,
        typeParams
      )
      const total = (countResult[0]?.total as { toNumber(): number })?.toNumber?.() ?? Number(countResult[0]?.total ?? 0)
      const typedItems = items.map((r) => {
        r.props['type'] = args.type!
        return mapCI(r.props)
      })
      return { items: typedItems, total }
    }

    const items = await runQuery<{ props: Props; type: string }>(session,
      `CALL {
        MATCH (n:Application {tenant_id: $tenantId})
        WHERE ($environment IS NULL OR n.environment = $environment)
          AND ($status IS NULL OR n.status = $status)
          AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
        RETURN properties(n) AS props, 'application' AS type
        UNION ALL
        MATCH (n:Database {tenant_id: $tenantId})
        WHERE ($environment IS NULL OR n.environment = $environment)
          AND ($status IS NULL OR n.status = $status)
          AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
        RETURN properties(n) AS props, 'database' AS type
        UNION ALL
        MATCH (n:DatabaseInstance {tenant_id: $tenantId})
        WHERE ($environment IS NULL OR n.environment = $environment)
          AND ($status IS NULL OR n.status = $status)
          AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
        RETURN properties(n) AS props, 'database_instance' AS type
        UNION ALL
        MATCH (n:Server {tenant_id: $tenantId})
        WHERE ($environment IS NULL OR n.environment = $environment)
          AND ($status IS NULL OR n.status = $status)
          AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
        RETURN properties(n) AS props, 'server' AS type
        UNION ALL
        MATCH (n:Certificate {tenant_id: $tenantId})
        WHERE ($environment IS NULL OR n.environment = $environment)
          AND ($status IS NULL OR n.status = $status)
          AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
        RETURN properties(n) AS props, 'certificate' AS type
      }
      RETURN props, type
      ORDER BY props.name ASC
      SKIP toInteger($offset) LIMIT toInteger($limit)`,
      params
    )

    const countResult = await runQuery<{ total: unknown }>(session,
      `MATCH (n)
       WHERE (n:Application OR n:Database OR n:DatabaseInstance OR n:Server OR n:Certificate)
         AND n.tenant_id = $tenantId
         AND ($environment IS NULL OR n.environment = $environment)
         AND ($status IS NULL OR n.status = $status)
         AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
       RETURN count(n) AS total`,
      params
    )

    const total = (countResult[0]?.total as { toNumber(): number })?.toNumber?.() ?? Number(countResult[0]?.total ?? 0)
    const mappedItems = items.map((r) => {
      r.props['type'] = r.type
      return mapCI(r.props)
    })
    return { items: mappedItems, total }
  })
}

async function ciById(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props; label: string }>(session,
      `MATCH (n) WHERE (n:Application OR n:Database OR n:DatabaseInstance OR n:Server OR n:Certificate)
         AND n.id = $id AND n.tenant_id = $tenantId
       RETURN properties(n) AS props, labels(n)[0] AS label`,
      { id: args.id, tenantId: ctx.tenantId }
    )
    if (!row) return null
    row.props['type'] = labelToType(row.label)
    return mapCI(row.props)
  })
}

async function blastRadius(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string; distance: unknown; parentProps: Props | null }>(session,
      `MATCH (root {id: $id, tenant_id: $tenantId})
       MATCH path = (root)<-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..5]-(impacted)
       WHERE impacted.tenant_id = $tenantId
       WITH impacted, labels(impacted)[0] AS label,
            min(length(path)) AS distance,
            collect(path) AS paths
       WITH impacted, label, distance,
            [p IN paths WHERE length(p) = distance | p][0] AS shortestPath
       RETURN DISTINCT
         properties(impacted) AS props,
         label,
         distance,
         properties(nodes(shortestPath)[-2]) AS parentProps
       ORDER BY distance ASC, props.name ASC`,
      { id: args.id, tenantId: ctx.tenantId }
    )
    return rows.map((r) => {
      r.props['type'] = labelToType(r.label)
      const dist = typeof r.distance === 'object' && r.distance !== null && 'toNumber' in r.distance
        ? (r.distance as { toNumber(): number }).toNumber()
        : Number(r.distance)
      const parentId = (r.parentProps?.['id'] as string | null) ?? args.id
      return { ci: mapCI(r.props), distance: dist, parentId }
    })
  })
}

async function ciIncidents(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(n {id: $ciId})
       RETURN properties(i) AS props
       ORDER BY i.created_at DESC`,
      { ciId: args.ciId, tenantId: ctx.tenantId }
    )
    return rows.map((r) => ({
      id:          r.props['id']          as string,
      tenantId:    r.props['tenant_id']   as string,
      title:       r.props['title']       as string,
      description: r.props['description'] as string | undefined,
      severity:    r.props['severity']    as string,
      status:      r.props['status']      as string,
      createdAt:   r.props['created_at']  as string,
      updatedAt:   r.props['updated_at']  as string,
      resolvedAt:  r.props['resolved_at'] as string | undefined,
      rootCause:   (r.props['root_cause'] ?? null) as string | null,
      assignee:    null,
      assignedTeam: null,
      affectedCIs: [],
      workflowInstance: null,
      availableTransitions: [],
      workflowHistory: [],
      comments: [],
    }))
  })
}

async function ciChanges(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS]->(n {id: $ciId})
       RETURN properties(c) AS props
       ORDER BY c.created_at DESC`,
      { ciId: args.ciId, tenantId: ctx.tenantId }
    )
    return rows.map((r) => ({
      id:             r.props['id']              as string,
      tenantId:       r.props['tenant_id']       as string,
      title:          r.props['title']           as string,
      description:    (r.props['description']    ?? null) as string | null,
      type:           r.props['type']            as string,
      priority:       (r.props['priority']       ?? 'medium') as string,
      status:         r.props['status']          as string,
      rollbackPlan:   (r.props['rollback_plan']  ?? '') as string,
      scheduledStart: (r.props['scheduled_start'] ?? null) as string | null,
      scheduledEnd:   (r.props['scheduled_end']   ?? null) as string | null,
      implementedAt:  (r.props['implemented_at']  ?? null) as string | null,
      createdAt:      r.props['created_at']      as string,
      updatedAt:      r.props['updated_at']      as string,
      assignedTeam: null, assignee: null,
      affectedCIs: [], relatedIncidents: [],
      deploySteps: [], assessmentTasks: [],
      validation: null, createdBy: null, comments: [],
    }))
  })
}

export const ciResolvers = {
  Query: { allCIs, ciById, blastRadius, ciIncidents, ciChanges },
}
