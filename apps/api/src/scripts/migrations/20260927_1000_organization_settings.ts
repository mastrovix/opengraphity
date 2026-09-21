/**
 * Verifica «Cosa resta cablato», ondata 6: numerazione dei ticket, allegati, AI
 * e marchio diventano impostazioni dell'organizzazione. Qui si scrivono espliciti
 * i valori di prima, così il primo giorno non cambia niente:
 *  - numerazione INC/PRB/CHG/REQ con 8 cifre;
 *  - allegati fino a 10 MB con i tipi di prima;
 *  - AI accesa per ogni funzione (dove la piattaforma ha un modello funzionava
 *    già), raggruppamento 0,72 e 3;
 *  - marchio OpenGrafo, senza indirizzo di risposta.
 * Una scelta già fatta non si tocca. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { FACTORY_TENANT_BRAND } from '@opengraphity/types'
import { FACTORY_TICKET_NUMBERING } from '../../lib/ticketNumbering.js'
import { FACTORY_ATTACHMENT_POLICY } from '../../lib/attachmentPolicy.js'
import { FACTORY_AI_SETTINGS } from '../../lib/aiSettings.js'

const SEEDS: ReadonlyArray<{ property: string; value: unknown }> = [
  { property: 'ticket_numbering',  value: FACTORY_TICKET_NUMBERING },
  { property: 'attachment_policy', value: FACTORY_ATTACHMENT_POLICY },
  { property: 'ai_settings',       value: FACTORY_AI_SETTINGS },
  { property: 'brand',             value: FACTORY_TENANT_BRAND },
]

export const organizationSettingsSeed: Migration = {
  id: '20260927_1000_organization_settings',
  description: 'Tenant.ticket_numbering, attachment_policy, ai_settings e brand seminati con il comportamento di prima',
  async up(session) {
    for (const seed of SEEDS) {
      const r = await session.run(`
        MATCH (t:Tenant) WHERE t.id <> 'system' AND t.${seed.property} IS NULL
        SET t.${seed.property} = $json, t.updated_at = $now
        RETURN collect(t.id) AS tenants
      `, { json: JSON.stringify(seed.value), now: new Date().toISOString() })
      const tenants = (r.records[0]?.get('tenants') as string[] | undefined) ?? []
      console.log(`[${organizationSettingsSeed.id}] ${seed.property}: ${tenants.length ? tenants.join(', ') : 'nessuno'}`)
    }
  },
}
