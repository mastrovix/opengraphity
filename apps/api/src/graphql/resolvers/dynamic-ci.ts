import { withSession } from './ci-utils.js'
import { getSession } from '@opengraphity/neo4j'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

// ── mapCI ────────────────────────────────────────────────────────────────────

function mapCI(props: Props, ciType: CITypeWithDefinitions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id:           props['id'],
    name:         props['name'],
    type:         ciType.name,           // CIBase interface uses `type: String!`
    status:       props['status']       ?? null,
    environment:  props['environment']  ?? null,
    description:  props['description']  ?? null,
    createdAt:    props['created_at'],
    updatedAt:    props['updated_at']   ?? null,
    notes:        props['notes']        ?? null,
    ownerGroup:   null,  // field resolver
    supportGroup: null,  // field resolver
    dependencies: [],    // field resolver
    dependents:   [],    // field resolver
  }

  for (const field of ciType.fields) {
    const snakeKey = toSnakeCase(field.name)
    base[field.name] = props[snakeKey] ?? props[field.name] ?? null
  }

  return base
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toPascalCase(str: string): string {
  return str.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

function pluralize(str: string): string {
  if (str.endsWith('s')) return str + 'es'
  if (str.endsWith('y')) return str.slice(0, -1) + 'ies'
  return str + 's'
}

// ── Field resolvers per ogni tipo CI ─────────────────────────────────────────

function buildFieldResolvers(ciType: CITypeWithDefinitions, allTypes: CITypeWithDefinitions[]) {
  return {
    ownerGroup: async (parent: { id: string }) =>
      withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run('MATCH (n {id: $id})-[:OWNED_BY]->(t:Team) RETURN properties(t) AS p',
            { id: parent.id }),
        )
        if (!r.records.length) return null
        const p = r.records[0].get('p') as Props
        return { id: p['id'], tenantId: p['tenant_id'], name: p['name'],
          description: p['description'] ?? null, type: p['type'] ?? null,
          createdAt: p['created_at'] }
      }),

    supportGroup: async (parent: { id: string }) =>
      withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run('MATCH (n {id: $id})-[:SUPPORTED_BY]->(t:Team) RETURN properties(t) AS p',
            { id: parent.id }),
        )
        if (!r.records.length) return null
        const p = r.records[0].get('p') as Props
        return { id: p['id'], tenantId: p['tenant_id'], name: p['name'],
          description: p['description'] ?? null, type: p['type'] ?? null,
          createdAt: p['created_at'] }
      }),

    dependencies: async (parent: { id: string }, _: unknown, ctx: GraphQLContext) =>
      withSession(async session => {
        const outgoing = ciType.relations.filter(r => r.direction === 'outgoing')
        if (!outgoing.length) return []
        // Collect all relationship types, handle pipe-separated values
        const relTypes = [...new Set(outgoing.flatMap(r => r.relationshipType.split('|')))].join('|')
        const r = await session.executeRead(tx =>
          tx.run(
            `MATCH (n {id: $id})-[rel:${relTypes}]->(d)
             WHERE d.tenant_id = $tenantId
             RETURN properties(d) AS props, labels(d)[0] AS label, type(rel) AS relation
             ORDER BY d.name`,
            { id: parent.id, tenantId: ctx.tenantId },
          ),
        )
        return r.records.map(rec => {
          const props = rec.get('props') as Props
          const label = rec.get('label') as string
          const relation = rec.get('relation') as string
          const targetType = allTypes.find(t => t.neo4jLabel === label)
          if (!targetType) return null
          return { ci: mapCI(props, targetType), relation }
        }).filter(Boolean)
      }),

    dependents: async (parent: { id: string }, _: unknown, ctx: GraphQLContext) =>
      withSession(async session => {
        const incoming = ciType.relations.filter(r => r.direction === 'incoming')
        if (!incoming.length) return []
        const relTypes = [...new Set(incoming.flatMap(r => r.relationshipType.split('|')))].join('|')
        const r = await session.executeRead(tx =>
          tx.run(
            `MATCH (n {id: $id})<-[rel:${relTypes}]-(d)
             WHERE d.tenant_id = $tenantId
             RETURN properties(d) AS props, labels(d)[0] AS label, type(rel) AS relation
             ORDER BY d.name`,
            { id: parent.id, tenantId: ctx.tenantId },
          ),
        )
        return r.records.map(rec => {
          const props = rec.get('props') as Props
          const label = rec.get('label') as string
          const relation = rec.get('relation') as string
          const targetType = allTypes.find(t => t.neo4jLabel === label)
          if (!targetType) return null
          return { ci: mapCI(props, targetType), relation }
        }).filter(Boolean)
      }),
  }
}

