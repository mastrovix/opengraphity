import { withSession } from './ci-utils.js'
import { GraphQLError } from 'graphql'
import { getSession, toNumber } from '@opengraphity/neo4j'
import { neo4jDateToISO, toSnakeCase } from '../../lib/mappers.js'
import { toPascalCase, pluralize } from '@opengraphity/schema-generator'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'
import { cache } from '../../lib/cache.js'
import { ALLOWED_BASE_FIELDS, ALL_CIS_ALLOWED_FIELDS, ciOrderBy, allCIsOrderBy, CI_TYPE_ORDER_EXPR, buildBaseWhere, buildAdvancedWhere } from './buildCIQuery.js'
import { buildFieldResolvers, mapTeamProps } from './ciFieldResolvers.js'
import { buildCreateMutation, buildUpdateMutation, buildDeleteMutation } from './ciMutations.js'
import { mapITILField, fetchITILTypeById, buildITILTypesResolver, buildITILTypeFieldsResolver, buildITILFieldValueCountResolver, buildITILMutations } from './itilTypeResolvers.js'
import { requireMetamodelPermission, buildCITypesResolver, buildBaseCITypeResolver, buildMetamodelMutations, ciTypeDeletionImpact, ciFieldValueCount } from './ciTypeMetamodel.js'
import { impactRelPatternForTenant } from '../../lib/ciMetamodelForTenant.js'

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
    // Event Management (sola lettura: scritti da eventService)
    health:       props['health']        ?? null,
    healthSource: props['health_source'] ?? null,
    lastEventAt:  neo4jDateToISO(props['last_event_at']),
  }

  for (const field of ciType.fields) {
    if (field.isSystem) continue  // already mapped in base object above (with proper date conversion)
    const snakeKey = toSnakeCase(field.name)
    base[field.name] = props[snakeKey] ?? props[field.name] ?? null
  }

  return base
}

// ── Query generiche ───────────────────────────────────────────────────────────

/**
 * I tipi nominati in un filtro, per nome (`business_application`) o per
 * etichetta (`BusinessApplication`, anche in minuscolo). Un nome che non è un
 * tipo di questo cliente è un errore che lo dice: un filtro che non riconosce
 * un tipo e lo ignora mostrerebbe proprio i CI che si voleva togliere.
 */
function matchTypes(types: CITypeWithDefinitions[], names: (string | null)[] | null | undefined, what: string): Set<CITypeWithDefinitions> | null {
  if (!names || names.length === 0) return null
  const out = new Set<CITypeWithDefinitions>()
  for (const raw of names) {
    if (!raw) continue
    const key = raw.trim().toLowerCase()
    const hit = types.find(t => t.name.toLowerCase() === key || t.neo4jLabel.toLowerCase() === key)
    if (!hit) {
      throw new GraphQLError(`allCIs(${what}): "${raw}" is not a CI type of this tenant.`, {
        extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.ciType.unknown', params: { type: raw, allowed: types.map(t => t.name).sort().join(', ') } } },
      })
    }
    out.add(hit)
  }
  return out
}

function buildAllCIsResolver(types: CITypeWithDefinitions[]) {
  return async (
    _: unknown,
    args: { limit?: number; offset?: number; type?: string; status?: string; environment?: string; search?: string; filters?: string; ciTypes?: (string | null)[] | null; excludeCiTypes?: (string | null)[] | null; sortField?: string | null; sortDirection?: string | null },
    ctx: GraphQLContext,
  ) => {
    const { limit = 50, offset = 0, type, status, environment, search, filters } = args
    // `ciTypes` era dichiarato nello schema e ignorato qui: la ricerca dei CI
    // da collegare a un ticket «filtrava» per tipo senza filtrare niente.
    // `excludeCiTypes` (CM-8) toglie i tipi esclusi per il tipo di ticket.
    const only    = matchTypes(types, args.ciTypes, 'ciTypes')
    const without = matchTypes(types, args.excludeCiTypes, 'excludeCiTypes')
    const filteredTypes = types
      .filter(t => !type || t.name === type)
      .filter(t => !only || only.has(t))
      .filter(t => !without || !without.has(t))
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
    /*
     * I CAMPI FILTRABILI DIPENDONO DAI TIPI CERCATI (19 set 2026).
     *
     * `ALL_CIS_ALLOWED_FIELDS` sono i cinque comuni a tutti i CI (nome, stato,
     * ambiente, salute, data). Cercando dentro tipi PRECISI — ed è quello che
     * fa un campo del modulo che punta alla CMDB con i suoi `refTypes` — si
     * possono filtrare anche le loro proprietà: «costruttore = Dell» su un
     * tipo che ha il costruttore. Fuori da quei tipi il campo non esiste, e
     * infatti l'elenco si costruisce sui tipi DAVVERO cercati.
     */
    const allowedFields = new Set([
      ...ALL_CIS_ALLOWED_FIELDS,
      ...filteredTypes.flatMap((t) => t.fields.filter((f) => !f.isSystem).map((f) => f.name)),
    ])
    const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'n') : ''
    // B-9: l'ordinamento chiesto dalla CMDB veniva ignorato.
    const orderBy = allCIsOrderBy(args.sortField, args.sortDirection)
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
           RETURN properties(n) AS props, ${CI_TYPE_ORDER_EXPR} AS label
           ORDER BY ${orderBy} SKIP toInteger($offset) LIMIT toInteger($limit)`,
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
        total: toNumber(countResult.records[0]?.get('total')),
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
           RETURN properties(n) AS props, head([l IN labels(n) WHERE l <> 'ConfigurationItem']) AS label`,
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
      // CM-3: le relazioni dell'impatto del tenant (le stesse di impact.ts),
      // non una lista scritta qui che ignorava quelle del cliente.
      const relPattern = await impactRelPatternForTenant(ctx.tenantId)
      const r = await session.executeRead(tx =>
        tx.run(
          `MATCH (root:ConfigurationItem {id: $id, tenant_id: $tenantId})
           MATCH path = (root)<-[:${relPattern}*1..5]-(impacted)
           WHERE impacted.tenant_id = $tenantId
           WITH impacted, min(length(path)) AS distance, collect(path) AS paths
           WITH impacted, distance, [p IN paths WHERE length(p) = distance | p][0] AS shortestPath
           RETURN DISTINCT properties(impacted) AS props, head([l IN labels(impacted) WHERE l <> 'ConfigurationItem']) AS label,
             distance, properties(nodes(shortestPath)[-2]) AS parentProps`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
      return r.records.map(rec => {
        const props = rec.get('props') as Props
        const label = rec.get('label') as string
        const rawDist = rec.get('distance')
        const distance = toNumber(rawDist)
        const parentProps = rec.get('parentProps') as Props | null
        const t = types.find(t => t.neo4jLabel === label)
        if (!t) return null
        return { ci: mapCI(props, t), distance, parentId: (parentProps?.['id'] as string | undefined) ?? args.id }
      }).filter(Boolean)
    })
}

