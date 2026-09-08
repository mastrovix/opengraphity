/**
 * Runner uniforme per gli script operativi.
 *
 *  - esegue `main`, poi chiude il driver Neo4j (così il processo termina da
 *    solo: niente `process.exit(0)` nei `finally`, che mascherava gli errori);
 *  - un ScriptArgError (argomento mancante/invalido) stampa SOLO il messaggio;
 *  - ogni altro errore viene stampato per intero (stack compreso);
 *  - exit code 1 su qualunque errore, incluso un errore in chiusura del driver.
 */

import { closeDriver } from '@opengraphity/neo4j'
import { ScriptArgError } from './scriptArgs.js'

export function runScript(name: string, main: () => Promise<void>): void {
  main()
    .then(
      () => undefined,
      (err: unknown) => {
        if (err instanceof ScriptArgError) {
          console.error(`\n✖ ${name}: ${err.message}`)
        } else {
          console.error(`\n✖ ${name} fallito:`, err)
        }
        process.exitCode = 1
      },
    )
    .then(() => closeDriver())
    .catch((err: unknown) => {
      console.error(`\n✖ ${name}: errore in chiusura del driver Neo4j:`, err)
      process.exitCode = 1
    })
}
