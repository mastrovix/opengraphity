import { ApolloClient, InMemoryCache, HttpLink, from, ApolloLink as ApolloLinkClass, type TypePolicies } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { ErrorLink } from '@apollo/client/link/error'
import { CombinedGraphQLErrors, ServerError } from '@apollo/client/errors'
import { Observable } from '@apollo/client/utilities'
import type { ApolloLink } from '@apollo/client/link'
import type { ClientLogger } from './logger.js'
import { consoleLogger } from './logger.js'

export interface GraphQLErrorInfo {
  code?: string | undefined
  path?: readonly (string | number)[] | undefined
  operation?: string | undefined
}

export interface ErrorLinkOptions {
  /** Forced refresh (`refreshToken(-1)`): the API just rejected the token we have. */
  refreshToken: () => Promise<unknown>
  /** After a failed refresh: true when keycloak-js dropped the session (→ login), false on transport errors. */
  isSessionInvalid: () => boolean
  /** Session invalid or fresh token still rejected: redirect to login (`forceLogin`). */
  onSessionInvalid: () => void
  /** Transport failure (API or Keycloak unreachable). Already deduped: one call per `dedupeMs`. */
  onNetworkError: (error: Error, info: { operation?: string | undefined }) => void
  /** Any other GraphQL error. Deduped per message. */
  onGraphQLError: (message: string, info: GraphQLErrorInfo) => void
  clientLogger?: ClientLogger
  /** Window in which repeated identical notifications are collapsed (N failing queries → 1 toast). */
  dedupeMs?: number
}

export interface CreateApolloClientOptions extends ErrorLinkOptions {
  uri: string
  getToken: () => string | undefined
  defaultOptions?: ApolloClient.DefaultOptions
  /** Come si traduce la chiave di un errore. Senza, i messaggi restano quelli del server. */
  traduciErrore?: TraduciErrore
  /** Regole della cache per tipo (es. oggetti senza id letti da più query). */
  typePolicies?: TypePolicies
}

export const DEFAULT_DEDUPE_MS = 5_000

/** `once(key)` → true the first time within the window, false while it is still open. */
export function createDeduper(windowMs: number): (key: string) => boolean {
  const recent = new Map<string, number>()
  return (key) => {
    const now  = Date.now()
    const last = recent.get(key)
    if (last !== undefined && now - last < windowMs) return false
    recent.set(key, now)
    return true
  }
}

export const NETWORK_DEDUPE_KEY = 'network'

function hasUnauthorized(result: ApolloLink.Result): boolean {
  const errors = (result as { errors?: readonly { extensions?: Record<string, unknown> }[] }).errors
  return Array.isArray(errors) && errors.some((e) => e.extensions?.['code'] === 'UNAUTHORIZED')
}

/**
 * UNAUTHORIZED arrivato come `ServerError` invece che come errore GraphQL.
 *
 * `HttpLink` legge il corpo di una risposta non-2xx **solo** se il media type
 * è `application/graphql-response+json`; con qualunque altro tipo solleva
 * `ServerError` senza guardarci dentro. L'API manda quello giusto, ma basta un
 * reverse proxy che riscriva il `Content-Type` — o un'altra API davanti a
 * questo client — perché un token scaduto torni a comparire come «errore di
 * rete» e il rinfresco muoia in silenzio, che è esattamente il difetto che
 * questa riga chiude. Qui si guarda lo stato **e** il corpo: 401 da solo non
 * basta a dire che rinfrescare il token serva.
 */
function isUnauthorizedServerError(error: unknown): boolean {
  if (!ServerError.is(error) || error.statusCode !== 401) return false
  try {
    const body: unknown = JSON.parse(error.bodyText)
    const errors = (body as { errors?: readonly { extensions?: Record<string, unknown> }[] }).errors
    return Array.isArray(errors) && errors.some((e) => e.extensions?.['code'] === 'UNAUTHORIZED')
  } catch {
    // 401 senza un corpo GraphQL leggibile: non è questo il caso da ritentare.
    return false
  }
}

