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
    // optional technical fields
    ipAddress:   (props['ip_address']  ?? null) as string | null,
    expiryDate:  (props['expiry_date'] ?? null) as string | null,
    location:    (props['location']    ?? null) as string | null,
    vendor:      (props['vendor']      ?? null) as string | null,
    version:     (props['version']     ?? null) as string | null,
    port:        (props['port']        ?? null) as number | null,
    url:         (props['url']         ?? null) as string | null,
    region:      (props['region']      ?? null) as string | null,
    notes:       (props['notes']       ?? null) as string | null,
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

async function configurationItems(
  _: unknown,
  args: { type?: string; environment?: string; status?: string; search?: string; limit?: number; offset?: number },
  ctx: GraphQLContext,
) {
  const { type, environment, status, search, limit = 50, offset = 0 } = args
  return withSession(async (session) => {
    const whereClause = `
      WHERE ($type        IS NULL OR ci.type        = $type)
        AND ($environment IS NULL OR ci.environment = $environment)
        AND ($status      IS NULL OR ci.status      = $status)
        AND ($search      IS NULL OR toLower(ci.name) CONTAINS toLower($search))
    `
    const params = {
      tenantId:    ctx.tenantId,
      type:        type        ?? null,
      environment: environment ?? null,
      status:      status      ?? null,
      search:      search      ?? null,
      offset,
      limit,
    }

    const itemRows  = await runQuery<{ props: Props }>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      ${whereClause}
      WITH ci ORDER BY ci.name
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(ci) as props
    `, params)
    const countRows = await runQuery<{ total: number }>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      ${whereClause}
      RETURN count(ci) AS total
    `, params)

    return {
      items: itemRows.map((r) => mapCI(r.props)),
      total: (countRows[0]?.total as unknown as { toNumber(): number })?.toNumber?.() ?? Number(countRows[0]?.total ?? 0),
    }
  })
}

async function ciTypes(
  _: unknown,
  __: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ type: string; count: number }>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      RETURN ci.type AS type, count(ci) AS count
      ORDER BY count DESC
    `, { tenantId: ctx.tenantId })
    return rows.map((r) => ({
      type:  r.type,
      count: (r.count as unknown as { toNumber(): number })?.toNumber?.() ?? Number(r.count),
    }))
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
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      MATCH path = (ci)-[:DEPENDS_ON|HOSTED_ON*1..${depth}]->(d:ConfigurationItem)
      WHERE d.tenant_id = $tenantId
      AND d.id <> $ciId
      WITH d, min(length(path)) AS distance
      RETURN
        d.id AS id, d.name AS name,
        d.type AS type,
        d.environment AS environment,
        d.status AS status,
        distance
      ORDER BY distance ASC, d.name ASC
    `
    const rows = await runQuery<{
      id: string; name: string; type: string;
      environment: string; status: string;
      distance: number
    }>(session, cypher, {
      ciId: args.ciId, tenantId: ctx.tenantId,
    })
    return rows.map((r) => ({
      id:          r.id,
      name:        r.name,
      type:        r.type,
      environment: r.environment ?? null,
      status:      r.status ?? null,
      distance:    typeof r.distance === 'object'
        ? (r.distance as any).toNumber()
        : Number(r.distance),
    }))
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
  }, true)

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
  }, true)
}

async function updateCIFields(
  _: unknown,
  args: {
    id: string
    input: {
      name?: string; status?: string; environment?: string
      ipAddress?: string; location?: string; vendor?: string; version?: string
      port?: number; url?: string; region?: string; expiryDate?: string; notes?: string
    }
  },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId})
      SET ci += {
        name:        coalesce($name,       ci.name),
        status:      coalesce($status,     ci.status),
        environment: coalesce($environment, ci.environment),
        ip_address:  coalesce($ipAddress,  ci.ip_address),
        location:    coalesce($location,   ci.location),
        vendor:      coalesce($vendor,     ci.vendor),
        version:     coalesce($version,    ci.version),
        port:        coalesce($port,       ci.port),
        url:         coalesce($url,        ci.url),
        region:      coalesce($region,     ci.region),
        expiry_date: coalesce($expiryDate, ci.expiry_date),
        notes:       coalesce($notes,      ci.notes),
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
      ipAddress:   input.ipAddress   ?? null,
      location:    input.location    ?? null,
      vendor:      input.vendor      ?? null,
      version:     input.version     ?? null,
      port:        input.port        ?? null,
      url:         input.url         ?? null,
      region:      input.region      ?? null,
      expiryDate:  input.expiryDate  ?? null,
      notes:       input.notes       ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('ConfigurationItem not found')
    return mapCI(row.props)
  }, true)
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
  }, true)

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

async function ciDependenciesWithType(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (ci:ConfigurationItem {id: $id, tenant_id: $tenantId})-[r]->(d:ConfigurationItem)
      RETURN properties(d) as props, type(r) as relationType
    `
    const rows = await runQuery<{ props: Props; relationType: string }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => ({ ci: mapCI(r.props), relationType: r.relationType }))
  })
}

async function ciDependentsWithType(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (d:ConfigurationItem)-[r]->(ci:ConfigurationItem {id: $id})
      WHERE ci.tenant_id = $tenantId
      RETURN properties(d) as props, type(r) as relationType
    `
    const rows = await runQuery<{ props: Props; relationType: string }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => ({ ci: mapCI(r.props), relationType: r.relationType }))
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const cmdbResolvers = {
  Query:   { configurationItems, configurationItem, blastRadius, ciTypes },
  Mutation: { createConfigurationItem, updateConfigurationItem, updateCIFields, addCIDependency },
  ConfigurationItem: {
    dependencies:         ciDependencies,
    dependents:           ciDependents,
    dependenciesWithType: ciDependenciesWithType,
    dependentsWithType:   ciDependentsWithType,
  },
}
