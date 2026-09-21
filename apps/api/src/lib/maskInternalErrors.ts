/**
 * Un errore del DRIVER del database non si mostra a chi usa l'app.
 *
 * Giro nel browser del 14 set 2026 (#6): un toast diceva «Expected
 * parameter(s): tenantId» — il testo di Neo4j, arrivato così com'è. Non dice
 * niente a chi guarda e racconta come è fatta una query. Qui un errore del
 * driver (o una sua causa) diventa un messaggio generico con un RIFERIMENTO;
 * il testo vero va nel log con lo stesso riferimento, così chi gestisce
 * l'installazione lo ritrova. Gli altri errori — i nostri, detti apposta, con
 * o senza chiave — passano come sono: sono scritti per essere letti.
 */
import { randomUUID } from 'node:crypto'
import type { GraphQLFormattedError } from 'graphql'

function isDriverError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 4) return false
  const e = err as { name?: unknown; code?: unknown; originalError?: unknown; cause?: unknown }
  if (e.name === 'Neo4jError' || (typeof e.code === 'string' && e.code.startsWith('Neo.'))) return true
  return isDriverError(e.originalError, depth + 1) || isDriverError(e.cause, depth + 1)
}

export function maskDriverError(
  formatted: GraphQLFormattedError, error: unknown, log: (entry: { ref: string; message: string }) => void,
): GraphQLFormattedError {
  if (!isDriverError(error)) return formatted
  const ref = randomUUID().slice(0, 8)
  log({ ref, message: formatted.message })
  return {
    ...formatted,
    message: `Internal database error (reference ${ref}). The details are in the API log.`,
    extensions: { ...formatted.extensions, code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.internalDatabase', params: { ref } } },
  }
}
