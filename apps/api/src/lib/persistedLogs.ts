/**
 * I LOG CHE ERANO SCRITTI E MAI LETTI (20 set 2026).
 *
 * ## Il difetto
 * Da quando esiste il prodotto, ogni browser manda i propri errori a
 * `POST /api/logs/client`, che li scrive come nodi `:LogEntry`. Su `c-one` ce
 * ne sono 1.095, su `c-test` 129. Nessuno li ha MAI letti: in tutto l'albero
 * non esisteva un solo `MATCH (:LogEntry)`.
 *
 * La pagina «Log» — quella dove un amministratore andrebbe a cercarli —
 * leggeva soltanto `lib/logBuffer.ts`, cioè un anello in MEMORIA da 2.000
 * righe che si azzera a ogni riavvio del processo. Quindi:
 *
 *  - gli errori dei browser dei suoi utenti, che sono durevoli, erano
 *    invisibili;
 *  - quello che la pagina mostrava spariva al primo `docker compose up`.
 *
 * E `packages/web-core/src/clientLogger.ts` dichiarava, in un commento, che
 * quei nodi erano «visible in the Logs page». Non era vero, e lo era stato
 * scritto in buona fede: è il tipo di bugia che nasce quando due metà di una
 * funzione vengono costruite in momenti diversi e nessuno chiude il cerchio.
 *
 * ## La finestra, dichiarata
 * Si leggono al massimo `MAX_RIGHE` righe, le più recenti. Non è una
 * paginazione: i filtri della pagina girano DOPO, quindi cercare una parola
 * la cerca dentro questa finestra e non in tutto l'archivio. Il resolver lo
 * dice a chi guarda (`truncated`), perché una lista che sembra completa e non
 * lo è è peggio di una lista che dichiara il proprio bordo.
 */
import { getSession, toNumber } from '@opengraphity/neo4j'
import type { LogEntry } from './logBuffer.js'

/**
 * Quante righe persistite si leggono. Lo stesso numero dell'anello in memoria
 * (`logBuffer.MAX_SIZE`): le due metà della pagina hanno la stessa profondità,
 * e chi legge non deve chiedersi quale delle due sta vedendo più indietro.
 */
export const MAX_RIGHE = 2000

export const RIGHE_CYPHER = `
  MATCH (l:LogEntry {tenant_id: $tenantId})
  RETURN l.id AS id, l.timestamp AS timestamp, l.level AS level,
         l.module AS module, l.message AS message, l.data AS data
  ORDER BY l.timestamp DESC
  LIMIT toInteger($max)
`

export const CONTEGGIO_CYPHER = `
  MATCH (l:LogEntry {tenant_id: $tenantId}) RETURN count(l) AS n
`

/**
 * Le righe persistite di un cliente, dalla più recente, e quante ce ne sono
 * in tutto.
 *
 * Il conteggio è una query a parte e non `count()` sulla stessa: serve a dire
 * se la finestra taglia, e un numero che coincide sempre col numero di righe
 * restituite non lo direbbe mai.
 */
export async function righePersistite(
  tenantId: string, max = MAX_RIGHE,
): Promise<{ righe: LogEntry[]; totale: number }> {
  const session = getSession()
  try {
    /*
     * UNA ALLA VOLTA, sulla stessa sessione (20 set 2026).
     *
     * `Promise.all` di due `session.run` sembra un'ottimizzazione gratis e non
     * lo è: una sessione Neo4j non regge due query insieme — «Queries cannot
     * be run directly on a session with an open transaction». Trovato aprendo
     * la pagina, non dai test, perché i test non hanno una sessione vera.
     * È già successo in questo progetto (giro del 13 set), ed è il motivo per
     * cui vale la pena scriverlo qui invece di ricordarselo.
     */
    const r = await session.run(RIGHE_CYPHER, { tenantId, max })
    const c = await session.run(CONTEGGIO_CYPHER, { tenantId })
    return {
      righe: r.records.map((rec) => ({
        id:        rec.get('id') as string,
        timestamp: rec.get('timestamp') as string,
        level:     (rec.get('level') as string | null) ?? 'info',
        module:    (rec.get('module') as string | null) ?? 'frontend',
        message:   (rec.get('message') as string | null) ?? '',
        data:      (rec.get('data') as string | null) ?? null,
        // Sono già di questo cliente per costruzione: la query filtra per
        // tenant, e il campo serve alla forma condivisa con l'anello.
        tenantId,
      })),
      totale: toNumber(c.records[0]?.get('n') ?? 0),
    }
  } finally {
    await session.close()
  }
}

/**
 * Le due metà, fuse in una linea del tempo sola, dalla più recente.
 *
 * Non c'è sovrapposizione da deduplicare: l'anello porta le righe del SERVER
 * (scritte da pino mentre serviva una richiesta di questo cliente), i nodi
 * portano quelle del BROWSER (`module: 'frontend'`). Sono due metà dello
 * stesso racconto, ed è il motivo per cui vederne una sola non bastava mai.
 */
export function fondi(memoria: readonly LogEntry[], persistite: readonly LogEntry[]): LogEntry[] {
  return [...memoria, ...persistite].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0)
}
