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
    'src/lib/**':        { lines: 80, statements: 77, functions: 78, branches: 69 },  // 82.1/79.8/80.7/71.1
    'src/graphql/**':    { lines: 65, statements: 63, functions: 57, branches: 56 },  // 67.6/65.4/59.6/58.2
    'src/services/**':   { lines: 93, statements: 90, functions: 90, branches: 84 },  // 95.4/92.9/92.4/86.9
    'src/rest/**':       { lines: 77, statements: 76, functions: 74, branches: 67 },  // 79.2/78.4/76.6/69.9
    'src/discovery/**':  { lines: 94, statements: 91, functions: 90, branches: 82 },  // 96.8/93.6/92.6/84.5
    'src/jobs/**':       { lines: 77, statements: 76, functions: 71, branches: 64 },  // 79.0/78.4/73.5/66.7
    'src/middleware/**': { lines: 84, statements: 82, functions: 79, branches: 67 },  // 86.1/85.0/81.8/69.7
    'src/anomaly/**':    { lines: 65, statements: 63, functions: 59, branches: 63 },  // 67.5/65.1/61.3/65.5
    'src/auth/**':       { lines: 93, statements: 92, functions: 86, branches: 83 },  // 95.6/94.1/88.9/85.0
    'src/consumers/**':  { lines: 88, statements: 82, functions: 90, branches: 72 },  // 90.4/84.8/92.3/74.1
    'src/workers/**':    { lines: 82, statements: 81, functions: 98, branches: 64 },  // 84.0/83.0/100.0/66.7
    'src/workflow/**':   { lines: 83, statements: 80, functions: 78, branches: 68 },  // 85.3/82.9/80.0/70.6
    'src/*.ts':          { lines: 4, statements: 3, functions: 0, branches: 0 },      // 6.1/5.3/1.6/1.3
  },

  // ── Gli altri: un pavimento solo, che è quello che avevano (nessuno) ──────
  'apps/web':                  { lines: 69, statements: 66, functions: 52, branches: 61 },  // 71.43/68.29/54.73/63.86
  'apps/portal':               { lines: 54, statements: 50, functions: 42, branches: 50 },  // 56.9/52.89/44.75/52.84
  'apps/console':              { lines: 2, statements: 3, functions: 0, branches: 9 },  // 4.39/5.14/1.08/11.26
  'packages/workflow':         { lines: 98, statements: 97, functions: 96, branches: 97 },  // 100/99.82/98.79/99.34
  'packages/neo4j':            { lines: 95, statements: 93, functions: 94, branches: 85 },  // 97.5/95.42/96.61/87.31
  'packages/sla':              { lines: 96, statements: 93, functions: 96, branches: 88 },  // 98.37/95.36/98.9/90.36
  'packages/notifications':    { lines: 95, statements: 93, functions: 92, branches: 85 },  // 97.49/95.94/94.73/87.55
  'packages/events':           { lines: 97, statements: 96, functions: 95, branches: 93 },  // 99.52/98.03/97.77/95.6
  'packages/scripting':        { lines: 96, statements: 96, functions: 98, branches: 93 },  // 98.31/98.34/100/95.45
  'packages/discovery':        { lines: 95, statements: 95, functions: 98, branches: 92 },  // 97.02/97.39/100/94.56
  'packages/types':            { lines: 94, statements: 94, functions: 94, branches: 93 },  // 96.38/96.73/96/95.5
  'packages/schema-generator': { lines: 97, statements: 93, functions: 94, branches: 83 },  // 99.01/95.43/96.72/85.86
  'packages/web-core':         { lines: 40, statements: 39, functions: 33, branches: 23 },  // 42.32/41.46/35.0/25.23
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
