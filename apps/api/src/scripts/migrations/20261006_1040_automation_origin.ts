/**
 * L'ORIGINE DELLE AUTOMAZIONI CHE ESISTONO GIÀ (20 set 2026).
 *
 * Tutto quello che c'era prima di questo campo l'ha scritto una persona: non
 * esisteva nessun altro modo di creare un'automazione. Quindi `manual`, e
 * non è un ripiego — è un fatto.
 *
 * La lettura ha comunque il suo default (`origineDi` in
 * `lib/automationOrigin.ts` tratta l'assenza come `manual`), quindi senza
 * questa migrazione il prodotto funzionerebbe lo stesso. Quello che si evita
 * è un buco nei dati: un nodo senza `origin` è una domanda senza risposta per
 * chi lo leggerà fra sei mesi («era di una proposta? il campo non c'era?»), e
 * quella domanda tocca sempre a qualcuno che non c'era.
 *
 * Idempotente: alla seconda esecuzione nessun nodo è senza.
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_AUTOMATION_ORIGIN } from '@opengraphity/types'

export const automationOrigin: Migration = {
  id: '20261006_1040_automation_origin',
  description: 'Mark every existing AutoTrigger as written by a person (origin: manual)',

  async up(session) {
    const esito = await session.run(`
      MATCH (t:AutoTrigger) WHERE t.origin IS NULL
      SET t.origin = $origin
      RETURN count(t) AS n
    `, { origin: DEFAULT_AUTOMATION_ORIGIN })
    const n = esito.records[0]?.get('n') as { toNumber?: () => number } | number | undefined
    console.log(`[20261006_1040_automation_origin] ${String(typeof n === 'number' ? n : (n?.toNumber?.() ?? 0))} automations marked as "${DEFAULT_AUTOMATION_ORIGIN}"`)
  },
}
