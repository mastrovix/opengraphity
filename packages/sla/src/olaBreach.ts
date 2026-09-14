import { getSession, toNumber } from '@opengraphity/neo4j'
import { calendarFor, type ServiceCalendar } from './calendar.js'

export interface OLAContractLite {
  id: string
  name: string
  type: string            // ola | uc
  resolve_minutes: number
  business_hours: boolean
  /** Il calendario con cui conta l'orario di servizio; null quando conta 24×7. */
  calendar_id: string | null
}

/** Un contratto con il suo calendario già letto: quello che serve a calcolare la scadenza. */
export interface OLAContractWithCalendar extends OLAContractLite {
  calendar: ServiceCalendar | null
}

/** Legge il calendario di ogni contratto (ondata 2: ciascuno il suo). Un contratto in orario di servizio senza calendario lancia. */
export async function withContractCalendars(tenantId: string, contracts: readonly OLAContractLite[]): Promise<OLAContractWithCalendar[]> {
  return Promise.all(contracts.map(async (c) => ({
    ...c,
    calendar: await calendarFor(tenantId, { name: c.name, businessHours: c.business_hours, calendarId: c.calendar_id }),
  })))
}

// Resolution timestamp per entity type — an entity with this field set is
// considered concluded (the OLA/UC target no longer at risk).
const OLA_RESOLVED_FIELD: Record<string, { label: string; field: string }> = {
  incident:        { label: 'Incident',       field: 'resolved_at' },
  problem:         { label: 'Problem',        field: 'resolved_at' },
  service_request: { label: 'ServiceRequest', field: 'completed_at' },
  change:          { label: 'Change',         field: 'completed_at' },
}

/**
 * Active OLA/UC contracts covering an entity type (its own type or 'any').
 * Used to schedule proactive breach checks when the entity is created.
 */
export async function getActiveOLAContractsFor(tenantId: string, entityType: string): Promise<OLAContractLite[]> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) =>
      tx.run(`
        MATCH (o:OLAContract {tenant_id: $tenantId})
        WHERE coalesce(o.enabled, true) = true AND (o.entity_type = $entityType OR o.entity_type = 'any')
        RETURN o.id AS id, o.name AS name, o.type AS type,
               o.resolve_minutes AS resolveMinutes, coalesce(o.business_hours, false) AS businessHours,
               o.calendar_id AS calendarId
      `, { tenantId, entityType }),
    )
    return res.records.map((r) => ({
      id:              r.get('id')   as string,
      name:            r.get('name') as string,
      type:            r.get('type') as string,
      resolve_minutes: toNumber(r.get('resolveMinutes')),
      business_hours:  r.get('businessHours') as boolean,
      calendar_id:     (r.get('calendarId') as string | null) ?? null,
    }))
  } finally {
    await session.close()
  }
}

/**
 * Il fuso del tenant, per i controlli OLA/UC in orario lavorativo. Fail-loud:
 * un tenant senza fuso sposterebbe ogni scadenza in silenzio.
 */
export async function getTenantTimezone(tenantId: string): Promise<string> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) =>
      tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.timezone AS timezone', { tenantId }),
    )
    const tz = res.records[0]?.get('timezone') as unknown
    if (typeof tz !== 'string' || tz === '') {
      throw new Error(`[sla:ola] Tenant ${tenantId} has no timezone configured — OLA/UC checks cannot compute business-hours deadlines`)
    }
    return tz
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
  const session = getSession(undefined, 'READ')
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
