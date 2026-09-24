/**
 * LA RETENTION DEI DUE REGISTRI DI LOG (20 set 2026, ondata 3).
 *
 * Ce ne sono due, e sono cose diverse:
 *
 *  - `:ServerLogEntry` — quello che l'ondata 3 crea: un nodo per (firma,
 *    giorno), template scrubbato, senza tenant. È l'archivio su cui il
 *    prodotto guarda sé stesso.
 *  - `:LogEntry` — i log del BROWSER, scritti da `rest/client-logs.ts` da
 *    quando esiste il prodotto. Nessuno li ha mai letti (zero `MATCH` in
 *    tutto l'albero), nessuno li ha mai purgati, e non avevano nemmeno un
 *    indice: 270.000 nodi, di cui 269.110 su `system` fermi all'8 aprile
 *    2026 — un fossile scritto da un percorso che nel codice non esiste più.
 *
 * Si purgano insieme perché il difetto era lo stesso: un registro che cresce
 * senza che nessuno abbia mai deciso per quanto. Qui la durata si decide, e
 * si decide UNA volta (`SERVER_LOG_RETENTION_DAYS`) — non è una scelta del
 * cliente, è quanto il gestore della piattaforma tiene la diagnostica di sé
 * stesso.
 *
 * Il taglio è a lotti in transazioni separate (`IN TRANSACTIONS OF`), come
 * `eventRetention.ts`: cancellare 270.000 nodi in una transazione sola vuol
 * dire riempire la heap di Neo4j e far cadere tutto il resto. Per lo stesso
 * motivo serve una sessione in **auto-commit**.
 */
import { getSession, MAINTENANCE_TX_CONFIG, toNumber } from '@opengraphity/neo4j'
import neo4j from 'neo4j-driver'
import { logger } from '../lib/logger.js'

const log = logger.child({ module: 'server-log-retention' })

/** Quanti nodi per transazione. Lo stesso di `eventRetention.ts`. */
export const PURGE_BATCH_SIZE = 1000

/**
 * Per quanti giorni si tiene un log. Default 90: tre mesi bastano a vedere
 * se un errore è tornato dopo un rilascio, e non tanti da rendere l'archivio
 * un secondo database. Un valore malformato è un errore di configurazione,
 * non un default silenzioso — e si scopre all'avvio, non alle 4 di notte.
 */
export function leggiGiorniDiRetention(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const grezzo = env['SERVER_LOG_RETENTION_DAYS']
  if (grezzo === undefined || grezzo === '') return 90
  const n = Number(grezzo)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Environment variable SERVER_LOG_RETENTION_DAYS must be an integer >= 1 (got "${grezzo}")`)
  }
  return n
}

/** L'istante prima del quale si cancella. Esportata perché il test non debba aspettare 90 giorni. */
export function limiteDiRetention(adessoMs: number, giorni: number): string {
  if (!Number.isInteger(giorni) || giorni < 1) throw new Error(`retention days must be an integer >= 1 (got ${String(giorni)})`)
  return new Date(adessoMs - giorni * 86_400_000).toISOString()
}

/*
 * Le due query. Separate e non una sola con `WHERE l:ServerLogEntry OR
 * l:LogEntry`: i due registri hanno campi di data DIVERSI (`day`, che è
 * `YYYY-MM-DD`, contro `timestamp`, che è un ISO intero) e mescolarli in un
 * confronto solo è il modo di cancellare la cosa sbagliata.
 */
export const PURGA_SERVER_CYPHER = `
  MATCH (l:ServerLogEntry) WHERE l.day < $limiteGiorno
  CALL { WITH l DETACH DELETE l } IN TRANSACTIONS OF ${PURGE_BATCH_SIZE} ROWS
`
export const PURGA_BROWSER_CYPHER = `
  // tenant-ok(piattaforma): la retention dei log è una durata di PIATTAFORMA, non di un
  // cliente. Purgare per tenant vorrebbe dire o un giro per ciascuno (e il
  // fossile su 'system', che tenant vivo non è, resterebbe lì per sempre) o
  // una durata per cliente che nessuno ha chiesto. Il filtro è l'età, e vale
  // per tutti allo stesso modo.
  MATCH (l:LogEntry) WHERE l.timestamp < $limite   // tenant-ok(piattaforma): la retention e una durata di piattaforma
  CALL { WITH l DETACH DELETE l } IN TRANSACTIONS OF ${PURGE_BATCH_SIZE} ROWS
`

async function quanti(cypher: string, params: Record<string, unknown>): Promise<number> {
  const session = getSession(undefined, neo4j.session.READ)
  try {
    const r = await session.run(cypher, params)
    return toNumber(r.records[0]?.get('n') ?? 0)
  } finally {
    await session.close()
  }
}

/**
 * La passata notturna. Torna quanti nodi ha tolto da ciascun registro.
 *
 * Si conta PRIMA e si cancella dopo, al contrario di `eventRetention.ts` che
 * conta con la stessa query che cancella: qui non si può, perché
 * `IN TRANSACTIONS` non restituisce righe utili, e un numero inventato in un
 * log di manutenzione è peggio di nessun numero.
 */
export async function purgaIRegistriDeiLog(adessoMs: number = Date.now()): Promise<{ server: number; browser: number; giorni: number }> {
  const giorni = leggiGiorniDiRetention()
  const limite = limiteDiRetention(adessoMs, giorni)
  const limiteGiorno = limite.slice(0, 10)

  const daTogliere = {
    server:  await quanti('MATCH (l:ServerLogEntry) WHERE l.day < $limiteGiorno RETURN count(l) AS n', { limiteGiorno }),
    // tenant-ok(piattaforma): vedi PURGA_BROWSER_CYPHER — l'età vale per tutti i tenant.
    browser: await quanti('MATCH (l:LogEntry) WHERE l.timestamp < $limite RETURN count(l) AS n', { limite }),
  }

  const session = getSession(undefined, neo4j.session.WRITE)
  try {
    // `IN TRANSACTIONS`: the outer transaction lasts the whole purge, past the server's 120 s.
    if (daTogliere.server > 0)  await session.run(PURGA_SERVER_CYPHER,  { limiteGiorno }, MAINTENANCE_TX_CONFIG)
    if (daTogliere.browser > 0) await session.run(PURGA_BROWSER_CYPHER, { limite }, MAINTENANCE_TX_CONFIG)
  } finally {
    await session.close()
  }

  log.info({ ...daTogliere, giorni, limite }, 'server-log-retention: log registries pruned')
  return { ...daTogliere, giorni }
}
