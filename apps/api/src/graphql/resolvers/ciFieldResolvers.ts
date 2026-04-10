import { withSession } from './ci-utils.js'
import { neo4jDateToISO } from '../../lib/mappers.js'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

export type TeamResult = {
  id: string; tenantId: string; name: string
  description: string | null; type: string | null; createdAt: string | null
}

type PrefetchedCI = { _ownerGroup?: TeamResult | null; _supportGroup?: TeamResult | null; _prefetched?: boolean }

export function mapTeamProps(p: Props): TeamResult {
  return {
    id: p['id'] as string,
    tenantId: p['tenant_id'] as string,
    name: p['name'] as string,
    description: (p['description'] as string | null) ?? null,
    type: (p['type'] as string | null) ?? null,
    createdAt: neo4jDateToISO(p['created_at']),
  }
}

function mapCIForRelation(props: Props, typeName: string): Record<string, unknown> {
  return {
    id:          props['id'],
    name:        props['name'],
    type:        typeName,
    status:      props['status'] ?? null,
    environment: props['environment'] ?? null,
  }
}

export function buildFieldResolvers(ciType: CITypeWithDefinitions, allTypes: CITypeWithDefinitions[]) {
  return {
    ownerGroup: async (parent: { id: string } & PrefetchedCI) => {
      if (parent._prefetched) return parent._ownerGroup ?? null
      return withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run('MATCH (n {id: $id})-[:OWNED_BY]->(t:Team) RETURN properties(t) AS p',
            { id: parent.id }),
        )
        if (!r.records.length) return null
        return mapTeamProps(r.records[0].get('p') as Props)
      })
    },

    supportGroup: async (parent: { id: string } & PrefetchedCI) => {
      if (parent._prefetched) return parent._supportGroup ?? null
      return withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run('MATCH (n {id: $id})-[:SUPPORTED_BY]->(t:Team) RETURN properties(t) AS p',
            { id: parent.id }),
        )
        if (!r.records.length) return null
        return mapTeamProps(r.records[0].get('p') as Props)
      })
    },

    dependencies: async (parent: { id: string }, _: unknown, ctx: GraphQLContext) =>
      withSession(async session => {
        const outgoing = ciType.relations.filter(r => r.direction === 'outgoing')
        if (!outgoing.length) return []
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
          return { ci: mapCIForRelation(props, targetType.name), relation }
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
          return { ci: mapCIForRelation(props, targetType.name), relation }
        }).filter(Boolean)
      }),
  }
}
