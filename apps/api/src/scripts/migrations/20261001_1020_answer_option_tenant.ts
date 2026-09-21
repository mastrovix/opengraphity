/**
 * Revisione totale del 16 set 2026 · H-19: le `AnswerOption` seminate non
 * portavano `tenant_id` (la domanda sì), quindi non appartenevano a nessuna
 * organizzazione: backup, restore e ogni lettura per tenant non le vedevano.
 * Prende il tenant dalla domanda a cui sono appese. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const answerOptionTenant: Migration = {
  id:          '20261001_1020_answer_option_tenant',
  description: 'tenant_id sulle opzioni di risposta che non lo avevano (dal tenant della domanda)',

  async up(session) {
    const res = await session.run(`
      MATCH (q:AssessmentQuestion)-[:HAS_OPTION]->(o:AnswerOption)
      WHERE o.tenant_id IS NULL AND q.tenant_id IS NOT NULL
      SET o.tenant_id = q.tenant_id
      RETURN count(o) AS n`)
    const orphans = await session.run('MATCH (o:AnswerOption) WHERE o.tenant_id IS NULL RETURN count(o) AS n')
    console.log(`[${answerOptionTenant.id}] opzioni riassegnate: ${String(res.records[0]?.get('n'))}, senza domanda (da guardare a mano): ${String(orphans.records[0]?.get('n'))}`)
  },
}
