/**
 * Ricerca vettoriale per tenant (revisione totale · B-12).
 *
 * `db.index.vector.queryNodes` restituisce i K vicini più prossimi
 * dell'INTERO indice, che è cross-tenant: filtrare `node.tenant_id` DOPO
 * significa che un cliente piccolo, in un'installazione con clienti grandi,
 * non vede nessun risultato — i K globali sono quasi tutti di altri. Nessuna
 * fuga di dati (il filtro c'è), ma la funzione diventa muta: «nessun incident
 * simile» anche quando ce ne sono.
 *
 * Qui K cresce finché i risultati DEL TENANT bastano o finché si raggiunge il
 * tetto: la ricerca non mente e non gira a vuoto. Toccato il tetto con meno
 * risultati del richiesto, lo si scrive nel log (non è un errore: il cliente
 * può davvero avere pochi documenti, ma va distinto dal tetto raggiunto).
 */
import { runQuery } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import { logger } from './logger.js'

const log = logger.child({ module: 'vector-search' })

/** Primo K: qualche multiplo del richiesto, come prima. */
export function firstK(limit: number): number { return limit * 4 + 10 }

/** Quanto si allarga a ogni giro: un indice con molti tenant richiede salti ampi. */
const K_GROWTH = 8

/**
 * Tetto di K. Oltre questo la scansione dell'indice costa più di quanto valga
 * il risultato: si restituisce quello che c'è e si dice nel log.
 */
export const K_MAX = 5000

export interface VectorSearchOptions {
  /** Nome dell'indice vettoriale (vectorIndexName). */
  index:     string
  embedding: number[]
  tenantId:  string
  /** Quanti risultati del tenant servono. */
  limit:     number
  /**
   * Condizioni aggiuntive su `node`, in AND con il filtro del tenant (es.
   * `node.id <> $selfId`). Il tenant è già imposto dall'helper.
   */
  where?:    string
  /** Corpo della RETURN (senza la parola RETURN), su `node` e `score`. */
  returns:   string
  /** Clausole fra il WHERE e la RETURN (es. un OPTIONAL MATCH). */
  extra?:    string
  /** `ORDER BY` personalizzato; per default `score DESC`. */
  orderBy?:  string
  params?:   Record<string, unknown>
  /** Per i log: quale funzione sta cercando. */
  what:      string
}

/**
 * Esegue la ricerca con un K crescente e restituisce al massimo `limit` righe
 * del tenant. `run` è iniettabile per i test; per default usa `runQuery`.
 */
export async function vectorSearchForTenant<T>(
  session: Session,
  opts: VectorSearchOptions,
): Promise<T[]> {
  const { index, embedding, tenantId, limit, where, returns, extra, orderBy, params = {}, what } = opts
  const conditions = `node.tenant_id = $tenantId${where ? ` AND ${where}` : ''}`
  let k = Math.max(firstK(limit), limit)
  let rows: T[]
  for (;;) {
    rows = await runQuery<T>(session, `
      CALL db.index.vector.queryNodes($index, $k, $embedding)
      YIELD node, score
      WHERE ${conditions}
      ${extra ?? ''}
      RETURN ${returns}
      ORDER BY ${orderBy ?? 'score DESC'}
      LIMIT toInteger($vectorLimit)
    `, { ...params, index, embedding, tenantId, k, vectorLimit: limit })
    if (rows.length >= limit || k >= K_MAX) break
    k = Math.min(k * K_GROWTH, K_MAX)
  }
  if (rows.length < limit && k >= K_MAX) {
    log.info({ tenantId, what, index, k, found: rows.length, wanted: limit },
      'Ricerca vettoriale: tetto di K raggiunto, i risultati possono essere incompleti')
  }
  return rows
}
