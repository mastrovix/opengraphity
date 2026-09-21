/**
 * Verifica «Cosa resta cablato», ondata 2: l'obiettivo di conformità e la soglia
 * d'attenzione diventano campi di ogni policy SLA e contratto OLA/UC.
 *
 * Il primo giorno non cambia niente: ricevono 95 e 80, i due numeri con cui il
 * report colorava tutto (verde da 95%, giallo da 80%). Idempotente: non tocca
 * chi ha già un obiettivo.
 */
import type { Migration } from '@opengraphity/neo4j'

const tag = '[20260925_1140_compliance_objectives]'
/** Le soglie di `pctColor` in apps/web/src/pages/reports/reportWindow.tsx fino all'ondata 1. */
const PREVIOUS_TARGET = 95
const PREVIOUS_WARNING = 80

export const complianceObjectives: Migration = {
  id: '20260925_1140_compliance_objectives',
  description: 'compliance_target 95 e compliance_warning 80 su policy SLA e contratti OLA/UC che non li hanno',
  async up(session) {
    for (const label of ['SLAPolicyNode', 'OLAContract']) {
      const r = await session.run(`
        MATCH (n:${label}) WHERE n.compliance_target IS NULL OR n.compliance_warning IS NULL
        SET n.compliance_target = coalesce(n.compliance_target, $target), n.compliance_warning = coalesce(n.compliance_warning, $warning)
        RETURN count(n) AS n
      `, { target: PREVIOUS_TARGET, warning: PREVIOUS_WARNING })
      console.log(`${tag} ${label}: ${String(r.records[0]?.get('n') ?? 0)} aggiornati`)
    }
  },
}
