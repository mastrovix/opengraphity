import { v4 as uuidv4 } from 'uuid'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { mapCI, ciTypeFromLabels, withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import { mapTeam } from '../../lib/mappers.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { audit } from '../../lib/audit.js'

type Props = Record<string, unknown>


// ── Query resolvers ──────────────────────────────────────────────────────────

const TEAM_ALLOWED_FIELDS = new Set(['name', 'createdAt'])

async function teams(_: unknown, args: { filters?: string; sortField?: string; sortDirection?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const params: Record<string, unknown> = { tenantId: ctx.tenantId }
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, TEAM_ALLOWED_FIELDS, 't') : ''
    const sortMap: Record<string, string> = { name: 't.name', type: 't.type', createdAt: 't.created_at' }
    const orderBy = sortMap[args.sortField ?? ''] ?? 't.name'
    const orderDir = args.sortDirection === 'desc' ? 'DESC' : 'ASC'
    const cypher = `
      MATCH (t:Team {tenant_id: $tenantId})
      ${advWhere ? `WHERE ${advWhere}` : ''}
      RETURN properties(t) as props
      ORDER BY ${orderBy} ${orderDir}
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, params)
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
        type:        $type,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(t) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id, tenantId: ctx.tenantId, name: input.name, description: input.description ?? null, type: null, now,
    })
    const row = rows[0]
    if (!row) throw new Error('Failed to create Team')
    void audit(ctx, 'team.created', 'Team', id)
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
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      MERGE (ci)-[:OWNED_BY]->(t)
      RETURN properties(ci) as props, labels(ci)[0] AS label
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, {
      ciId: args.ciId, teamId: args.teamId, tenantId: ctx.tenantId,
    })
    const row = rows[0]
    if (!row) throw new Error('ConfigurationItem or Team not found')
    row.props['type'] = ciTypeFromLabels([row.label])
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
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      MERGE (ci)-[:SUPPORTED_BY]->(t)
      RETURN properties(ci) as props, labels(ci)[0] AS label
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, {
      ciId: args.ciId, teamId: args.teamId, tenantId: ctx.tenantId,
    })
    const row = rows[0]
    if (!row) throw new Error('ConfigurationItem or Team not found')
    row.props['type'] = ciTypeFromLabels([row.label])
    return mapCI(row.props)
  }, true)
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function ciOwner(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci {id: $id, tenant_id: $tenantId})-[:OWNED_BY]->(t:Team)
      RETURN properties(t) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapTeam(row.props) : null
  })
}

async function ciSupportGroup(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci {id: $id, tenant_id: $tenantId})-[:SUPPORTED_BY]->(t:Team)
      RETURN properties(t) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapTeam(row.props) : null
  })
}

async function teamMembers(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})<-[:MEMBER_OF]-(u:User)
      RETURN properties(u) as props
      ORDER BY u.name
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => r.props)
  })
}

async function teamOwnedCIs(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {id: $id, tenant_id: $tenantId})<-[:OWNED_BY]-(n)
      WHERE n.tenant_id = $tenantId
      RETURN properties(n) as props, labels(n)[0] AS label
      ORDER BY n.name
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => {
      r.props['type'] = ciTypeFromLabels([r.label])
      return mapCI(r.props)
    })
  })
}

async function teamSupportedCIs(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (t:Team {id: $id})<-[:SUPPORTED_BY]-(n)
      WHERE n.tenant_id = $tenantId
      RETURN properties(n) as props, labels(n)[0] AS label
      ORDER BY n.name
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => {
      r.props['type'] = ciTypeFromLabels([r.label])
      return mapCI(r.props)
    })
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const teamResolvers = {
  Query:    { teams, team },
  Mutation: { createTeam, assignCIOwner, assignCISupportGroup },
  Team: {
    members:      teamMembers,
    ownedCIs:     teamOwnedCIs,
    supportedCIs: teamSupportedCIs,
  },
}
