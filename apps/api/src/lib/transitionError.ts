import { GraphQLError } from 'graphql'
import type { TransitionResult } from '@opengraphity/workflow'
import type { ErrorI18n } from './errors.js'

/**
 * Una transizione rifiutata dal motore, per chi la mostra a una persona.
 *
 * Il motore restituisce `error` (inglese, per log e integrazioni) e, quando la
 * causa è nota, `errorI18n` (la chiave della frase). Prima i resolver
 * rilanciavano solo `error`: la persona leggeva il messaggio tecnico, e fino a
 * settembre 2026 in italiano anche con il prodotto in inglese.
 */
export function transitionErrorI18n(result: Pick<TransitionResult, 'errorI18n'>): ErrorI18n | undefined {
  return result.errorI18n ? { key: result.errorI18n.key, ...(result.errorI18n.params ? { params: result.errorI18n.params } : {}) } : undefined
}

/** L'errore GraphQL di una transizione manuale rifiutata. */
export function transitionFailed(result: Pick<TransitionResult, 'error' | 'errorI18n'>, fallback: string): GraphQLError {
  const i18n = transitionErrorI18n(result)
  return new GraphQLError(result.error ?? fallback, { extensions: i18n ? { code: 'CONFLICT', i18n } : { code: 'CONFLICT' } })
}

/** I campi dell'esito `TransitionResult` di GraphQL: messaggio, chiave e parametri. */
export function transitionErrorFields(result: Pick<TransitionResult, 'error' | 'errorI18n'>): {
  error: string | null
  errorKey: string | null
  errorParams: Array<{ name: string; value: string }> | null
} {
  return {
    error:       result.error ?? null,
    errorKey:    result.errorI18n?.key ?? null,
    errorParams: result.errorI18n?.params
      ? Object.entries(result.errorI18n.params).map(([name, value]) => ({ name, value }))
      : null,
  }
}
