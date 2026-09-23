/**
 * LA COPERTURA DEI TEST, IN UN POSTO SOLO (22 set 2026).
 *
 * ## L'obiettivo, e perché non è già la soglia
 * Il proprietario ha deciso: **il 95% ovunque**. Oggi il monorepo sta al
 * 74,7%, cioè novemila istruzioni più in là. Mettere 95 come soglia adesso
 * renderebbe rossa ogni CI di ogni workspace finché non è coperta l'ultima
 * istruzione — e una CI rossa per settimane non protegge niente, insegna solo
 * a ignorarla.
 *
 * Quindi: `OBIETTIVO` è 95 e sta scritto qui. `PAVIMENTI` è dove siamo
 * arrivati. Vitest fa fallire chi SCENDE sotto il pavimento;
 * `scripts/check-tetti-copertura.mjs` fa fallire chi lascia il pavimento più
 * di `GIOCO_MASSIMO` punti sotto il valore vero — cioè chi guadagna terreno e
 * non lo tiene. Il numero può solo salire, e la distanza dall'obiettivo si
 * legge a ogni giro.
 *
 * ## Perché i numeri stanno QUI e non nei dodici `vitest.config`
 * Perché la domanda «a che punto siamo col 95%» si deve poter leggere in un
 * file solo. Sparsi in dodici configurazioni erano già invecchiati una volta:
 * l'API aveva pavimenti dell'8 settembre con trentaquattro punti di gioco, e
 * gli altri undici workspace non ne avevano affatto.
 *
 * ## Le forme ammesse
 * Un workspace può dichiarare un pavimento SOLO (`{ lines, statements, … }`)
 * oppure uno PER AREA (`{ 'src/lib/**': { … } }`), che è quello che serve a
 * `apps/api`: là una media sola nasconderebbe un'area al 100% accanto a una al
 * 50%.
 */

/** Dove si vuole arrivare. Deciso dal proprietario, non negoziabile dal codice. */
export const OBIETTIVO = 95

/**
 * Quanto può stare sotto un pavimento prima di essere da rialzare.
 *
 * Cinque punti: sotto, si inseguirebbe il rumore (una manciata di rami in più
 * o in meno fra due esecuzioni); sopra, il pavimento torna a essere un
 * ricordo. Chi alza un pavimento lo mette due punti sotto il valore del
 * giorno, e ha tre punti di crescita prima di doverci tornare.
 */
export const GIOCO_MASSIMO = 5

/**
 * Quello che NON si conta, ovunque: i test, le build, gli script di servizio e
 * i file generati. Un file generato al 30% non dice niente su nessuno.
 */
export const ESCLUSI_SEMPRE = [
  '**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.d.ts',
  '**/node_modules/**', '**/dist/**', '**/e2e/**',
  '**/test/**', '**/*.config.{ts,js,mjs}',
]

/**
 * I pavimenti di oggi, due punti sotto il valore misurato il 22 set 2026.
 * Il numero in coda a ogni riga è quel valore: serve a leggere il gioco senza
 * rifare la misura.
 */
