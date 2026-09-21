/**
 * DATI DI TEST — i team, da riga di comando.
 *
 *   pnpm --filter @opengraphity/api seed:test-teams -- --tenant demo-opengrafo
 *   pnpm --filter @opengraphity/api seed:test-teams -- --tenant demo-opengrafo --quanti 20
 *
 * Il contenuto sta in `lib/testData/seedTeams.ts`, che è anche quello che
 * chiamerà il pulsante della console: questo file è solo la maniglia da
 * terminale, e non deve contenere nessuna regola.
 *
 * `refuseInProduction`: i dati di esercizio non si seminano in produzione per
 * sbaglio, e uno script che può farlo va fermato dove si decide, non dove si
 * rimedia.
 */
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'
import { refuseInProduction, resolveTenantArg, readOptionValue } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { seedTestTeams } from '../lib/testData/seedTeams.js'

runScript('seed-test-teams', async () => {
  refuseInProduction('seed-test-teams')
  const tenantId = resolveTenantArg()
  const quantiRaw = readOptionValue('--quanti')
  const quanti = quantiRaw === undefined ? undefined : Number(quantiRaw)
  if (quanti !== undefined && (!Number.isInteger(quanti) || quanti < 1)) {
    throw new Error(`--quanti must be a positive integer (got "${String(quantiRaw)}")`)
  }

  const session = getSession(undefined, neo4j.session.WRITE)
  try {
    const esito = await seedTestTeams(session, tenantId, quanti === undefined ? {} : { quanti })
    console.log(
      `[seed-test-teams] ${tenantId}: ${String(esito.creati)} team creati adesso, ` +
      `${String(esito.totale)} in tutto col prefisso dei dati di test (tipo "${esito.tipo}", tutti internal)`,
    )
  } finally {
    await session.close()
  }
})
