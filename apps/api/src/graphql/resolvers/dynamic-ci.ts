import { withSession } from './ci-utils.js'
import { getSession } from '@opengraphity/neo4j'
import { neo4jDateToISO } from '../../lib/mappers.js'
import { toPascalCase, pluralize } from '@opengraphity/schema-generator'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { cache } from '../../lib/cache.js'
import { ALLOWED_BASE_FIELDS, ALL_CIS_ALLOWED_FIELDS, ciOrderBy, buildBaseWhere, buildAdvancedWhere } from './buildCIQuery.js'
import { buildFieldResolvers, mapTeamProps } from './ciFieldResolvers.js'
import { buildCreateMutation, buildUpdateMutation, buildDeleteMutation } from './ciMutations.js'
import { mapITILField, fetchITILTypeById, buildITILTypesResolver, buildITILTypeFieldsResolver, buildITILMutations } from './itilTypeResolvers.js'
import { requireAdmin, buildCITypesResolver, buildBaseCITypeResolver, buildMetamodelMutations } from './ciTypeMetamodel.js'

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
    chain:        props['chain']       ?? null,
    createdAt:    neo4jDateToISO(props['created_at']) ?? '',
    updatedAt:    neo4jDateToISO(props['updated_at']),
    notes:        props['notes']        ?? null,
    ownerGroup:   null,  // field resolver
    supportGroup: null,  // field resolver
    dependencies: [],    // field resolver
    dependents:   [],    // field resolver
  }

  for (const field of ciType.fields) {
    if (field.isSystem) continue  // already mapped in base object above (with proper date conversion)
    const snakeKey = toSnakeCase(field.name)
    base[field.name] = props[snakeKey] ?? props[field.name] ?? null
  }

  return base
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

// ── Query generiche ───────────────────────────────────────────────────────────

