/**
 * IL CALENDARIO DI SERVIZIO DEL CLIENTE — la porta dall'interfaccia (revisione
 * del 14 set 2026 · F6). Il calcolo sta in packages/sla/src/calendar.ts; qui la
 * lettura, la scrittura validata e il conteggio di chi lo usa, per la
 * diagnostica.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { ServiceCalendarError, parseServiceCalendar, type ServiceCalendar } from '@opengraphity/sla'
import { NotFoundError, ValidationError } from './errors.js'

export async function tenantServiceCalendar(tenantId: string): Promise<ServiceCalendar | null> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ calendar: unknown }>(session,
      'MATCH (t:Tenant {id: $tenantId}) RETURN t.service_calendar AS calendar', { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    if (row.calendar == null || row.calendar === '') return null
    return parseServiceCalendar(row.calendar)
  } finally {
    await session.close()
  }
}

export async function setTenantServiceCalendar(tenantId: string, input: unknown): Promise<ServiceCalendar> {
  let calendar: ServiceCalendar
  try {
    calendar = parseServiceCalendar(input)
  } catch (err) {
    if (err instanceof ServiceCalendarError) {
      throw new ValidationError(err.message, { key: `errors.tenant.serviceCalendar.${err.problem}`, params: err.params })
    }
    throw err
  }
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.service_calendar = $calendar, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, calendar: JSON.stringify(calendar), now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  return calendar
}

/** Quante policy SLA e contratti OLA attivi contano in orario lavorativo: chi ha bisogno del calendario. */
export async function businessHoursUsers(tenantId: string): Promise<number> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ n: unknown }>(session, `
      CALL {
        MATCH (p:SLAPolicyNode {tenant_id: $tenantId}) WHERE p.business_hours = true AND coalesce(p.enabled, true) = true RETURN count(p) AS c
        UNION ALL
        MATCH (o:OLAContract {tenant_id: $tenantId}) WHERE o.business_hours = true AND coalesce(o.enabled, true) = true RETURN count(o) AS c
      }
      RETURN sum(c) AS n
    `, { tenantId })
    return Number(row?.n ?? 0)
  } finally {
    await session.close()
  }
}
