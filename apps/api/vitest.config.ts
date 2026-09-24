import { defineConfig, configDefaults } from 'vitest/config'
// I numeri stanno in un posto solo: vedi `copertura.mjs` alla radice.
// @ts-expect-error — modulo JS senza tipi, alla radice del monorepo
import { ESCLUSI_SEMPRE, PAVIMENTI } from '../../copertura.mjs'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // vitest 4 no longer excludes `**/dist/**` by default: without this the
    // compiled copies of the tests under dist/ (tsc output of an older
    // tsconfig) would run too, against stale imports.
    // The integration suite runs against a real Neo4j, with its own config (vitest.integration.config.ts).
    exclude: [...configDefaults.exclude, '**/dist/**', 'src/__integration__/**'],
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
      // `ESCLUSI_SEMPRE` vale per tutti i workspace; qui si aggiunge quello
      // che e' solo dell'api: gli script di servizio e i tre punti d'ingresso.
      /*
       * Il generatore del tenant di prova si divide in due. La parte che
       * PENSA — chi sono le persone, che forma ha il CMDB, come si muove un
       * ticket nel workflow, quando scade uno SLA — e' logica di dominio e
       * resta contata: i suoi test la tengono sopra il pavimento. La parte
       * che SCRIVE (`writer`, i `write*`, `generate`, `clean`, `verify`, il
       * catalogo e i report costruiti chiamando i resolver veri) e' uno
       * strumento di sviluppo come `src/scripts/**`: il suo unico banco di
       * prova e' un Neo4j vero, e si verifica con `--verify` dopo una corsa.
       * Contarla con dei finti non direbbe niente su quello che scrive.
       */
      exclude: [...ESCLUSI_SEMPRE, 'src/scripts/**', 'src/__integration__/**', 'src/index.ts', 'src/worker.ts', 'src/workerHealthcheck.ts',
        'src/lib/testData/demoTenant/{writer,writeReference,writeTickets,generate,clean,afterRun,verify,catalogSetup,reports,serviceRequests}.ts'],
      /*
       * I PAVIMENTI stanno in `copertura.mjs` alla radice, con tutti gli altri
       * workspace e con l'OBIETTIVO del 95% deciso dal proprietario. Erano
       * qui, misurati l'8 settembre e mai piu' toccati: `src/services` aveva
       * trentaquattro punti di gioco, e gli altri undici workspace non avevano
       * pavimenti affatto. La domanda «a che punto siamo col 95%» si deve
       * poter leggere in un file solo.
       *
       * Per AREA e non uno solo: qui una media nasconderebbe `src/services` al
       * 93% accanto a `src/graphql` al 65%.
       */
      thresholds: PAVIMENTI['apps/api'],
    },
  },
})
