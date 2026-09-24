import type { TransitionResult } from '@opengraphity/workflow'

/**
 * Una transizione rifiutata dal motore, per chi la mostra a una persona.
 *
 * Il motore restituisce `error` (inglese, per log e integrazioni) e, quando la
 * causa è nota, `errorI18n` (la chiave della frase). Prima i resolver
 * rilanciavano solo `error`: la persona leggeva il messaggio tecnico, e fino a
 * settembre 2026 in italiano anche con il prodotto in inglese.
 *
 * The refusals thrown as errors are the pipeline's (services/ticketTransition.ts,
 * `refusalError`, wave 7 · B1); what stays here is the shape of the result of
 * `executeWorkflowTransition`, which returns the engine's no instead of throwing it.
 */

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