/**
 * UNAUTHORIZED from the API: refresh the token (forced — the API just rejected
 * the one we have) and replay the SAME operation with the new bearer, without
 * any notification. The user only notices when the refresh itself fails:
 *   - session invalid → login redirect;
 *   - Keycloak unreachable → connection notification, the operation errors out
 *     and the page shows its QueryError/retry instead of a bogus "session expired".
 *
 * The replayed result is inspected HERE: Apollo's ErrorLink pipes a retried
 * observable straight to the caller and never runs the error handler on it
 * again, so a context flag ("authRetried") checked in the handler would never
 * fire. A fresh token that is still rejected means the account itself is not
 * accepted by the API → re-login is the only sane recovery.
 */
function retryAfterRefresh(
  o:         ErrorLinkOptions,
  once:      (key: string) => boolean,
  logger:    ClientLogger,
  operation: ApolloLink.Operation,
  forward:   ApolloLink.ForwardFunction,
): Observable<ApolloLink.Result> {
  return new Observable<ApolloLink.Result>((observer) => {
    let cancelled = false
    let sub: { unsubscribe(): void } | undefined
    o.refreshToken().then(
      () => {
        if (cancelled) return
        sub = forward(operation).subscribe({
          next: (result) => {
            if (hasUnauthorized(result)) {
              logger.error('UNAUTHORIZED dopo refresh del token', { operation: operation.operationName })
              o.onSessionInvalid()
            }
            observer.next(result)
          },
          error:    (err: unknown) => observer.error(err),
          complete: () => observer.complete(),
        })
      },
      (err: unknown) => {
        if (cancelled) return
        const error = err instanceof Error ? err : new Error(String(err))
        if (o.isSessionInvalid()) {
          o.onSessionInvalid()
        } else {
          logger.error('Token refresh fallito (rete)', { operation: operation.operationName, message: error.message })
          if (once(NETWORK_DEDUPE_KEY)) o.onNetworkError(error, { operation: operation.operationName })
        }
        observer.error(error)
      },
    )
    return () => { cancelled = true; sub?.unsubscribe() }
  })
}

export function createErrorLink(o: ErrorLinkOptions): ErrorLink {
  const logger = o.clientLogger ?? consoleLogger
  const once   = createDeduper(o.dedupeMs ?? DEFAULT_DEDUPE_MS)

  return new ErrorLink(({ error, operation, forward }) => {
    // Stessa decisione per le due forme in cui UNAUTHORIZED può arrivare.
    if (isUnauthorizedServerError(error)) {
      logger.warn('UNAUTHORIZED arrivato come ServerError (media type non GraphQL): rinfresco comunque', {
        operation: operation.operationName,
      })
      return retryAfterRefresh(o, once, logger, operation, forward)
    }
    if (CombinedGraphQLErrors.is(error)) {
      const unauthorized = error.errors.some((e) => e.extensions?.['code'] === 'UNAUTHORIZED')
      if (unauthorized) {
        return retryAfterRefresh(o, once, logger, operation, forward)
      }
      error.errors.forEach(({ message, path, extensions }) => {
        const code = typeof extensions?.['code'] === 'string' ? extensions['code'] : undefined
        logger.error(`GraphQL error: ${message}`, {
          code,
          path:      path as unknown as Record<string, unknown> | undefined,
          operation: operation.operationName,
        })
        if (once(`gql:${message}`)) o.onGraphQLError(message, { code, path, operation: operation.operationName })
      })
      return
    }

    logger.error(`Network error: ${error.message}`, { operation: operation.operationName })
    if (once(NETWORK_DEDUPE_KEY)) o.onNetworkError(error, { operation: operation.operationName })
  })
}

/**
 * LA FRASE DI UN ERRORE, nella lingua di chi guarda.
 *
 * L'API manda un `message` inglese e STABILE (log, metriche, integrazioni) e,
 * quando l'errore riguarda la persona davanti allo schermo, anche una chiave in
 * `extensions.i18n`. Qui la chiave diventa la frase, **prima** che l'errore
 * arrivi alle pagine: così ogni `onError: (e) => toast.error(e.message)` che
 * esiste già — e sono decine — si trova il messaggio nella lingua giusta senza
 * essere toccato.
 *
 * Il difetto che chiude: l'API non sa in che lingua guarda chi legge (non c'è
 * `Accept-Language`, l'utente non porta una lingua), e per mesi la risposta è
 * stata scrivere i messaggi in italiano — che in un'interfaccia inglese
 * restavano italiani.
 *
 * Una chiave che il bundle non conosce NON si nasconde: resta il messaggio del
 * server, che è vero e leggibile.
 */
