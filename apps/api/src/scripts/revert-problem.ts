/**
 * One-off: riporta un problem a "under_investigation" quando la change risolutiva
 * è stata scollegata ma il workflow era rimasto avanti (change_requested /
 * change_in_progress). Usa il vero engine, quindi produce storia e status coerenti.
 *
 * Uso (da host):
 *   pnpm --filter @opengraphity/api exec tsx src/scripts/revert-problem.ts PRB00000001
 */
import { getSession } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'

const TENANT = 'c-one'

async function main() {
  const number = process.argv[2]
  if (!number) { console.error('Uso: revert-problem.ts <PRB...>'); process.exit(1) }

  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {number: $number, tenant_id: $tenant})-[:HAS_WORKFLOW]->(pw:WorkflowInstance)
      RETURN pw.id AS instanceId, pw.current_step AS step
    `, { number, tenant: TENANT }))
    if (res.records.length === 0) { console.error(`Problem ${number} o workflow non trovato`); process.exit(1) }
    const instanceId = res.records[0]!.get('instanceId') as string
    const step       = res.records[0]!.get('step') as string
    console.log(`[revert] ${number}: step attuale = ${step}`)

    if (step !== 'change_requested' && step !== 'change_in_progress') {
      console.log(`[revert] niente da fare (step non è change_requested/change_in_progress)`)
      return
    }

    const t = await workflowEngine.transition(
      session,
      { instanceId, toStepName: 'under_investigation', triggeredBy: 'system', triggerType: 'automatic', notes: 'Change risolutiva scollegata (fix retroattivo)' },
      { userId: 'system', entityData: {} },
    )
    if (t.success) console.log(`[revert] ${number} → under_investigation ✅`)
    else { console.error(`[revert] fallito: ${t.error}`); process.exit(1) }
  } finally {
    await session.close()
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error(e); process.exit(1) })
