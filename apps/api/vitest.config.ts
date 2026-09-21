import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // vitest 4 no longer excludes `**/dist/**` by default: without this the
    // compiled copies of the tests under dist/ (tsc output of an older
    // tsconfig) would run too, against stale imports.
    exclude: [...configDefaults.exclude, '**/dist/**'],
    /*
     * I LOG DEI TEST VANNO DRITTI A stdout (21 set 2026, vitest 5).
     *
     * Di suo vitest INTERCETTA `console` dentro il worker e manda ogni riga
     * al processo principale con una chiamata rpc (`onUserConsoleLog`). La 5
     * chiude quel canale alla fine di un file di test anche se ha ancora
     * righe in coda, e allora alza «EnvironmentTeardownError: Closing rpc
     * while "onUserConsoleLog" was pending» — che la 5, a differenza della 4,
     * CONTA come errore e fa fallire la corsa.
     *
     * Qui succedeva un giro su tre, su un file di test sempre diverso, con
     * tutti e 422 i file passati: la corsa rossa non diceva niente sul
     * prodotto. Questa suite logga moltissimo di proposito — quasi ogni riga
     * e' un messaggio fail-loud del prodotto che il test sta esercitando — e
     * quella coda non si svuota mai in tempo.
     *
     * Senza intercettazione il worker scrive direttamente su stdout: i log
     * restano visibili (e servono, quando un test cade), ma non passano piu'
     * da una chiamata che puo' restare a meta'. Cinque corse su cinque
     * pulite, dove prima ne cadevano tre.
     *
     * Il prezzo: le righe dei worker in parallelo si mescolano e perdono il
     * prefisso «stderr | file > test». Si paga volentieri.
     */
    disableConsoleIntercept: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json', 'html'],
      // Every source file counts, not only the ones a test happens to import:
      // a new untested module lowers the ratio instead of being invisible.
      include: ['src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts', 'src/scripts/**', 'src/index.ts', 'src/worker.ts'],
      // Non-regression floors (G-10), measured on 8 Sep 2026 and set just
      // below the value of the day — lib 68/68/68/52, services 57/56/49/56
      // (lines/statements/functions/branches). Raise them as coverage grows;
      // never lower them to make a red run green.
      thresholds: {
        'src/lib/**':      { lines: 67, statements: 66, functions: 66, branches: 50 },
        'src/services/**': { lines: 56, statements: 55, functions: 47, branches: 55 },
      },
    },
  },
})
