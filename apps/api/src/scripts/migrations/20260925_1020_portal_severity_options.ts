/**
 * Verifica «Cosa resta cablato», ondata 1: le severità del portale diventano
 * una scelta dell'amministratore (`Tenant.portal_severity_options`).
 *
 * Il primo giorno non cambia niente: ogni organizzazione riceve le tre scelte
 * che il portale offriva scritte nel codice (`low / medium / high`) con le
 * parole che mostrava («Low / Medium / High», «Bassa / Media / Alta») — ma solo
 * i valori che il SUO vocabolario `severity` ha ancora. Un valore mancante non
 * si inventa: si salta e lo si dice. Se non ne resta nessuno la proprietà resta
 * assente, e la diagnostica lo segnala.
 *
 * Idempotente: non tocca chi ha già una scelta.
 */
import type { Migration } from '@opengraphity/neo4j'
import { SYSTEM_TENANT } from '../../lib/enumScope.js'

const tag = '[20260925_1020_portal_severity_options]'

/** Le scelte e le parole che il portale aveva nel codice (TicketNewPage + i18n del portale). */
const PORTAL_FACTORY_OPTIONS = [
  { value: 'low',    labels: { en: 'Low',    it: 'Bassa' } },
  { value: 'medium', labels: { en: 'Medium', it: 'Media' } },
  { value: 'high',   labels: { en: 'High',   it: 'Alta' } },
] as const

export const portalSeverityOptionsSeed: Migration = {
  id: '20260925_1020_portal_severity_options',
  description: 'Tenant.portal_severity_options: le severità offerte nel portale, seminate con low/medium/high',
  async up(session) {
    const rows = await session.run(`
      MATCH (t:Tenant) WHERE t.portal_severity_options IS NULL AND t.id <> $systemTenant
      OPTIONAL MATCH (own:EnumTypeDefinition {name: 'severity', tenant_id: t.id})
      OPTIONAL MATCH (shipped:EnumTypeDefinition {name: 'severity', tenant_id: $systemTenant})
      RETURN t.id AS tenant, coalesce(own.values, shipped.values) AS values
    `, { systemTenant: SYSTEM_TENANT })
    for (const row of rows.records) {
      const tenant = String(row.get('tenant'))
      const values = (row.get('values') ?? []) as string[]
      const options = PORTAL_FACTORY_OPTIONS.filter((o) => values.includes(o.value))
      const skipped = PORTAL_FACTORY_OPTIONS.filter((o) => !values.includes(o.value)).map((o) => o.value)
      if (skipped.length > 0) {
        console.log(`${tag} ${tenant}: il vocabolario severity non ha ${skipped.join(', ')} — non offerti nel portale`)
      }
      if (options.length === 0) {
        console.log(`${tag} ${tenant}: nessuna severità di fabbrica nel vocabolario — scelta da fare in Impostazioni → Organizzazione`)
        continue
      }
      await session.run(`
        MATCH (t:Tenant {id: $tenant}) WHERE t.portal_severity_options IS NULL
        SET t.portal_severity_options = $options, t.updated_at = $now
      `, { tenant, options: JSON.stringify(options), now: new Date().toISOString() })
      console.log(`${tag} ${tenant}: portale con ${options.map((o) => o.value).join(', ')}`)
    }
  },
}
