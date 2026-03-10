import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

function mapTeam(props: Props) {
  return {
    id:          props['id']          as string,
    tenantId:    props['tenant_id']   as string,
    name:        props['name']        as string,
    description: props['description'] as string | null,
    createdAt:   props['created_at']  as string,
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

async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function teams(_: unknown, __: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {tenant_id: $tenantId})
      RETURN properties(t) as props
      ORDER BY t.name
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, { tenantId: ctx.tenantId })
    return rows.map((r) => mapTeam(r.props))
  })
}

async function team(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})
      RETURN properties(t) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapTeam(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createTeam(
  _: unknown,
  args: { input: { name: string; description?: string } },
  ctx: GraphQLContext,
) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const cypher = `
      CREATE (t:Team {
        id:          $id,
        tenant_id:   $tenantId,
        name:        $name,
        description: $description,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(t) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id, tenantId: ctx.tenantId, name: input.name, description: input.description ?? null, now,
    })
    const row = rows[0]
    if (!row) throw new Error('Failed to create Team')
    return mapTeam(row.props)
  }, true)
}

async function assignCIOwner(
  _: unknown,
  args: { ciId: string; teamId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      MERGE (ci)-[:OWNED_BY]->(t)
      RETURN properties(ci) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      ciId: args.ciId, teamId: args.teamId, tenantId: ctx.tenantId,
    })
    const row = rows[0]
    if (!row) throw new Error('ConfigurationItem or Team not found')
    return mapCI(row.props)
  }, true)
}

async function assignCISupportGroup(
  _: unknown,
  args: { ciId: string; teamId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      MERGE (ci)-[:SUPPORTED_BY]->(t)
      RETURN properties(ci) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      ciId: args.ciId, teamId: args.teamId, tenantId: ctx.tenantId,
    })
    const row = rows[0]
    if (!row) throw new Error('ConfigurationItem or Team not found')
    return mapCI(row.props)
  }, true)
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function ciOwner(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId})-[:OWNED_BY]->(t:Team)
      RETURN properties(t) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapTeam(row.props) : null
  })
}

async function ciSupportGroup(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId})-[:SUPPORTED_BY]->(t:Team)
      RETURN properties(t) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapTeam(row.props) : null
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const teamResolvers = {
  Query:    { teams, team },
  Mutation: { createTeam, assignCIOwner, assignCISupportGroup },
  ConfigurationItem: {
    owner:        ciOwner,
    supportGroup: ciSupportGroup,
  },
}
