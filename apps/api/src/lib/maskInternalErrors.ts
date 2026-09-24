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
 *
 * A request the database STOPPED at one of its limits (wave 7 · A2) — a
 * page's read past 30 s, a transaction past 120 s or past 1 GB — is not an
 * internal error: the person can narrow what they asked for. It says so, and
 * the reference still leads to the log.
 */
import { randomUUID } from 'node:crypto'
import type { GraphQLFormattedError } from 'graphql'
import { isTransactionMemoryLimit } from '@opengraphity/neo4j'
import { isQueryTimeout } from './queryTimeout.js'

const LIMIT_MESSAGES = {
  time: {
    key: 'errors.queryTimeout',
    message: (ref: string) => `The database stopped this request because it took too long (reference ${ref}). Narrow it — a filter, a shorter period — and try again.`,
  },
  memory: {
    key: 'errors.queryMemoryLimit',
    message: (ref: string) => `The database stopped this request because it needed too much memory (reference ${ref}). Narrow it — a filter, a shorter period — and try again.`,
  },
} as const

/** The database limit that stopped the request, looking through the wrappers (QueryError, GraphQLError). */
function databaseLimitOf(err: unknown, depth = 0): keyof typeof LIMIT_MESSAGES | null {
  if (!err || typeof err !== 'object' || depth > 4) return null
  if (isQueryTimeout(err)) return 'time'
  if (isTransactionMemoryLimit(err)) return 'memory'
  const e = err as { originalError?: unknown; cause?: unknown }
  return databaseLimitOf(e.originalError, depth + 1) ?? databaseLimitOf(e.cause, depth + 1)
}

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
  const limit = databaseLimitOf(error)
  if (limit) {
    const { key, message } = LIMIT_MESSAGES[limit]
    return {
      ...formatted,
      message: message(ref),
      extensions: { ...formatted.extensions, code: 'INTERNAL_SERVER_ERROR', i18n: { key, params: { ref } } },
    }
  }
  return {
    ...formatted,
    message: `Internal database error (reference ${ref}). The details are in the API log.`,
    extensions: { ...formatted.extensions, code: 'INTERNAL_SERVER_ERROR', i18n: { key: 'errors.internalDatabase', params: { ref } } },
  }
}
