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
      /**
       * I PAVIMENTI DI NON REGRESSIONE, UNO PER AREA (rifatti il 22 set 2026).
       *
       * Sono PAVIMENTI, non bersagli: dicono «da qui non si scende», non «qui
       * va bene». Si alzano quando la copertura sale, non si abbassano mai per
       * far tornare verde una CI rossa.
       *
       * ## Perché erano da rifare
       * Li aveva misurati il G-10 l'8 settembre e da allora nessuno li aveva
       * toccati, mentre la copertura cresceva: `src/services/**` stava a 56 con
       * un valore reale del 90, cioè TRENTAQUATTRO punti di gioco. Un pavimento
       * con trentaquattro punti di gioco non e' un pavimento, e' un ricordo:
       * si poteva cancellare meta' dei test di quell'area senza che la CI
       * dicesse niente.
       *
       * E coprivano DUE aree su tredici. `src/graphql/**` — la piu' grande,
       * novemilacinquecento statement — non ne aveva nessuno.
       *
       * ## Come si mantengono adesso
       * `scripts/check-tetti-copertura.mjs` gira in CI dopo la misura e
       * fallisce se un pavimento e' piu' di cinque punti sotto il valore vero,
       * o se un'area di `src/` non ha il suo. Quindi non possono invecchiare
       * un'altra volta in silenzio.
       *
       * Il numero in coda a ogni riga e' il valore del giorno in cui il
       * pavimento e' stato messo: serve a leggere il gioco senza rifare la
       * misura.
       */
      thresholds: {
        'src/lib/**':        { lines: 80, statements: 77, functions: 78, branches: 69 },  // 82.1/79.8/80.7/71.1
        'src/graphql/**':      { lines: 63, statements: 61, functions: 55, branches: 54 },  // 65.8/63.6/57.6/56.7
        'src/services/**':   { lines: 90, statements: 88, functions: 87, branches: 83 },  // 92.4/90.2/89.4/85.5
        'src/rest/**':         { lines: 77, statements: 76, functions: 74, branches: 67 },  // 79.2/78.4/76.6/69.9
        'src/discovery/**':  { lines: 94, statements: 91, functions: 90, branches: 82 },  // 96.8/93.6/92.6/84.5
        'src/jobs/**':       { lines: 77, statements: 76, functions: 71, branches: 64 },  // 79.0/78.4/73.5/66.7
        'src/middleware/**': { lines: 84, statements: 82, functions: 79, branches: 67 },  // 86.1/85.0/81.8/69.7
        'src/anomaly/**':    { lines: 65, statements: 63, functions: 59, branches: 63 },  // 67.5/65.1/61.3/65.5
        'src/auth/**':       { lines: 93, statements: 92, functions: 86, branches: 83 },  // 95.6/94.1/88.9/85.0
        'src/consumers/**':  { lines: 88, statements: 82, functions: 90, branches: 72 },  // 90.4/84.8/92.3/74.1
        'src/workers/**':    { lines: 82, statements: 81, functions: 98, branches: 64 },  // 84.0/83.0/100.0/66.7
        'src/workflow/**':   { lines: 83, statements: 80, functions: 78, branches: 68 },  // 85.3/82.9/80.0/70.6
        /*
         * La radice: `server.ts` (centosettanta statement, ZERO coperti) e il
         * pezzo di telemetria che si accende all'avvio. Nessun test li importa.
         * Un pavimento a 4/3/0/0 non difende quasi niente — e' quello che c'e',
         * e dirlo e' meglio che togliere questi file dalla misura come sono
         * tolti `index.ts` e `worker.ts`: cosi' restano contati, e si vede il
         * buco invece di nasconderlo.
         */
        'src/*.ts':          { lines: 4, statements: 3, functions: 0, branches: 0 },  // 6.1/5.3/1.6/1.3
      },
    },
  },
})
