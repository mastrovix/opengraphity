/**
 * Revisione del 14 set 2026 · F6: ogni cliente riceve il calendario di servizio
 * che il codice usava per tutti (lunedì–venerdì, 08:00–18:00, nessuna
 * festività), così il primo giorno le scadenze non cambiano. Da qui si modifica
 * dalla pagina Organizzazione. Un calendario già scelto non si tocca.
 * Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { FACTORY_SERVICE_CALENDAR } from '@opengraphity/sla'

export const serviceCalendar: Migration = {
  id: '20260924_1030_service_calendar',
  description: 'Calendario di servizio di fabbrica (lun–ven 08–18) sui tenant che non ne hanno uno',
  async up(session) {
    const r = await session.run(`
      MATCH (t:Tenant) WHERE t.service_calendar IS NULL
      SET t.service_calendar = $calendar, t.updated_at = $now
      RETURN collect(t.id) AS tenants
    `, { calendar: JSON.stringify(FACTORY_SERVICE_CALENDAR), now: new Date().toISOString() })
    const tenants = (r.records[0]?.get('tenants') as string[] | undefined) ?? []
    console.log(`[${serviceCalendar.id}] calendario di fabbrica su: ${tenants.length ? tenants.join(', ') : 'nessuno'}`)
  },
}
