/**
 * Verifica «Cosa resta cablato», ondata 1: il motivo delle esclusioni fatte a
 * mano dalla mappa del servizio era la frase italiana «escluso a mano», scritta
 * nei dati. Diventa il codice `manual` (`SERVICE_EXCLUSION_REASON_MANUAL`).
 *
 * Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { SERVICE_EXCLUSION_REASON_MANUAL } from '../../lib/serviceVocabularies.js'

export const serviceExclusionReasonCode: Migration = {
  id: '20260925_1010_service_exclusion_reason_code',
  description: 'EXCLUDES.reason: «escluso a mano» diventa il codice manual',
  async up(session) {
    const r = await session.run(`
      MATCH ()-[e:EXCLUDES]->() WHERE e.reason = 'escluso a mano'
      SET e.reason = $code
      RETURN count(e) AS n
    `, { code: SERVICE_EXCLUSION_REASON_MANUAL })
    console.log(`[${serviceExclusionReasonCode.id}] ${String(r.records[0]?.get('n') ?? 0)} esclusioni aggiornate`)
  },
}
