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
    chain:       props['chain'] ?? null,
  }
}

/**
 * Il metamodello dichiara l'arco `relType` da un CI con etichetta `sourceLabel`
 * a uno con etichetta `targetLabel`? O come relazione in uscita del tipo
 * sorgente, o come relazione in entrata del tipo destinazione; `targetType` è
 * l'etichetta dell'altro capo o `any`. È lo stesso predicato di
 * `relationDeclared` (ciRelationships.ts), qui sui tipi già caricati.
 */
export function relationDeclaredBy(
  types: readonly CITypeWithDefinitions[], relType: string, sourceLabel: string, targetLabel: string,
): boolean {
  const lists = (t: CITypeWithDefinitions, dir: 'outgoing' | 'incoming', other: string) =>
    t.relations.some((r) => r.direction === dir
      && r.relationshipType.split('|').map((x) => x.trim()).includes(relType)
      && (r.targetType === 'any' || r.targetType === other))
  return types.some((t) => (t.neo4jLabel === sourceLabel && lists(t, 'outgoing', targetLabel))
    || (t.neo4jLabel === targetLabel && lists(t, 'incoming', sourceLabel)))
}

/**
 * Le dipendenze e i dipendenti di un CI.
 *
 * ## Il difetto (revisione del 15 set 2026 · CM-5)
 * Si leggevano solo i tipi di relazione dichiarati dal tipo DEL CI. Ma un arco
 * è legittimo anche quando lo dichiara l'altro capo: l'applicazione dichiara
 * `DEPENDS_ON → any`, e l'arco verso un firewall veniva creato; il firewall non
 * dichiara relazioni in entrata, e nel suo dettaglio non si vedeva niente.
 * Adesso si leggono gli archi verso CI del tenant e si tengono quelli che il
 * metamodello dichiara da una parte o dall'altra.
 */
async function relatedCIs(
  ciType: CITypeWithDefinitions, allTypes: CITypeWithDefinitions[], id: string, tenantId: string, direction: 'outgoing' | 'incoming',
) {
  const labels = allTypes.map((t) => t.neo4jLabel).filter(Boolean)
  return withSession(async session => {
    const pattern = direction === 'outgoing' ? '(n)-[rel]->(d)' : '(n)<-[rel]-(d)'
    const r = await session.executeRead(tx =>
      tx.run(
        `MATCH (n:ConfigurationItem {id: $id, tenant_id: $tenantId})
         MATCH ${pattern}
         WHERE d.tenant_id = $tenantId AND ANY(l IN labels(d) WHERE l IN $labels)
         RETURN properties(d) AS props, head([l IN labels(d) WHERE l <> 'ConfigurationItem']) AS label, type(rel) AS relation
         ORDER BY d.name`,
        { id, tenantId, labels },
      ),
    )
    return r.records.map(rec => {
      const props = rec.get('props') as Props
      const label = rec.get('label') as string
      const relation = rec.get('relation') as string
      const otherType = allTypes.find(t => t.neo4jLabel === label)
      if (!otherType) return null
      const declared = direction === 'outgoing'
        ? relationDeclaredBy(allTypes, relation, ciType.neo4jLabel, label)
        : relationDeclaredBy(allTypes, relation, label, ciType.neo4jLabel)
      if (!declared) return null
      return { ci: mapCIForRelation(props, otherType.name), relation }
    }).filter(Boolean)
  })
}

export function buildFieldResolvers(ciType: CITypeWithDefinitions, allTypes: CITypeWithDefinitions[]) {
  return {
    ownerGroup: async (parent: { id: string } & PrefetchedCI, _: unknown, ctx: GraphQLContext) => {
      if (parent._prefetched) return parent._ownerGroup ?? null
      return withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run('MATCH (n:ConfigurationItem {id: $id, tenant_id: $tenantId})-[:OWNED_BY]->(t:Team {tenant_id: $tenantId}) RETURN properties(t) AS p',
            { id: parent.id, tenantId: ctx.tenantId }),
        )
        if (!r.records.length) return null
        return mapTeamProps(r.records[0].get('p') as Props)
      })
    },

    supportGroup: async (parent: { id: string } & PrefetchedCI, _: unknown, ctx: GraphQLContext) => {
      if (parent._prefetched) return parent._supportGroup ?? null
      return withSession(async session => {
        const r = await session.executeRead(tx =>
          tx.run('MATCH (n:ConfigurationItem {id: $id, tenant_id: $tenantId})-[:SUPPORTED_BY]->(t:Team {tenant_id: $tenantId}) RETURN properties(t) AS p',
            { id: parent.id, tenantId: ctx.tenantId }),
        )
        if (!r.records.length) return null
        return mapTeamProps(r.records[0].get('p') as Props)
      })
    },

    dependencies: (parent: { id: string }, _: unknown, ctx: GraphQLContext) =>
      relatedCIs(ciType, allTypes, parent.id, ctx.tenantId, 'outgoing'),

    dependents: (parent: { id: string }, _: unknown, ctx: GraphQLContext) =>
      relatedCIs(ciType, allTypes, parent.id, ctx.tenantId, 'incoming'),
  }
}