function buildAllCIsResolver(types: CITypeWithDefinitions[]) {
  return async (
    _: unknown,
    args: { limit?: number; offset?: number; type?: string; status?: string; environment?: string; search?: string; filters?: string },
    ctx: GraphQLContext,
  ) => {
    const { limit = 50, offset = 0, type, status, environment, search, filters } = args
    const filteredTypes = type ? types.filter(t => t.name === type) : types
    if (!filteredTypes.length) return { items: [], total: 0 }

    const labelFilter = filteredTypes.map(t => `n:${t.neo4jLabel}`).join(' OR ')
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      status: status ?? null,
      environment: environment ?? null,
      search: search ?? null,
      limit,
      offset,
    }
    const advWhere = filters ? buildAdvancedWhere(filters, params, ALL_CIS_ALLOWED_FIELDS, 'n') : ''
    const baseFilter = `(${labelFilter}) AND n.tenant_id = $tenantId
           AND ($status IS NULL OR n.status = $status)
           AND ($environment IS NULL OR n.environment = $environment)
           AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
           ${advWhere ? `AND (${advWhere})` : ''}`

    const s1 = getSession(undefined, 'READ')
    const s2 = getSession(undefined, 'READ')
    try {
      const [itemsResult, countResult] = await Promise.all([
        s1.executeRead(tx => tx.run(
          `MATCH (n) WHERE ${baseFilter}
           RETURN properties(n) AS props, labels(n)[0] AS label
           ORDER BY n.name ASC SKIP toInteger($offset) LIMIT toInteger($limit)`,
          params,
        )),
        s2.executeRead(tx => tx.run(
          `MATCH (n) WHERE ${baseFilter}
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
           WITH impacted, min(length(path)) AS distance, collect(path) AS paths
           WITH impacted, distance, [p IN paths WHERE length(p) = distance | p][0] AS shortestPath
           RETURN DISTINCT properties(impacted) AS props, labels(impacted)[0] AS label,
             distance, properties(nodes(shortestPath)[-2]) AS parentProps`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const props = rec.get('props') as Props
        const label = rec.get('label') as string
        const rawDist = rec.get('distance')
        const distance = typeof rawDist === 'number' ? rawDist : typeof (rawDist as { toNumber?: () => number })?.toNumber === 'function' ? (rawDist as { toNumber: () => number }).toNumber() : Number(rawDist)
        const parentProps = rec.get('parentProps') as Props | null
        const t = types.find(t => t.neo4jLabel === label)
        if (!t) return null
        return { ci: mapCI(props, t), distance, parentId: (parentProps?.['id'] as string | undefined) ?? args.id }
      }).filter(Boolean)
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
      args: { limit?: number; offset?: number; status?: string; environment?: string; search?: string; filters?: string; sortField?: string; sortDirection?: string },
      ctx: GraphQLContext,
    ) => {
      const { limit = 50, offset = 0, status, environment, search, filters, sortField, sortDirection } = args
      const params: Record<string, unknown> = {
        tenantId: ctx.tenantId,
        status: status ?? null,
        environment: environment ?? null,
        search: search ?? null,
        limit,
        offset,
      }
      const orderBy = ciOrderBy(sortField, sortDirection)
      const allowedFields = new Set([
        ...ALLOWED_BASE_FIELDS,
        ...ciType.fields.filter(f => !f.isSystem).map(f => f.name),
      ])
      const WHERE = buildBaseWhere(filters, params, allowedFields)

      const cacheKey = `ci:${ctx.tenantId}:${neo4jLabel}:${JSON.stringify(params)}:${orderBy}`
      const cachedResult = cache.get<{ items: unknown[]; total: number }>(cacheKey)
      if (cachedResult) return cachedResult

      const s1 = getSession(undefined, 'READ')
      const s2 = getSession(undefined, 'READ')
      try {
        const [items, count] = await Promise.all([
          s1.executeRead(tx => tx.run(
            `MATCH (n:${neo4jLabel} {tenant_id: $tenantId}) WHERE ${WHERE}
             OPTIONAL MATCH (n)-[:OWNED_BY]->(og:Team)
             OPTIONAL MATCH (n)-[:SUPPORTED_BY]->(sg:Team)
             RETURN properties(n) AS props,
               CASE WHEN og IS NOT NULL THEN properties(og) END AS ogProps,
               CASE WHEN sg IS NOT NULL THEN properties(sg) END AS sgProps
             ORDER BY ${orderBy} SKIP toInteger($offset) LIMIT toInteger($limit)`,
            params,
          )),
          s2.executeRead(tx => tx.run(
            `MATCH (n:${neo4jLabel} {tenant_id: $tenantId}) WHERE ${WHERE}
             RETURN count(n) AS total`,
            params,
          )),
        ])
        await Promise.all([s1.close(), s2.close()])
        const result = {
          items: items.records.map(r => {
            const ci = mapCI(r.get('props') as Props, ciType) as Record<string, unknown>
            const ogProps = r.get('ogProps') as Props | null
            const sgProps = r.get('sgProps') as Props | null
            ci['_ownerGroup']   = ogProps ? mapTeamProps(ogProps) : null
            ci['_supportGroup'] = sgProps ? mapTeamProps(sgProps) : null
            ci['_prefetched']   = true
            return ci
          }),
          total: (count.records[0]?.get('total') as { toNumber(): number })?.toNumber?.() ?? 0,
        }
        cache.set(cacheKey, result, 30)
        return result
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

    // ── Mutations: create / update / delete ───────────────────────────────
    Mutation[`create${typeName}`] = buildCreateMutation(ciType, neo4jLabel, mapCI)
    Mutation[`update${typeName}`] = buildUpdateMutation(ciType, neo4jLabel, mapCI)
    Mutation[`delete${typeName}`] = buildDeleteMutation(neo4jLabel)

    // ── Field resolvers ────────────────────────────────────────────────────
    const fieldResolvers = buildFieldResolvers(ciType, types)
    const typeNameLower  = ciType.name.toLowerCase()
    typeResolvers[typeName] = {
      ...fieldResolvers,
      type: (parent: Record<string, unknown>) => parent['type'] ?? parent['ciType'] ?? typeNameLower,
    }
  }

  // Generic queries
  Query['allCIs']        = buildAllCIsResolver(types)
  Query['ciById']        = buildCIByIdResolver(types)
  Query['blastRadius']   = buildBlastRadiusResolver(types)
  Query['ciTypes']       = buildCITypesResolver()
  Query['baseCIType']    = buildBaseCITypeResolver()
  Query['itilTypes']     = buildITILTypesResolver()
  Query['itilTypeFields'] = buildITILTypeFieldsResolver()

  // Metamodel mutations
  const metamodelMutations = buildMetamodelMutations()
  Object.assign(Mutation, metamodelMutations)

  // ITIL Designer mutations
  const itilMutations = buildITILMutations(requireAdmin)
  Object.assign(Mutation, itilMutations)

  return {
    Query,
    Mutation,
    CIBase: {
      __resolveType(obj: { type?: string; __typename?: string; ciType?: string; neo4j_label?: string }) {
        if (obj.__typename) return obj.__typename
        if (obj.ciType) return obj.ciType.charAt(0).toUpperCase() + obj.ciType.slice(1)
        if (obj.neo4j_label) return obj.neo4j_label
        const t = types.find(t => t.name === obj.type)
        return t ? toPascalCase(t.name) : 'Application'
      },
    },
    ...typeResolvers,
  }
}

// Re-export for external use
export { mapITILField, fetchITILTypeById }
export { requireAdmin } from './ciTypeMetamodel.js'
