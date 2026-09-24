/**
 * QUERIES THE CUSTOMER OR THE MODEL WRITES HAVE A TIME LIMIT (review of 23 Sep 2026).
 *
 * A report section is built from a graph the customer draws; the report AI
 * runs Cypher the model writes. Both ran with no transaction timeout, and
 * Neo4j has none by default: a join over every incident and CI of the demo
 * tenant held the shared database and the API's memory for minutes, again at
 * every dashboard refresh and scheduled run. The driver's per-transaction
 * timeout stops them on the server.
 */

/** A report section, a dashboard widget, a scheduled or exported report. */
export const REPORT_SECTION_TIMEOUT_MS = 30_000
/** One query of the report AI: the model gets the error and can ask a smaller one. */
export const REPORT_AI_QUERY_TIMEOUT_MS = 20_000
/** The rows of one report AI query the model sees: more is cut anyway (8,000 characters). */
export const REPORT_AI_MAX_ROWS = 200

/** Neo4j stopped the transaction for its timeout (the server's or the one the driver sent). */
export function isQueryTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code.includes('TransactionTimedOut')
}

/**
 * The first `max` records of a query, read one by one when the result can be
 * iterated — the rest is never loaded — or cut from the full list otherwise.
 */
export async function firstRecords<R>(result: unknown, max: number): Promise<{ records: R[]; cut: boolean }> {
  if (result !== null && typeof result === 'object' && Symbol.asyncIterator in result) {
    const records: R[] = []
    for await (const r of result as AsyncIterable<R>) {
      if (records.length >= max) return { records, cut: true }
      records.push(r)
    }
    return { records, cut: false }
  }
  const all = ((await result) as { records: R[] }).records
  return { records: all.slice(0, max), cut: all.length > max }
}