// ── Query generiche ───────────────────────────────────────────────────────────

function buildAllCIsResolver(types: CITypeWithDefinitions[]) {
  return async (
    _: unknown,
    args: { limit?: number; offset?: number; ciType?: string; status?: string; environment?: string; search?: string },
    ctx: GraphQLContext,
  ) => {
    const { limit = 50, offset = 0, ciType, status, environment, search } = args
    const filteredTypes = ciType ? types.filter(t => t.name === ciType) : types
    if (!filteredTypes.length) return { items: [], total: 0 }

    const labelFilter = filteredTypes.map(t => `n:${t.neo4jLabel}`).join(' OR ')
    const params = {
      tenantId: ctx.tenantId,
      status: status ?? null,
      environment: environment ?? null,
      search: search ?? null,
      limit,
      offset,
    }

    const s1 = getSession(undefined, 'READ')
    const s2 = getSession(undefined, 'READ')
    try {
      const [itemsResult, countResult] = await Promise.all([
        s1.executeRead(tx => tx.run(
          `MATCH (n) WHERE (${labelFilter}) AND n.tenant_id = $tenantId
           AND ($status IS NULL OR n.status = $status)
           AND ($environment IS NULL OR n.environment = $environment)
           AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
           RETURN properties(n) AS props, labels(n)[0] AS label
           ORDER BY n.name ASC SKIP toInteger($offset) LIMIT toInteger($limit)`,
          params,
        )),
        s2.executeRead(tx => tx.run(
          `MATCH (n) WHERE (${labelFilter}) AND n.tenant_id = $tenantId
           AND ($status IS NULL OR n.status = $status)
           AND ($environment IS NULL OR n.environment = $environment)
           AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
           RETURN count(n) AS total`,
          params,
        )),
      ])
      await Promise.all([s1.close(), s2.close()])

      return {
        items: itemsResult.records.map(rec => {
          const props = rec.get('props') as Props
          const label = rec.get('label') as string
          const t = types.find(t => t.neo4jLabel === label)
          return t ? mapCI(props, t) : null
        }).filter(Boolean),
        total: (countResult.records[0]?.get('total') as { toNumber(): number })?.toNumber?.() ?? 0,
      }
    } catch (err) {
      await Promise.allSettled([s1.close(), s2.close()])
      throw err
    }
  }
}

function buildCIByIdResolver(types: CITypeWithDefinitions[]) {
  return async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    withSession(async session => {
      const labelFilter = types.map(t => `n:${t.neo4jLabel}`).join(' OR ')
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (n) WHERE (${labelFilter}) AND n.id = $id AND n.tenant_id = $tenantId
           RETURN properties(n) AS props, labels(n)[0] AS label`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
      if (!r.records.length) return null
      const props = r.records[0].get('props') as Props
      const label = r.records[0].get('label') as string
      const t = types.find(t => t.neo4jLabel === label)
      return t ? mapCI(props, t) : null
    })
}

function buildBlastRadiusResolver(types: CITypeWithDefinitions[]) {
  return async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (root {id: $id, tenant_id: $tenantId})
           MATCH path = (root)<-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..5]-(impacted)
           WHERE impacted.tenant_id = $tenantId
           WITH impacted, min(length(path)) AS distance,
             [p IN collect(path) WHERE length(p) = min(length(path)) | p][0] AS shortestPath
           RETURN DISTINCT properties(impacted) AS props, labels(impacted)[0] AS label,
             distance, properties(nodes(shortestPath)[-2]) AS parentProps`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const props = rec.get('props') as Props
        const label = rec.get('label') as string
        const distance = (rec.get('distance') as { toNumber(): number }).toNumber()
        const parentProps = rec.get('parentProps') as Props | null
        const t = types.find(t => t.neo4jLabel === label)
        if (!t) return null
        return { ci: mapCI(props, t), distance, parentId: (parentProps?.['id'] as string | undefined) ?? args.id }
      }).filter(Boolean)
    })
}

