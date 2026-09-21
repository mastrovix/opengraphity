/**
 * Revisione totale del 16 set 2026 · C-34: il nome di un calendario di
 * servizio diventa unico per davvero, con un vincolo su `(tenant_id,
 * name_key)`. L'unicità era solo una lettura fuori dalla transazione: due
 * admin che salvavano «Ufficio» nello stesso momento passavano entrambi.
 *
 * Qui si scrive `name_key` sui calendari che già esistono. Se due omonimi sono
 * già nel grafo il vincolo non si può creare: la migrazione lo DICE con i nomi,
 * invece di rinominarli da sola — quale dei due tenere è una scelta del
 * cliente. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const serviceCalendarNameKey: Migration = {
  id:          '20261002_1040_service_calendar_name_key',
  description: 'name_key sui calendari di servizio (C-34: nome unico per tenant)',

  async up(session) {
    const written = await session.run(`
      MATCH (c:ServiceCalendar)
      WHERE c.name_key IS NULL OR c.name_key <> toLower(c.name)
      SET c.name_key = toLower(c.name)
      RETURN count(c) AS n`)
    console.log(`[${serviceCalendarNameKey.id}] name_key scritta su ${String(written.records[0]?.get('n') ?? 0)} calendari`)

    const dup = await session.run(`
      MATCH (c:ServiceCalendar)
      WITH c.tenant_id AS tenant, c.name_key AS key, collect(c.name) AS names, count(*) AS n
      WHERE n > 1
      RETURN tenant, key, names, n`)
    for (const r of dup.records) {
      console.log(
        `[${serviceCalendarNameKey.id}] ATTENZIONE ${String(r.get('tenant'))}: ${String(r.get('n'))} calendari con lo stesso nome `
        + `«${String(r.get('key'))}» (${(r.get('names') as string[]).join(', ')}). Il vincolo di unicità non si potrà creare `
        + 'finché non ne resta uno: rinominali o cancellane uno dalla pagina Organizzazione.',
      )
    }
  },
}
