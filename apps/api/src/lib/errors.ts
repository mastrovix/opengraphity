import { GraphQLError } from 'graphql'

/**
 * LA CHIAVE DI UN ERRORE, per chi ha una lingua.
 *
 * Il `message` di un errore ha due pubblici che vogliono cose opposte: i log,
 * le metriche e i client d'integrazione vogliono una stringa STABILE (e
 * inglese, che è la lingua del prodotto); la persona davanti allo schermo
 * vuole la propria lingua, e l'API non sa quale sia — non c'è
 * `Accept-Language`, l'utente non porta una lingua.
 *
 * Per mesi la seconda cosa è stata risolta scrivendo il messaggio in italiano:
 * chi usava l'interfaccia in inglese riceveva «Il CI non ha un Owner Group»
 * dentro una schermata inglese. Ora un errore può portare anche una CHIAVE, e
 * la frase la compone il client (`createI18nLink` in `@opengraphity/web-core`
 * riscrive il messaggio prima che arrivi alle pagine).
 *
 * Il `message` resta e resta inglese: è quello che finisce nei log e che legge
 * chi chiama l'API senza un'interfaccia.
 */
export interface ErrorI18n {
  /** Chiave i18n del client, sotto `errors.` */
  key: string
  /** Solo dati da interpolare: mai prosa. */
  params?: Record<string, string | number>
}

const conI18n = (code: string, i18n?: ErrorI18n) => (i18n ? { code, i18n } : { code })

export class NotFoundError extends GraphQLError {
  constructor(entityType: string, id?: string) {
    super(
      id ? `${entityType} ${id} not found` : `${entityType} not found`,
      { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.notFound', params: { entity: entityType, id: id ?? '' } } } },
    )
  }
}

export class ValidationError extends GraphQLError {
  constructor(message: string, i18n?: ErrorI18n) {
    super(message, { extensions: conI18n('BAD_USER_INPUT', i18n) })
  }
}

export class ForbiddenError extends GraphQLError {
  constructor(message = 'Forbidden', i18n?: ErrorI18n) {
    super(message, { extensions: conI18n('FORBIDDEN', i18n) })
  }
}

/**
 * Risorsa temporaneamente satura (es. tutti gli isolate del transform script
 * occupati): il chiamante deve ritentare dopo `retryAfterSeconds`. Su REST
 * diventa 503 + header `Retry-After`; mai un 500 (non è un guasto) né un 400
 * (il payload non c'entra).
 */
export class ServiceUnavailableError extends GraphQLError {
  readonly retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message, { extensions: { code: 'SERVICE_UNAVAILABLE', retryAfterSeconds } })
    this.retryAfterSeconds = retryAfterSeconds
  }
}
