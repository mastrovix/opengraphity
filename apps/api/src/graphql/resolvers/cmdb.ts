import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

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

async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>): Promise<T> {
  const session = getSession()
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function configurationItems(
  _: unknown,
  args: { type?: string; limit?: number; offset?: number },
  ctx: GraphQLContext,
) {
  const { type, limit = 20, offset = 0 } = args
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      WHERE ($type IS NULL OR ci.type = $type)
      WITH ci ORDER BY ci.name
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(ci) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      tenantId: ctx.tenantId,
      type: type ?? null,
      offset,
      limit,
    })
    return rows.map((r) => mapCI(r.props))
  })
}

async function configurationItem(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId})
      RETURN properties(ci) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId,
    })
    return row ? mapCI(row.props) : null
  })
}

async function blastRadius(
  _: unknown,
  args: { ciId: string; depth?: number },
  ctx: GraphQLContext,
) {
  const depth = args.depth ?? 3
  return withSession(async (session) => {
    // Variable-length path up to $depth hops
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
        -[:DEPENDS_ON*1..${depth}]->(d:ConfigurationItem)
      RETURN DISTINCT properties(d) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      ciId: args.ciId, tenantId: ctx.tenantId,
    })
    return rows.map((r) => mapCI(r.props))
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createConfigurationItem(
  _: unknown,
  args: { input: { name: string; type: string; status: string; environment: string } },
  ctx: GraphQLContext,
) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const cypher = `
      CREATE (ci:ConfigurationItem {
        id:          $id,
        tenant_id:   $tenantId,
        name:        $name,
        type:        $type,
        status:      $status,
        environment: $environment,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(ci) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id, tenantId: ctx.tenantId, ...input, now,
    })
    const row = rows[0]
    if (!row) throw new Error('Failed to create ConfigurationItem')
    return mapCI(row.props)
  })

  const event: DomainEvent<{ id: string; type: string; tenant_id: string }> = {
    id:             uuidv4(),
    type:           'ci.created',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id, type: input.type, tenant_id: ctx.tenantId },
  }
  await publish(event)

  return created
}

async function updateConfigurationItem(
  _: unknown,
  args: { id: string; input: { name?: string; status?: string; environment?: string } },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId})
      SET ci += {
        name:        coalesce($name, ci.name),
        status:      coalesce($status, ci.status),
        environment: coalesce($environment, ci.environment),
        updated_at:  $now
      }
      RETURN properties(ci) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      name:        input.name        ?? null,
      status:      input.status      ?? null,
      environment: input.environment ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('ConfigurationItem not found')
    return mapCI(row.props)
  })
}

async function addCIDependency(
  _: unknown,
  args: { fromId: string; toId: string; type: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  await withSession(async (session) => {
    const cypher = `
      MATCH (a:ConfigurationItem {id: $fromId, tenant_id: $tenantId})
      MATCH (b:ConfigurationItem {id: $toId,   tenant_id: $tenantId})
      MERGE (a)-[r:DEPENDS_ON {type: $type}]->(b)
      ON CREATE SET r.created_at = $now
    `
    await runQuery(session, cypher, {
      fromId: args.fromId, toId: args.toId, type: args.type,
      tenantId: ctx.tenantId, now,
    })
  })

  const event: DomainEvent<{ from_id: string; to_id: string; type: string }> = {
    id:             uuidv4(),
    type:           'ci.dependency_added',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { from_id: args.fromId, to_id: args.toId, type: args.type },
  }
  await publish(event)

  return true
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function ciDependencies(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId})-[:DEPENDS_ON]->(d:ConfigurationItem)
      RETURN properties(d) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => mapCI(r.props))
  })
}

async function ciDependents(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (d:ConfigurationItem {tenant_id: $tenantId})-[:DEPENDS_ON]->(ci:ConfigurationItem {id: $id})
      RETURN properties(d) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => mapCI(r.props))
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const cmdbResolvers = {
  Query:   { configurationItems, configurationItem, blastRadius },
  Mutation: { createConfigurationItem, updateConfigurationItem, addCIDependency },
  ConfigurationItem: {
    dependencies: ciDependencies,
    dependents:   ciDependents,
  },
}
