import { getDriver } from '@opengraphity/neo4j'

export interface OLAContractLite {
  id: string
  name: string
  type: string            // ola | uc
  resolve_minutes: number
  business_hours: boolean
}

// Resolution timestamp per entity type — an entity with this field set is
// considered concluded (the OLA/UC target no longer at risk).
const OLA_RESOLVED_FIELD: Record<string, { label: string; field: string }> = {
  incident:        { label: 'Incident',       field: 'resolved_at' },
  problem:         { label: 'Problem',        field: 'resolved_at' },
  service_request: { label: 'ServiceRequest', field: 'completed_at' },
}

function toInt(v: unknown): number {
  if (v == null) return 0
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function') return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}

/**
 * Active OLA/UC contracts covering an entity type (its own type or 'any').
 * Used to schedule proactive breach checks when the entity is created.
 */
export async function getActiveOLAContractsFor(tenantId: string, entityType: string): Promise<OLAContractLite[]> {
  const session = getDriver().session({ defaultAccessMode: 'READ' as const })
  try {
    const res = await session.executeRead((tx) =>
      tx.run(`
        MATCH (o:OLAContract {tenant_id: $tenantId})
        WHERE coalesce(o.enabled, true) = true AND (o.entity_type = $entityType OR o.entity_type = 'any')
        RETURN o.id AS id, o.name AS name, o.type AS type,
               o.resolve_minutes AS resolveMinutes, coalesce(o.business_hours, false) AS businessHours
      `, { tenantId, entityType }),
    )
    return res.records.map((r) => ({
      id:              r.get('id')   as string,
      name:            r.get('name') as string,
      type:            r.get('type') as string,
      resolve_minutes: toInt(r.get('resolveMinutes')),
      business_hours:  r.get('businessHours') as boolean,
    }))
  } finally {
    await session.close()
  }
}

/**
 * True if the entity has already reached its resolution/completion timestamp —
 * i.e. an OLA breach check firing now would be a false alarm. Entity types
 * without a known resolution field are treated as still-open.
 */
export async function isEntityResolved(tenantId: string, entityType: string, entityId: string): Promise<boolean> {
  const mapping = OLA_RESOLVED_FIELD[entityType]
  if (!mapping) return false
  const session = getDriver().session({ defaultAccessMode: 'READ' as const })
  try {
    const res = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:${mapping.label} {id: $entityId, tenant_id: $tenantId})
        RETURN e.${mapping.field} AS resolvedAt
      `, { entityId, tenantId }),
    )
    if (!res.records.length) return true   // entity gone → nothing to alert on
    return res.records[0].get('resolvedAt') != null
  } finally {
    await session.close()
  }
}
