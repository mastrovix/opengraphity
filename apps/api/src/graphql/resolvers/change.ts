import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

function mapChange(props: Props) {
  return {
    id:          props['id']           as string,
    tenantId:    props['tenant_id']    as string,
    title:       props['title']        as string,
    description: props['description']  as string | undefined,
    type:        props['type']         as string,
    risk:        props['risk']         as string,
    status:      props['status']       as string,
    windowStart: props['window_start'] as string | undefined,
    windowEnd:   props['window_end']   as string | undefined,
    createdAt:   props['created_at']   as string,
    updatedAt:   props['updated_at']   as string,
    impactedCIs:     [],
    relatedProblem:  null,
    causedIncidents: [],
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

async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function changes(
  _: unknown,
  args: { status?: string; type?: string; limit?: number; offset?: number },
  ctx: GraphQLContext,
) {
  const { status, type, limit = 20, offset = 0 } = args
  return withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {tenant_id: $tenantId})
      WHERE ($status IS NULL OR c.status = $status)
        AND ($type   IS NULL OR c.type   = $type)
      WITH c ORDER BY c.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(c) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      tenantId: ctx.tenantId,
      status:   status ?? null,
      type:     type   ?? null,
      offset,
      limit,
    })
    return rows.map((r) => mapChange(r.props))
  })
}

async function change(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      RETURN properties(c) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId,
    })
    return row ? mapChange(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createChange(
  _: unknown,
  args: {
    input: {
      title: string
      description?: string
      type: string
      risk: string
      windowStart?: string
      windowEnd?: string
      impactedCIIds?: string[]
    }
  },
  ctx: GraphQLContext,
) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const cypher = `
      CREATE (c:Change {
        id:           $id,
        tenant_id:    $tenantId,
        title:        $title,
        description:  $description,
        type:         $type,
        risk:         $risk,
        status:       'pending_approval',
        window_start: $windowStart,
        window_end:   $windowEnd,
        created_at:   $now,
        updated_at:   $now
      })
      RETURN properties(c) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title,
      description: input.description  ?? null,
      type:        input.type,
      risk:        input.risk,
      windowStart: input.windowStart  ?? null,
      windowEnd:   input.windowEnd    ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('Failed to create change')
    return mapChange(row.props)
  }, true)

  if (input.impactedCIIds?.length) {
    await withSession(async (session) => {
      for (const ciId of input.impactedCIIds!) {
        await runQuery(session, `
          MATCH (c:Change {id: $id, tenant_id: $tenantId})
          MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
          MERGE (c)-[:IMPACTS]->(ci)
        `, { id, tenantId: ctx.tenantId, ciId })
      }
    }, true)
  }

  const event: DomainEvent<{ id: string; title: string; type: string; risk: string }> = {
    id:             uuidv4(),
    type:           'change.created',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id, title: input.title, type: input.type, risk: input.risk },
  }
  await publish(event)

  return created
}

async function approveChange(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  const approved = await withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.status = 'approved', c.updated_at = $now
      RETURN properties(c) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId, now,
    })
    const row = rows[0]
    if (!row) throw new Error('Change not found')
    return mapChange(row.props)
  }, true)

  const event: DomainEvent<{ id: string }> = {
    id:             uuidv4(),
    type:           'change.approved',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id: args.id },
  }
  await publish(event)

  return approved
}

async function rejectChange(
  _: unknown,
  args: { id: string; reason?: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  const rejected = await withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.status           = 'rejected',
          c.rejection_reason = $reason,
          c.updated_at       = $now
      RETURN properties(c) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId, reason: args.reason ?? null, now,
    })
    const row = rows[0]
    if (!row) throw new Error('Change not found')
    return mapChange(row.props)
  }, true)

  const event: DomainEvent<{ id: string; reason?: string }> = {
    id:             uuidv4(),
    type:           'change.rejected',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id: args.id, reason: args.reason },
  }
  await publish(event)

  return rejected
}

async function deployChange(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  const deployed = await withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.status = 'deployed', c.updated_at = $now
      RETURN properties(c) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId, now,
    })
    const row = rows[0]
    if (!row) throw new Error('Change not found')
    return mapChange(row.props)
  }, true)

  const event: DomainEvent<{ id: string }> = {
    id:             uuidv4(),
    type:           'change.deployed',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id: args.id },
  }
  await publish(event)

  return deployed
}

async function failChange(
  _: unknown,
  args: { id: string; reason?: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  const failed = await withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.status         = 'failed',
          c.failure_reason = $reason,
          c.updated_at     = $now
      RETURN properties(c) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId, reason: args.reason ?? null, now,
    })
    const row = rows[0]
    if (!row) throw new Error('Change not found')
    return mapChange(row.props)
  }, true)

  const event: DomainEvent<{ id: string; reason?: string }> = {
    id:             uuidv4(),
    type:           'change.failed',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id: args.id, reason: args.reason },
  }
  await publish(event)

  return failed
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function changeImpactedCIs(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:IMPACTS]->(ci:ConfigurationItem)
      RETURN properties(ci) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => mapCI(r.props))
  })
}

async function changeRelatedProblem(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})<-[:RESOLVED_BY]-(p:Problem)
      RETURN properties(p) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return row ? mapProblem(row.props) : null
  })
}

async function changeCausedIncidents(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:CAUSED]->(i:Incident)
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => mapIncident(r.props))
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const changeResolvers = {
  Query:    { changes, change },
  Mutation: { createChange, approveChange, rejectChange, deployChange, failChange },
  Change: {
    impactedCIs:     changeImpactedCIs,
    relatedProblem:  changeRelatedProblem,
    causedIncidents: changeCausedIncidents,
  },
}
