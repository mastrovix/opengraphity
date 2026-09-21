/**
 * LA LINGUA sui tenant nati prima del seme (17 set 2026).
 *
 * Scrive l'inglese — `LINGUA_DI_ULTIMA_ISTANZA`, cioè quella che il prodotto
 * già MOSTRA a chi non ha scelto — dove nessuno l'ha dichiarata. A schermo non
 * cambia una parola: cambia che da ripiego diventa una scelta, visibile in
 * Organizzazione, e il tenant non porta più addosso
 * `default_language_not_set`.
 *
 * Chiama la stessa funzione del provisioning, per la ragione di sempre: due
 * copie della regola avrebbero, prima o poi, dichiarato lingue diverse fra un
 * tenant vecchio e uno nuovo.
 *
 * Additiva: chi ha scelto l'italiano non torna all'inglese.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedDefaultLanguage } from '../../lib/tenantLanguage.js'

export const defaultLanguageSeed: Migration = {
  id: '20261005_1060_default_language_seed',
  description: 'Declare the product language (English) on tenants that never chose one',

  async up(session) {
    const tenants = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL AND t.default_language IS NULL
      RETURN t.id AS id
      ORDER BY id
    `)

    const scritti: string[] = []
    for (const rec of tenants.records) {
      const tenantId = rec.get('id') as string
      const esito = await seedDefaultLanguage(session, tenantId)
      if (esito.seeded) scritti.push(`${tenantId} → ${esito.seeded}`)
    }

    console.log(
      `[${defaultLanguageSeed.id}] language declared for ${String(scritti.length)} tenant(s)` +
      (scritti.length > 0 ? ` — ${scritti.join(' · ')}` : '') +
      '. Nothing changes on screen: it was already the language shown to whoever had not chosen.',
    )
  },
}
