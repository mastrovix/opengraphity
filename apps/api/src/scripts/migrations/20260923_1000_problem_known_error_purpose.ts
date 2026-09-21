/**
 * Revisione del 14 set 2026 · IT-1: lo scopo `known_error` ai passi di
 * fabbrica che esistono già.
 *
 * `knownErrors` (la KEDB) filtrava `status: 'known_error'`, cioè il NOME del
 * passo: un cliente che lo rinominava svuotava la KEDB senza un errore. Ora
 * chiede i passi con scopo `known_error`, e questo scopo va scritto sui passi
 * seminati prima che esistesse.
 *
 * Stesse regole di `20260914_1500_workflow_step_purpose`: solo i workflow dei
 * problem, solo il nome di fabbrica, solo dove lo scopo è assente (uno scopo
 * scelto dal cliente non si tocca; idempotente per costruzione).
 */
import type { Migration } from '@opengraphity/neo4j'

export const problemKnownErrorPurpose: Migration = {
  id: '20260923_1000_problem_known_error_purpose',
  description: 'WorkflowStep.purpose = known_error sul passo di fabbrica known_error dei workflow problem (la KEDB non dipende più dal nome del passo)',
  async up(session) {
    const res = await session.run(`
      MATCH (wd:WorkflowDefinition {entity_type: 'problem'})-[:HAS_STEP]->(s:WorkflowStep {name: 'known_error'})
      WHERE s.purpose IS NULL
      SET s.purpose = 'known_error'
      RETURN wd.tenant_id AS tenant, wd.name AS definition
      ORDER BY tenant, definition
    `)
    for (const r of res.records) {
      console.log(`[${problemKnownErrorPurpose.id}] ${String(r.get('tenant'))} / "${String(r.get('definition'))}" / known_error → scopo "known_error"`)
    }
    console.log(`[${problemKnownErrorPurpose.id}] ${String(res.records.length)} passi hanno ricevuto lo scopo`)
  },
}
