import i18n from '@/i18n/i18n'

/** L'esito di `executeWorkflowTransition` quando la transizione è rifiutata. */
export interface TransitionFailure {
  error:        string | null
  errorKey?:    string | null
  errorParams?: ReadonlyArray<{ name: string; value: string }> | null
}

/**
 * La frase di una transizione rifiutata, nella lingua di chi guarda.
 *
 * L'API manda `error` (inglese, per i log) e, quando conosce la causa,
 * `errorKey` + `errorParams`. Una chiave che il client non conosce ricade sul
 * messaggio dell'API, e un esito senza nessuno dei due sul `fallback`.
 */
export function transitionErrorText(r: TransitionFailure, fallback: string): string {
  if (r.errorKey) {
    const params = Object.fromEntries((r.errorParams ?? []).map((p) => [p.name, p.value]))
    if (i18n.exists(r.errorKey, params)) return i18n.t(r.errorKey, params)
  }
  return r.error ?? fallback
}
