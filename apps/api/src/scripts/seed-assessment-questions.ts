/**
 * Semina le domande di assessment di un tenant.
 *
 * La logica sta in `lib/seedAssessmentQuestions.ts`, condivisa con
 * `provisionTenantData`: un tenant nasce in UN modo solo, e questo seme era
 * l'unico che stava fuori dal provisioning — con l'effetto che un tenant nuovo
 * non aveva domande e nessuna change poteva superare l'analisi.
 *
 * Uso: pnpm --filter @opengraphity/api exec tsx src/scripts/seed-assessment-questions.ts --tenant <slug>
 */
import { getSession, closeDriver } from '@opengraphity/neo4j'
import { resolveTenantArg } from './lib/scriptArgs.js'
import { seedAssessmentQuestions } from '../lib/seedAssessmentQuestions.js'

async function main() {
  const tenantId = resolveTenantArg()
  const session = getSession(undefined, 'WRITE')
  try {
    const { created, existing } = await seedAssessmentQuestions(session, tenantId)
    console.log(`[seed] ${created} new + ${existing} existing assessment questions for tenant ${tenantId}. Relations refreshed.`)
  } finally {
    await session.close()
    await closeDriver()
  }
}

main().catch((err) => {
  console.error('[seed-assessment-questions] error:', err)
  process.exit(1)
})
