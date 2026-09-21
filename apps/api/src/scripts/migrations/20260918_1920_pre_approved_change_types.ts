/**
 * Personalizzazioni, ondata 8 — i tipi di change pre-approvati diventano dato
 * del cliente.
 *
 * Il codice diceva `if (changeType === 'standard') return` in quattro punti: la
 * pre-approvazione era il NOME. Con i vocabolari rinominabili, chi chiamava
 * `standard` in un altro modo perdeva la pre-approvazione senza saperlo.
 *
 * Questa migrazione scrive sul tenant la lista con il valore che il codice
 * usava — `['standard']` — così il comportamento non cambia, ma da qui in poi
 * è una configurazione che si vede e si modifica. Idempotente: non tocca un
 * tenant che ha già la sua lista (anche vuota: «nessun tipo pre-approvato» è
 * una scelta legittima, e va rispettata).
 */
import type { Migration } from '@opengraphity/neo4j'
import { DEFAULT_PRE_APPROVED_CHANGE_TYPES } from '../../lib/changePolicy.js'

export const preApprovedChangeTypesSeed: Migration = {
  id: '20260918_1920_pre_approved_change_types',
  description: 'Tenant.pre_approved_change_types: la pre-approvazione delle change diventa dato del cliente, seminata con il letterale che il codice usava (standard)',
  async up(session) {
    const res = await session.run(
      `MATCH (t:Tenant)
       WHERE t.pre_approved_change_types IS NULL
       SET t.pre_approved_change_types = $types
       RETURN t.id AS tenantId ORDER BY tenantId`,
      { types: [...DEFAULT_PRE_APPROVED_CHANGE_TYPES] },
    )
    for (const r of res.records) {
      console.log(`[${preApprovedChangeTypesSeed.id}] ${String(r.get('tenantId'))}: pre_approved_change_types = ${DEFAULT_PRE_APPROVED_CHANGE_TYPES.join(', ')}`)
    }
    const already = await session.run(
      `MATCH (t:Tenant) WHERE t.pre_approved_change_types IS NOT NULL RETURN count(t) AS n`,
    )
    console.log(
      `[${preApprovedChangeTypesSeed.id}] ${String(res.records.length)} tenant seminati; ` +
      `${String(already.records[0]?.get('n') ?? 0)} hanno ora la lista (gli altri l'avevano già e non sono stati toccati).`,
    )
  },
}
