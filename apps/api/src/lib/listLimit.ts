/**
 * IL LIMITE DELLE LISTE DI TICKET (revisione del 14 set 2026 · CH-16).
 *
 * `changes(limit)` — e allo stesso modo incident, problem e richieste —
 * accettava qualunque valore: una richiesta con un milione di righe caricava
 * tutto in memoria. Il massimo è quello dell'esportazione del web (10 000):
 * un tetto più basso l'avrebbe troncata in silenzio. Oltre il massimo, o con
 * un valore che non è un intero positivo, la richiesta si rifiuta.
 */
import { ValidationError } from './errors.js'

export const MAX_LIST_LIMIT = 10_000

export function listPage(args: { limit?: number | null; offset?: number | null }, defaultLimit: number): { limit: number; offset: number } {
  const limit  = args.limit  ?? defaultLimit
  const offset = args.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ValidationError(
      `limit must be an integer between 1 and ${MAX_LIST_LIMIT} (got ${String(limit)})`,
      { key: 'errors.list.limit', params: { max: MAX_LIST_LIMIT, got: String(limit) } },
    )
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError(`offset must be a non-negative integer (got ${String(offset)})`, { key: 'errors.list.offset', params: { got: String(offset) } })
  }
  return { limit, offset }
}