export const PAVIMENTI = {
  // ── L'API: per AREA, perché una media sola nasconderebbe il buco ──────────
  'apps/api': {
    'src/lib/**':        { lines: 97, statements: 97, functions: 97, branches: 93 },  // 99.6/99.3/99.4/95.8
    'src/graphql/**':    { lines: 97, statements: 97, functions: 97, branches: 93 },  // 99.9/99.7/99.7/95.8
    'src/services/**':   { lines: 97, statements: 97, functions: 97, branches: 93 },  // 99.8/99.3/99.6/95.8
    'src/rest/**':       { lines: 97, statements: 96, functions: 96, branches: 89 },  // 99.3/98.9/98.5/91.3
    'src/discovery/**':  { lines: 97, statements: 97, functions: 97, branches: 91 },  // 99.9/99.6/99.5/93.1
    'src/jobs/**':       { lines: 97, statements: 97, functions: 96, branches: 93 },  // 99.6/99.6/98.5/95.8
    'src/middleware/**': { lines: 98, statements: 97, functions: 95, branches: 90 },  // 100.0/99.5/97.7/92.4
    'src/anomaly/**':    { lines: 98, statements: 97, functions: 98, branches: 95 },  // 100.0/99.7/100.0/97.7
    'src/auth/**':       { lines: 98, statements: 98, functions: 98, branches: 96 },  // 100.0/100.0/100.0/98.3
    'src/consumers/**':  { lines: 98, statements: 98, functions: 98, branches: 90 },  // 100.0/100.0/100.0/92.9
    'src/workers/**':    { lines: 98, statements: 98, functions: 98, branches: 98 },  // 100.0/100.0/100.0/100.0
    'src/workflow/**':   { lines: 95, statements: 92, functions: 98, branches: 91 },  // 97.1/94.3/100.0/93.1 (step hook tests, 23 Sep 2026)
    'src/*.ts':          { lines: 97, statements: 96, functions: 96, branches: 92 },  // 99.2/98.2/98.4/94.7
  },

  // ── Gli altri: un pavimento solo, che è quello che avevano (nessuno) ──────
  // apps/web: the 22 Sep figures (99.49/98.58/98.96/94.67) were false — a test loaded the sources as text
  // modules and 101 untested files counted as empty (see src/__tests__/coverageHonest.test.ts). True measure on
  // 23 Sep: 65.8% statements; after the tests of that day, the numbers below, over every file.
  'apps/web':                  { lines: 97, statements: 97, functions: 97, branches: 94 },  // 99.93/99.3/99.8/96.69
  'apps/portal':               { lines: 95, statements: 93, functions: 91, branches: 85 },  // 97.37/95.74/93.54/87.52
  'apps/console':              { lines: 94, statements: 94, functions: 89, branches: 92 },  // 96.15/96.26/91.3/94.36
  'packages/workflow':         { lines: 98, statements: 97, functions: 96, branches: 97 },  // 100/99.82/98.79/99.34
  'packages/neo4j':            { lines: 95, statements: 93, functions: 94, branches: 85 },  // 97.5/95.42/96.61/87.31
  'packages/sla':              { lines: 96, statements: 93, functions: 96, branches: 88 },  // 98.37/95.36/98.9/90.36
  'packages/notifications':    { lines: 95, statements: 93, functions: 92, branches: 85 },  // 97.49/95.94/94.73/87.55
  'packages/events':           { lines: 97, statements: 96, functions: 95, branches: 93 },  // 99.52/98.03/97.77/95.6
  'packages/scripting':        { lines: 96, statements: 96, functions: 98, branches: 93 },  // 98.31/98.34/100/95.45
  'packages/discovery':        { lines: 95, statements: 95, functions: 98, branches: 92 },  // 97.02/97.39/100/94.56
  'packages/types':            { lines: 94, statements: 94, functions: 94, branches: 93 },  // 96.38/96.73/96/95.5
  'packages/schema-generator': { lines: 97, statements: 93, functions: 94, branches: 83 },  // 99.01/95.43/96.72/85.86
  'packages/web-core':         { lines: 95, statements: 93, functions: 94, branches: 87 },  // 97.24/95.53/96.11/89.13
}

/**
 * Il blocco `coverage` di un `vitest.config`: uguale per tutti, col pavimento
 * del workspace preso da qui.
 *
 * `include` conta OGNI file di sorgente, non solo quelli che un test importa:
 * un modulo nuovo e senza test deve abbassare il numero, non restare
 * invisibile.
 */
export function copertura(workspace, opzioni = {}) {
  const pavimento = PAVIMENTI[workspace]
  if (!pavimento) {
    throw new Error(
      `copertura("${workspace}"): nessun pavimento dichiarato in copertura.mjs. `
      + `Misura il workspace, scrivi il pavimento due punti sotto, e rileggi l'obiettivo (${String(OBIETTIVO)}%).`,
    )
  }
  return {
    provider: 'v8',
    reporter: ['text-summary', 'json-summary'],
    include: opzioni.include ?? ['src/**/*.{ts,tsx}'],
    exclude: [...ESCLUSI_SEMPRE, ...(opzioni.exclude ?? [])],
    thresholds: pavimento,
  }
}
