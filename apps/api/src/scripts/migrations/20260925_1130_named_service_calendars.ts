/**
 * Verifica «Cosa resta cablato», ondata 2: da un calendario di servizio per
 * organizzazione (`Tenant.service_calendar`) a calendari con nome
 * (`ServiceCalendar`), scelti da ogni policy SLA e contratto OLA/UC.
 *
 * Il primo giorno non cambia niente: il calendario di ogni organizzazione
 * diventa il suo primo calendario con nome («Service hours», o «Orario di
 * servizio» se l'organizzazione legge in italiano), e le policy e i contratti
 * che contavano l'orario lavorativo lo scelgono. Poi la proprietà sul Tenant
 * si toglie: due fonti per la stessa cosa sono il difetto che si chiude.
 *
 * Un'organizzazione senza calendario non riceve niente: le sue policy in orario
 * lavorativo (se ne ha) le segnala la diagnostica.
 *
 * Idempotente: una seconda esecuzione non trova più `service_calendar`.
 */
import type { Migration } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'
import { parseServiceCalendar } from '@opengraphity/sla'

const tag = '[20260925_1130_named_service_calendars]'
const FIRST_CALENDAR_NAME: Readonly<Record<string, string>> = { it: 'Orario di servizio', en: 'Service hours' }

export const namedServiceCalendars: Migration = {
  id: '20260925_1130_named_service_calendars',
  description: 'Calendari di servizio con nome: il calendario del Tenant diventa il primo, scelto da policy e contratti in orario lavorativo',
  async up(session) {
    const tenants = await session.run(`
      MATCH (t:Tenant) WHERE t.service_calendar IS NOT NULL
      RETURN t.id AS id, t.service_calendar AS raw, t.default_language AS language
    `)
    for (const r of tenants.records) {
      const tenantId = String(r.get('id'))
      const calendar = parseServiceCalendar(r.get('raw'))
      const name = FIRST_CALENDAR_NAME[String(r.get('language'))] ?? FIRST_CALENDAR_NAME['en']!
      const id = uuidv4()
      const now = new Date().toISOString()
      const out = await session.run(`
        MATCH (t:Tenant {id: $tenantId})
        CREATE (c:ServiceCalendar {id: $id, tenant_id: $tenantId, name: $name, days: $days, start: $start, end: $end, holidays: $holidays, created_at: $now, updated_at: $now})
        WITH t, c
        OPTIONAL MATCH (p:SLAPolicyNode {tenant_id: $tenantId}) WHERE p.business_hours = true AND p.calendar_id IS NULL
        SET p.calendar_id = c.id
        WITH t, c, count(p) AS policies
        OPTIONAL MATCH (o:OLAContract {tenant_id: $tenantId}) WHERE o.business_hours = true AND o.calendar_id IS NULL
        SET o.calendar_id = c.id
        WITH t, policies, count(o) AS contracts
        REMOVE t.service_calendar
        RETURN policies, contracts
      `, { tenantId, id, name, ...calendar, now })
      const row = out.records[0]
      console.log(`${tag} ${tenantId}: calendario «${name}» (${String(row?.get('policies') ?? 0)} policy, ${String(row?.get('contracts') ?? 0)} contratti)`)
    }
  },
}