// ── Factory principale ────────────────────────────────────────────────────────

/**
 * I campi root generati per ogni tipo di CI: i loro nomi li sceglie il cliente,
 * quindi la policy non li può elencare e li apre con `cmdb.read` / `cmdb.write`
 * (lib/operationPermissions.ts). Stessi nomi di `buildDynamicCIResolvers`.
 */
export function dynamicCIRootFields(types: CITypeWithDefinitions[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const ciType of types) {
    const typeName = toPascalCase(ciType.name)
    const pluralName = pluralize(typeName)
    out.add(`Query.${pluralName.charAt(0).toLowerCase() + pluralName.slice(1)}`)
    out.add(`Query.${ciType.name}`)
    for (const verb of ['create', 'update', 'delete']) out.add(`Mutation.${verb}${typeName}`)
  }
  return out
}

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
          total: toNumber(count.records[0]?.get('total')),
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
  Query['ciTypeDeletionImpact'] = ciTypeDeletionImpact
  Query['ciFieldValueCount'] = ciFieldValueCount
  Query['baseCIType']    = buildBaseCITypeResolver()
  Query['itilTypes']     = buildITILTypesResolver()
  Query['itilTypeFields'] = buildITILTypeFieldsResolver()
  Query['itilFieldValueCount'] = buildITILFieldValueCountResolver()

  // Metamodel mutations
  const metamodelMutations = buildMetamodelMutations()
  Object.assign(Mutation, metamodelMutations)

  // ITIL Designer mutations
  const itilMutations = buildITILMutations(requireMetamodelPermission)
  Object.assign(Mutation, itilMutations)

  return {
    Query,
    Mutation,
    CIBase: {
      // A-8: il ripiego su `'Application'` diceva al client che un CI di tipo
      // sconosciuto è un'Application — i suoi campi non esistono su quel tipo,
      // e la pagina di dettaglio mostrava un'altra cosa senza che nessuno lo
      // sapesse. Il caso si presenta quando il tipo è stato cancellato o
      // disattivato mentre i suoi CI erano ancora nel grafo (ora rifiutato,
      // vedi `assertCITypeNotInUse`) o dopo una discovery che ha inventato
      // un'etichetta (ora rifiutata, vedi `reconcileOne`): sono guasti da
      // dire, non da nascondere.
      __resolveType(obj: { type?: string; __typename?: string; ciType?: string; neo4j_label?: string }) {
        if (obj.__typename) return obj.__typename
        if (obj.ciType) return obj.ciType.charAt(0).toUpperCase() + obj.ciType.slice(1)
        if (obj.neo4j_label) return obj.neo4j_label
        const t = types.find(t => t.name === obj.type)
        if (t) return toPascalCase(t.name)
        throw new GraphQLError(
          `CIBase: the type of this CI cannot be told (type=${JSON.stringify(obj.type)}). `
          + `No active CI type of this tenant declares it: the type was deleted or deactivated, `
          + `or the CI came from a discovery with a type the metamodel does not have.`,
          { extensions: { i18n: { key: 'errors.ci.unknownTypeOnRecord', params: { type: JSON.stringify(obj.type) } } } },
        )
      },
    },
    ...typeResolvers,
  }
}

// Re-export for external use
export { mapITILField, fetchITILTypeById }
export { requireMetamodelPermission } from './ciTypeMetamodel.js'