function buildCITypesResolver() {
  return async (_: unknown, __: unknown, ctx: GraphQLContext) =>
    withSession(async session => {
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (t:CITypeDefinition)
           WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))
             AND t.active = true
           OPTIONAL MATCH (t)-[:HAS_FIELD]->(f:CIFieldDefinition)
           OPTIONAL MATCH (t)-[:HAS_RELATION]->(rel:CIRelationDefinition)
           OPTIONAL MATCH (t)-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)
           RETURN t, collect(DISTINCT f) AS fields, collect(DISTINCT rel) AS relations,
             collect(DISTINCT sr) AS systemRels
           ORDER BY t.name`,
          { tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const t = rec.get('t').properties as Props
        return {
          id:    t['id'],
          name:  t['name'],
          label: t['label'],
          icon:  t['icon'],
          color: t['color'],
          active: t['active'],
          fields: (rec.get('fields') as Array<{ properties: Props }>)
            .filter(f => f?.properties)
            .map(f => f.properties)
            .map(f => ({
              id: f['id'], name: f['name'], label: f['label'],
              fieldType: f['field_type'], required: f['required'] ?? false,
              defaultValue: f['default_value'] ?? null,
              enumValues: f['enum_values'] ? JSON.parse(f['enum_values'] as string) as string[] : [],
              order: f['order'] ?? 0,
            })),
          relations: (rec.get('relations') as Array<{ properties: Props }>)
            .filter(r => r?.properties)
            .map(r => r.properties)
            .map(r => ({
              id: r['id'], name: r['name'], label: r['label'],
              relationshipType: r['relationship_type'], targetType: r['target_type'],
              cardinality: r['cardinality'], direction: r['direction'], order: r['order'] ?? 0,
            })),
          systemRelations: (rec.get('systemRels') as Array<{ properties: Props }>)
            .filter(sr => sr?.properties)
            .map(sr => sr.properties)
            .map(sr => ({
              id: sr['id'], name: sr['name'], label: sr['label'],
              relationshipType: sr['relationship_type'], targetEntity: sr['target_entity'],
              required: sr['required'] ?? false, order: sr['order'] ?? 0,
            })),
        }
      })
    })
}

// ── Factory principale ────────────────────────────────────────────────────────

export function buildDynamicCIResolvers(types: CITypeWithDefinitions[]): Record<string, unknown> {
  const Query: Record<string, unknown> = {}
  const Mutation: Record<string, unknown> = {}
  const typeResolvers: Record<string, unknown> = {}

  for (const ciType of types) {
    const typeName = toPascalCase(ciType.name)
    const pluralName = pluralize(typeName)
    const queryListKey  = pluralName.charAt(0).toLowerCase() + pluralName.slice(1)
    const neo4jLabel    = ciType.neo4jLabel

    // ── Query: lista ───────────────────────────────────────────────────────
    Query[queryListKey] = async (
      _: unknown,
      args: { limit?: number; offset?: number; status?: string; environment?: string; search?: string },
      ctx: GraphQLContext,
    ) => {
      const { limit = 50, offset = 0, status, environment, search } = args
      const params = {
        tenantId: ctx.tenantId,
        status: status ?? null,
        environment: environment ?? null,
        search: search ?? null,
        limit,
        offset,
      }
      const WHERE = `($status IS NULL OR n.status = $status)
        AND ($environment IS NULL OR n.environment = $environment)
        AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))`

      const s1 = getSession(undefined, 'READ')
      const s2 = getSession(undefined, 'READ')
      try {
        const [items, count] = await Promise.all([
          s1.executeRead(tx => tx.run(
            `MATCH (n:${neo4jLabel} {tenant_id: $tenantId}) WHERE ${WHERE}
             RETURN properties(n) AS props ORDER BY n.name ASC
             SKIP toInteger($offset) LIMIT toInteger($limit)`,
            params,
          )),
          s2.executeRead(tx => tx.run(
            `MATCH (n:${neo4jLabel} {tenant_id: $tenantId}) WHERE ${WHERE}
             RETURN count(n) AS total`,
            params,
          )),
        ])
        await Promise.all([s1.close(), s2.close()])
        return {
          items: items.records.map(r => mapCI(r.get('props') as Props, ciType)),
          total: (count.records[0]?.get('total') as { toNumber(): number })?.toNumber?.() ?? 0,
        }
      } catch (err) {
        await Promise.allSettled([s1.close(), s2.close()])
        throw err
      }
    }

    // ── Query: singolo ─────────────────────────────────────────────────────
    Query[ciType.name] = async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
      withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run(
            `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS props`,
            { id: args.id, tenantId: ctx.tenantId },
          ),
        )
        return r.records.length ? mapCI(r.records[0].get('props') as Props, ciType) : null
      })

    // ── Mutation: create ───────────────────────────────────────────────────
    Mutation[`create${typeName}`] = async (_: unknown, args: { input: Record<string, unknown> }, ctx: GraphQLContext) =>
      withSession(async (session) => {
        const { input } = args
        const id  = crypto.randomUUID()
        const now = new Date().toISOString()

        const props: Record<string, unknown> = {
          id, tenant_id: ctx.tenantId,
          name:        input['name'],
          type:        ciType.name,
          status:      input['status']      ?? 'active',
          environment: input['environment'] ?? null,
          description: input['description'] ?? null,
          notes:       input['notes']       ?? null,
          created_at:  now, updated_at: now,
        }
        for (const field of ciType.fields) {
          if (input[field.name] !== undefined) {
            props[toSnakeCase(field.name)] = input[field.name]
          }
        }

        const result = await session.executeWrite(tx =>
          tx.run(`CREATE (n:${neo4jLabel} $props) RETURN properties(n) AS p`, { props }),
        )

        if (input['ownerGroupId']) {
          await session.executeWrite(tx =>
            tx.run(
              `MATCH (n:${neo4jLabel} {id: $id}) MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
               MERGE (n)-[:OWNED_BY]->(t)`,
              { id, teamId: input['ownerGroupId'], tenantId: ctx.tenantId },
            ),
          )
        }
        if (input['supportGroupId']) {
          await session.executeWrite(tx =>
            tx.run(
              `MATCH (n:${neo4jLabel} {id: $id}) MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
               MERGE (n)-[:SUPPORTED_BY]->(t)`,
              { id, teamId: input['supportGroupId'], tenantId: ctx.tenantId },
            ),
          )
        }

        return mapCI(result.records[0].get('p') as Props, ciType)
      }, true)

    // ── Mutation: update ───────────────────────────────────────────────────
    Mutation[`update${typeName}`] = async (
      _: unknown,
      args: { id: string; input: Record<string, unknown> },
      ctx: GraphQLContext,
    ) =>
      withSession(async session => {
        const { id, input } = args
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
        for (const f of ['name', 'status', 'environment', 'description', 'notes']) {
          if (input[f] !== undefined) updates[f] = input[f]
        }
        for (const field of ciType.fields) {
          if (input[field.name] !== undefined) {
            updates[toSnakeCase(field.name)] = input[field.name]
          }
        }
        const result = await session.executeWrite(tx =>
          tx.run(
            `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) SET n += $updates RETURN properties(n) AS p`,
            { id, tenantId: ctx.tenantId, updates },
          ),
        )
        if (!result.records.length) throw new Error('CI non trovato')
        return mapCI(result.records[0].get('p') as Props, ciType)
      }, true)

    // ── Mutation: delete ───────────────────────────────────────────────────
    Mutation[`delete${typeName}`] = async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
      withSession(async session => {
        await session.executeWrite(tx =>
          tx.run(
            `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) DETACH DELETE n`,
            { id: args.id, tenantId: ctx.tenantId },
          ),
        )
        return true
      }, true)

    // ── Field resolvers ────────────────────────────────────────────────────
    typeResolvers[typeName] = buildFieldResolvers(ciType, types)
  }

  // Generic queries
  Query['allCIs']       = buildAllCIsResolver(types)
  Query['ciById']       = buildCIByIdResolver(types)
  Query['blastRadius']  = buildBlastRadiusResolver(types)
  Query['ciTypes']      = buildCITypesResolver()

  return {
    Query,
    Mutation,
    CIBase: {
      __resolveType(obj: { type?: string }) {
        const t = types.find(t => t.name === obj.type)
        return t ? toPascalCase(t.name) : null
      },
    },
    ...typeResolvers,
  }
}
