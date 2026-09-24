/**
 * Passata periodica paginata (Event Management, job `events-maintenance`).
 *
 * I job periodici non caricano mai "tutti gli eventi in stato X" in memoria:
 * leggono pagine di `PAGE_SIZE` righe ordinate per chiave con cursore
 * (`WHERE key > $cursor ORDER BY key LIMIT n`), ciascuna in una transazione
 * propria, e si fermano dopo `MAX_PAGES` pagine per passata (il resto lo
 * riprende la passata successiva: `truncated = true`, loggato — e, con
 * `resume`, ripartendo da dove si era fermata). Un errore su
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

/**
 * Where a pass left off, kept between runs (review of 23 Sep 2026).
 *
 * Every run started from the first key and stopped after `MAX_PAGES` pages:
 * rows that kept failing stayed eligible, and with more than 4,000 of them
 * the rows past them were never reached — nor were the suppressed events
 * still inside their window, which the closed-window pass reads all of. Now a
 * run starts where the previous one stopped and, at the end of the rows,
 * starts again from the first key up to where it began: every row is visited
 * once per lap, whatever sits in front of it.
 */
export interface PassCursorStore {
  get(key: string): Promise<string | null>
  set(key: string, cursor: string): Promise<void>
  clear(key: string): Promise<void>
}

/** How long a saved cursor lives: a pass that stops running for a day starts over. */
export const PASS_CURSOR_TTL_SECONDS = 24 * 3600

/** The cursors in Redis, shared by the replicas. Redis unreachable is an error, as for every other pass state. */
export const redisPassCursors: PassCursorStore = {
  async get(key) { return (await (await import('./bullmq.js')).getSharedRedis().get(passCursorKey(key))) ?? null },
  async set(key, cursor) { await (await import('./bullmq.js')).getSharedRedis().set(passCursorKey(key), cursor, 'EX', PASS_CURSOR_TTL_SECONDS) },
  async clear(key) { await (await import('./bullmq.js')).getSharedRedis().del(passCursorKey(key)) },
}

export function passCursorKey(key: string): string {
  return `og:pagedpass:cursor:${key}`
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
  /**
   * Resume where the previous run stopped: the key of the pass (with its
   * tenant), and the store (Redis by default). Without it every run starts
   * from the first key.
   */
  resume?: { key: string; store?: PassCursorStore }
}

export async function runPagedPass<Row>(input: PagedPassInput<Row>): Promise<PagedPassResult> {
  const pageSize = input.pageSize ?? PAGE_SIZE
  const maxPages = input.maxPages ?? MAX_PAGES
  const store = input.resume ? (input.resume.store ?? redisPassCursors) : null
  const start = input.resume && store ? (await store.get(input.resume.key)) ?? '' : ''
  let cursor = start
  // The second lap: from the first key back up to where this run began.
  let wrapped = false
  let evaluated = 0
  let failed = 0
  const finish = async (): Promise<PagedPassResult> => {
    if (input.resume && store) await store.clear(input.resume.key)
    return { evaluated, failed, truncated: false }
  }
  for (let page = 0; page < maxPages; page++) {
    const fetched = await input.fetchPage(cursor, pageSize)
    const endOfRows = fetched.length < pageSize
    const rows = wrapped ? fetched.filter((r) => input.keyOf(r) <= start) : fetched
    const backAtStart = wrapped && rows.length < fetched.length
    for (const row of rows) {
      evaluated++
      try {
        await input.handle(row)
      } catch (err) {
        failed++
        input.onError(row, err)
      }
    }
    if (backAtStart) return finish()
    if (endOfRows) {
      if (wrapped || start === '') return finish()
      wrapped = true
      cursor = ''
      continue
    }
    const last = input.keyOf(fetched[fetched.length - 1]!)
    if (!last || last <= cursor) throw new Error(`runPagedPass: page cursor did not advance (last key ${JSON.stringify(last)} after ${JSON.stringify(cursor)})`)
    cursor = last
    if (wrapped && cursor >= start) return finish()
  }
  if (input.resume && store) await store.set(input.resume.key, cursor)
  return { evaluated, failed, truncated: true }
}
