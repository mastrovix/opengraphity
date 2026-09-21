/**
 * LE SEVERITÀ DEL PORTALE sui tenant che esistono già (17 set 2026).
 *
 * Il seme è nel provisioning — l'unico modo in cui nasce un tenant — ma i
 * tenant nati prima restano scoperti, e sono proprio quelli in cui il difetto
 * si vede: `demo-opengrafo`, `prova-cons` e `prova-due` avevano addosso un
 * rilievo di gravità ERRORE (`portal_severities_not_set`) dal giorno della
 * creazione, e il loro portale non poteva aprire un ticket.
 *
 * Chiama la STESSA funzione del provisioning (`seedPortalSeverityOptions`):
 * una seconda copia della regola qui avrebbe dichiarato severità diverse da
 * quelle che dichiara un tenant nuovo, e nessun test l'avrebbe visto.
 *
 * Additiva: scrive solo dove la proprietà è assente. Chi ha già scelto le sue
 * severità — anche una sola — non viene toccato.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedPortalSeverityOptions } from '../../lib/portalSeverityOptions.js'

export const portalSeveritiesSeed: Migration = {
  id: '20261005_1050_portal_severities_seed',
  description: 'Declare the portal severities (all values of the severity dictionary) on tenants that never chose them',

  async up(session) {
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL AND t.portal_severity_options IS NULL
      RETURN t.id AS id
      ORDER BY id
    `)

    const scritti: string[] = []
    const saltati: string[] = []
    for (const rec of tenants.records) {
      const tenantId = rec.get('id') as string
      const esito = await seedPortalSeverityOptions(session, tenantId)
      if (esito.seeded) scritti.push(`${tenantId} (${esito.seeded.join(', ')})`)
      // Un tenant senza vocabolario `severity` NON prende una lista vuota: si
      // annota col motivo, e il suo portale continua a dirlo a voce alta.
      else saltati.push(`${tenantId}: ${esito.reason ?? 'unknown reason'}`)
    }

    console.log(
      `[${portalSeveritiesSeed.id}] portal severities declared for ${String(scritti.length)} tenant(s)` +
      (scritti.length > 0 ? ` — ${scritti.join(' · ')}` : '') +
      (saltati.length > 0 ? `. Left untouched: ${saltati.join(' · ')}` : ''),
    )
  },
}