export type TraduciErrore = (key: string, params?: Record<string, string | number>) => string | null

interface ErroreConChiave {
  message: string
  extensions?: { i18n?: { key?: unknown; params?: unknown } } | undefined
}

/**
 * UN PARAMETRO CHE FINISCE IN `Key` È A SUA VOLTA UNA CHIAVE.
 *
 * Alcune frasi si compongono di pezzi: «Riordinare i valori: il vocabolario
 * «event_severity» è la severità che mandano i sistemi di monitoraggio…» è
 * un'operazione + un vocabolario + un motivo, e i tre pezzi li conoscono tre
 * posti diversi dell'API. Prima l'API li incollava e passava il risultato come
 * parametro: prosa travestita da dato, che restava nella lingua di chi l'aveva
 * scritta — cioè il difetto di partenza, spostato dentro un parametro.
 *
 * La regola: `opKey` porta una chiave, e qui diventa `op`, tradotto. I pezzi
 * ricevono gli stessi parametri della frase che li contiene, così «Rinominare
 * «{{from}}» in «{{to}}»» funziona come un pezzo.
 */
function conPezziTradotti(
  params: Record<string, string | number>, traduci: TraduciErrore,
): Record<string, string | number> {
  const fuori: Record<string, string | number> = { ...params }
  for (const [nome, valore] of Object.entries(params)) {
    if (!nome.endsWith('Key') || typeof valore !== 'string') continue
    fuori[nome.slice(0, -3)] = traduci(valore, params) ?? valore
  }
  return fuori
}

function conFrasi(result: ApolloLink.Result, traduci: TraduciErrore): ApolloLink.Result {
  const errors = (result as { errors?: ErroreConChiave[] }).errors
  if (!errors || errors.length === 0) return result
  return {
    ...result,
    errors: errors.map((e) => {
      const i18n = e.extensions?.i18n
      if (!i18n || typeof i18n.key !== 'string') return e
      const params = conPezziTradotti((i18n.params ?? {}) as Record<string, string | number>, traduci)
      const frase = traduci(i18n.key, params)
      return frase === null ? e : { ...e, message: frase }
    }),
  } as ApolloLink.Result
}

export function createI18nLink(traduci: TraduciErrore): ApolloLink {
  return new ApolloLinkClass((operation, forward) =>
    new Observable<ApolloLink.Result>((observer) => {
      const sub = forward(operation).subscribe({
        next:     (result) => observer.next(conFrasi(result, traduci)),
        error:    (err: unknown) => observer.error(err),
        complete: () => observer.complete(),
      })
      return () => sub.unsubscribe()
    }),
  )
}

/** Bearer from `getToken()` on every request — the token lives in memory only (keycloak-js), never in storage. */
export function createAuthLink(getToken: () => string | undefined): ApolloLink {
  return setContext((_, { headers }) => {
    const token = getToken()
    return {
      headers: {
        ...(headers as Record<string, string> | undefined),
        authorization: token ? `Bearer ${token}` : '',
      },
    }
  })
}

export function createApolloClient(opts: CreateApolloClientOptions): ApolloClient {
  const { uri, getToken, defaultOptions, traduciErrore, typePolicies, ...linkOptions } = opts
  if (!uri) throw new Error('createApolloClient: "uri" mancante (VITE_API_URL)')
  const httpLink = new HttpLink({ uri })
  /*
    L'ORDINE CONTA: il link che traduce sta DENTRO quello che segnala, così la
    frase è gia nella lingua giusta quando `ErrorLink` costruisce l'errore che
    le pagine vedono (e quando lo passa a `onGraphQLError`, che fa il toast).
  */
  const catena = traduciErrore
    ? [createErrorLink(linkOptions), createI18nLink(traduciErrore), createAuthLink(getToken).concat(httpLink)]
    : [createErrorLink(linkOptions), createAuthLink(getToken).concat(httpLink)]
  return new ApolloClient({
    link:  from(catena),
    cache: new InMemoryCache(typePolicies ? { typePolicies } : undefined),
    ...(defaultOptions ? { defaultOptions } : {}),
  })
}
