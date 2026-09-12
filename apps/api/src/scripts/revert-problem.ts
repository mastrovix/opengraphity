/**
 * One-off: riporta un problem al passo di analisi (scopo `investigation`) quando la change risolutiva
 * è stata scollegata ma il workflow era rimasto avanti (change_requested /
 * change_in_progress). Usa il vero engine, quindi produce storia e status coerenti.
 *
 * Uso (da host):
 *   pnpm --filter @opengraphity/api revert-problem -- --tenant=<slug> PRB00000001
 */
import { getSession } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import { getStepPurpose } from '../lib/workflowHelpers.js'
import { targetStepByPurpose } from '../lib/workflowTargets.js'
import { ScriptArgError, resolveTenantArg } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'

async function main(): Promise<void> {
  const TENANT = resolveTenantArg()
  // Primo argomento posizionale (non un'opzione `--…`).
  const number = process.argv.slice(2).find(a => !a.startsWith('--'))
  if (!number) throw new ScriptArgError('Uso: revert-problem.ts --tenant=<slug> <PRB...>')

  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {number: $number, tenant_id: $tenant})-[:HAS_WORKFLOW]->(pw:WorkflowInstance)
      RETURN pw.id AS instanceId, pw.current_step AS step
    `, { number, tenant: TENANT }))
    if (res.records.length === 0) throw new Error(`Problem ${number} o workflow non trovato nel tenant ${TENANT}`)
    const instanceId = res.records[0]!.get('instanceId') as string
    const step       = res.records[0]!.get('step') as string
    console.log(`[revert] ${number}: step attuale = ${step}`)

    // Lo SCOPO del passo, non il nome (ondata 4 · A4-2): su un tenant che ha
    // rinominato i passi del problem lo script non faceva più niente e lo
    // diceva come se fosse tutto a posto.
    const purpose = await getStepPurpose(session, TENANT, 'problem', step)
    if (purpose !== 'change_requested' && purpose !== 'change_in_progress') {
      console.log(`[revert] niente da fare (scopo del passo: ${purpose ?? 'non dichiarato'}, non change_requested/change_in_progress)`)
      return
    }

    const toStep = await targetStepByPurpose(session, TENANT, 'problem', ['investigation'],
      'ritorno del problem in analisi (revert-problem)')
    const t = await workflowEngine.transition(
      session,
      { instanceId, toStepName: toStep, triggeredBy: 'system', triggerType: 'automatic', notes: 'Change risolutiva scollegata (fix retroattivo)' },
      { userId: 'system', entityData: {} },
    )
    if (!t.success) throw new Error(`[revert] fallito: ${t.error}`)
    console.log(`[revert] ${number} → ${toStep} ✅`)
  } finally {
    await session.close()
  }
}

runScript('revert-problem', main)
