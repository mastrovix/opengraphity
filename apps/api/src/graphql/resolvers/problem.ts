import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

function mapProblem(props: Props) {
  return {
    id:               props['id']          as string,
    tenantId:         props['tenant_id']   as string,
    title:            props['title']       as string,
    description:      props['description'] as string | undefined,
    status:           props['status']      as string,
    impact:           props['impact']      as string,
    rootCause:        props['root_cause']  as string | undefined,
    workaround:       props['workaround']  as string | undefined,
    createdAt:        props['created_at']  as string,
    updatedAt:        props['updated_at']  as string,
    resolvedAt:       props['resolved_at'] as string | undefined,
    relatedIncidents: [],
    resolvedByChange: null,
  }
}

function mapCI(props: Props) {
  return {
    id:          props['id']          as string,
    tenantId:    props['tenant_id']   as string,
    name:        props['name']        as string,
    type:        props['type']        as string,
    status:      props['status']      as string,
    environment: props['environment'] as string,
    createdAt:   props['created_at']  as string,
    updatedAt:   props['updated_at']  as string,
    dependencies: [],
    dependents:   [],
  }
}

function mapIncident(props: Props) {
  return {
    id:              props['id']          as string,
    tenantId:        props['tenant_id']   as string,
    title:           props['title']       as string,
    description:     props['description'] as string | undefined,
    severity:        props['severity']    as string,
    status:          props['status']      as string,
    createdAt:       props['created_at']  as string,
    updatedAt:       props['updated_at']  as string,
    resolvedAt:      props['resolved_at'] as string | undefined,
    assignee:        null,
    affectedCIs:     [],
    causedByProblem: null,
  }
}

function mapChange(props: Props) {
  return {
    id:          props['id']          as string,
    tenantId:    props['tenant_id']   as string,
    title:       props['title']       as string,
    description: props['description'] as string | undefined,
    type:        props['type']        as string,
    risk:        props['risk']        as string,
    status:      props['status']      as string,
    windowStart: props['window_start'] as string | undefined,
    windowEnd:   props['window_end']   as string | undefined,
    createdAt:   props['created_at']  as string,
    updatedAt:   props['updated_at']  as string,
    impactedCIs:     [],
    relatedProblem:  null,
    causedIncidents: [],
  }
}

async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function problems(
  _: unknown,
  args: { status?: string; limit?: number; offset?: number },
  ctx: GraphQLContext,
) {
  const { status, limit = 20, offset = 0 } = args
  return withSession(async (session) => {
    const cypher = `
      MATCH (p:Problem {tenant_id: $tenantId})
      WHERE ($status IS NULL OR p.status = $status)
      WITH p ORDER BY p.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(p) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      tenantId: ctx.tenantId,
      status:   status ?? null,
      offset,
      limit,
    })
    return rows.map((r) => mapProblem(r.props))
  })
}

async function problem(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      RETURN properties(p) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId,
    })
    return row ? mapProblem(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createProblem(
  _: unknown,
  args: { input: { title: string; description?: string; impact: string } },
  ctx: GraphQLContext,
) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const cypher = `
      CREATE (p:Problem {
        id:          $id,
        tenant_id:   $tenantId,
        title:       $title,
        description: $description,
        status:      'open',
        impact:      $impact,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(p) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title,
      description: input.description ?? null,
      impact:      input.impact,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('Failed to create problem')
    return mapProblem(row.props)
  }, true)

  const event: DomainEvent<{ id: string; title: string; impact: string }> = {
    id:             uuidv4(),
    type:           'problem.created',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id, title: input.title, impact: input.impact },
  }
  await publish(event)

  return created
}

async function updateProblem(
  _: unknown,
  args: { id: string; input: { title?: string; description?: string; impact?: string; workaround?: string } },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  const updated = await withSession(async (session) => {
    const cypher = `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      SET p += {
        title:       coalesce($title,       p.title),
        description: coalesce($description, p.description),
        impact:      coalesce($impact,      p.impact),
        workaround:  coalesce($workaround,  p.workaround),
        updated_at:  $now
      }
      RETURN properties(p) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title       ?? null,
      description: input.description ?? null,
      impact:      input.impact      ?? null,
      workaround:  input.workaround  ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('Problem not found')
    return mapProblem(row.props)
  }, true)

  const event: DomainEvent<{ id: string } & typeof input> = {
    id:             uuidv4(),
    type:           'problem.updated',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id, ...input },
  }
  await publish(event)

  return updated
}

async function resolveProblem(
  _: unknown,
  args: { id: string; resolution?: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  const resolved = await withSession(async (session) => {
    const cypher = `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      SET p.status      = 'resolved',
          p.resolved_at = $now,
          p.updated_at  = $now,
          p.root_cause  = coalesce($resolution, p.root_cause)
      RETURN properties(p) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id:         args.id,
      tenantId:   ctx.tenantId,
      resolution: args.resolution ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('Problem not found')
    return mapProblem(row.props)
  }, true)

  const event: DomainEvent<{ id: string; resolved_at: string }> = {
    id:             uuidv4(),
    type:           'problem.resolved',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id: args.id, resolved_at: now },
  }
  await publish(event)

  return resolved
}

async function linkIncidentToProblem(
  _: unknown,
  args: { incidentId: string; problemId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      MATCH (p:Problem  {id: $problemId,  tenant_id: $tenantId})
      MERGE (i)-[:CAUSED_BY]->(p)
      RETURN properties(p) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      incidentId: args.incidentId,
      problemId:  args.problemId,
      tenantId:   ctx.tenantId,
    })
    const row = rows[0]
    if (!row) throw new Error('Incident or Problem not found')
    return mapProblem(row.props)
  }, true)
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function problemRelatedIncidents(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident)-[:CAUSED_BY]->(p:Problem {id: $id, tenant_id: $tenantId})
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => mapIncident(r.props))
  })
}

async function problemResolvedByChange(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:RESOLVED_BY]->(c:Change)
      RETURN properties(c) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return row ? mapChange(row.props) : null
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const problemResolvers = {
  Query:    { problems, problem },
  Mutation: { createProblem, updateProblem, resolveProblem, linkIncidentToProblem },
  Problem: {
    relatedIncidents: problemRelatedIncidents,
    resolvedByChange: problemResolvedByChange,
  },
}
