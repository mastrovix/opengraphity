/**
 * Passata periodica paginata (Event Management, job `events-maintenance`).
 *
 * I job periodici non caricano mai "tutti gli eventi in stato X" in memoria:
 * leggono pagine di `PAGE_SIZE` righe ordinate per chiave con cursore
 * (`WHERE key > $cursor ORDER BY key LIMIT n`), ciascuna in una transazione
 * propria, e si fermano dopo `MAX_PAGES` pagine per passata (il resto lo
 * riprende la passata successiva: `truncated = true`, loggato). Un errore su
 * una riga non ferma le altre: viene contato e la passata fallisce alla fine
 * (visibile in coda), come prima.
 */
export const PAGE_SIZE = 200
export const MAX_PAGES = 20

export interface PagedPassResult {
  /** Righe lette (tutte le pagine). */
  evaluated: number
  /** Righe la cui `handle` ha lanciato. */
  failed:    number
  /** True se il tetto di pagine è stato raggiunto e restano righe da elaborare. */
  truncated: boolean
}

export interface PagedPassInput<Row> {
  /** Una pagina di righe con chiave > cursor (cursor '' alla prima pagina), al più `pageSize` righe. */
  fetchPage: (cursor: string, pageSize: number) => Promise<Row[]>
  /** Chiave ordinabile della riga (il cursore avanza all'ultima chiave della pagina). */
  keyOf:     (row: Row) => string
  handle:    (row: Row) => Promise<void>
  onError:   (row: Row, err: unknown) => void
  pageSize?: number
  maxPages?: number
}

export async function runPagedPass<Row>(input: PagedPassInput<Row>): Promise<PagedPassResult> {
  const pageSize = input.pageSize ?? PAGE_SIZE
  const maxPages = input.maxPages ?? MAX_PAGES
  let cursor = ''
  let evaluated = 0
  let failed = 0
  for (let page = 0; page < maxPages; page++) {
    const rows = await input.fetchPage(cursor, pageSize)
    if (rows.length === 0) return { evaluated, failed, truncated: false }
    for (const row of rows) {
      evaluated++
      try {
        await input.handle(row)
      } catch (err) {
        failed++
        input.onError(row, err)
      }
    }
    if (rows.length < pageSize) return { evaluated, failed, truncated: false }
    const last = input.keyOf(rows[rows.length - 1]!)
    if (!last || last <= cursor) throw new Error(`runPagedPass: page cursor did not advance (last key ${JSON.stringify(last)} after ${JSON.stringify(cursor)})`)
    cursor = last
  }
  return { evaluated, failed, truncated: true }
}
