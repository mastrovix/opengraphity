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
  /**
   * IL TENANT È SOSPESO: si FERMA qui (17 set 2026).
   *
   * Non è una sessione da rinnovare né un account da riautenticare: è una
   * decisione di chi amministra la piattaforma, e nessun tentativo la cambia.
   * Senza questo ramo il client rinfrescava, riprovava, concludeva «account
   * non accettato» e tornava al login — dove Keycloak dice sì, perché il realm
   * e la persona esistono ancora. Da lì: app, query, rifiuto, login, per
   * sempre. Chi guarda vedeva un'app che lampeggia, e nginx un URL che cresce
   * a ogni giro finché non lo rifiuta con un 414.
   *
   * Senza questa funzione il rifiuto resta un errore mostrato come gli altri:
   * meglio una frase sola che un ciclo.
   */
  onTenantSuspended?: (() => void) | undefined
  /** Transport failure (API or Keycloak unreachable). Already deduped: one call per `dedupeMs`. */
  onNetworkError: (error: Error, info: { operation?: string | undefined }) => void
  /** Any other GraphQL error. Deduped per message. */
  onGraphQLError: (message: string, info: GraphQLErrorInfo) => void
  clientLogger?: ClientLogger
  /** Window in which repeated identical notifications are collapsed (N failing queries → 1 toast). */
  dedupeMs?: number
  /**
   * Come si traduce la chiave di un errore. Senza, i messaggi restano quelli del server.
   *
   * The error link needs it too: GraphQL errors that arrive inside a non-2xx
   * response (a `ServerError`) never pass through the i18n link, which only
   * sees results, so the link translates them itself with the same rule.
   */
  traduciErrore?: TraduciErrore | undefined
}

export interface CreateApolloClientOptions extends ErrorLinkOptions {
  uri: string
  getToken: () => string | undefined
  defaultOptions?: ApolloClient.DefaultOptions
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

/** Il codice che l'API usa per un tenant sospeso (`auth/resolveAuth.ts`). */
export const TENANT_SUSPENDED_CODE = 'TENANT_SUSPENDED'

function codici(errors: unknown): string[] {
  if (!Array.isArray(errors)) return []
  return (errors as readonly { extensions?: Record<string, unknown> }[])
    .map((e) => e.extensions?.['code'])
    .filter((c): c is string => typeof c === 'string')
}

/**
 * Il tenant sospeso, nelle DUE forme in cui il rifiuto può arrivare: errore
 * GraphQL combinato, o `ServerError` quando il media type non è quello
 * GraphQL. La stessa doppia lettura di UNAUTHORIZED qui sotto — mancarne una
 * rimetterebbe il ciclo.
 */
function isTenantSuspended(error: unknown): boolean {
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.some((e) => e.extensions?.['code'] === TENANT_SUSPENDED_CODE)
  }
  if (ServerError.is(error)) {
    try {
      const body: unknown = JSON.parse(error.bodyText)
      return codici((body as { errors?: unknown }).errors).includes(TENANT_SUSPENDED_CODE)
    } catch { return false }
  }
  return false
}

function resultHasTenantSuspended(result: ApolloLink.Result): boolean {
  return codici((result as { errors?: unknown }).errors).includes(TENANT_SUSPENDED_CODE)
}

/** One GraphQL error as the link reports it: the fields it reads, nothing more. */
interface ReportedGraphQLError {
  message:     string
  path?:       readonly (string | number)[] | undefined
  extensions?: Record<string, unknown> | undefined
}

/**
 * THE GRAPHQL ERRORS INSIDE A NON-2xx RESPONSE (D77, tour of 23 Sep 2026).
 *
 * `HttpLink` reads the body of a non-2xx response only when its media type is
 * `application/graphql-response+json`; with any other type it raises a
 * `ServerError` and leaves the body unread. A validation failure — HTTP 400
 * GRAPHQL_VALIDATION_FAILED with `{"errors":[…]}` — arrived that way and was
 * treated as a NETWORK error: deduped under the single network key, and
 * remembered as "already shown", so the page calling `showError` stayed
 * silent. The user pressed Save, saw «Loading…», then nothing.
 *
 * Here the body is read: when it parses into GraphQL `errors`, those are what
 * the server said, and they are reported like any other GraphQL error. A body
 * that is not GraphQL (an HTML page from a proxy, an empty 502) returns null
 * and stays a network error.
 */
export function graphQLErrorsInServerError(error: unknown): ReportedGraphQLError[] | null {
  if (!ServerError.is(error)) return null
  let body: unknown
  try {
    body = JSON.parse(error.bodyText)
  } catch {
    // Not JSON: a transport-level failure, reported as such by the caller.
    return null
  }
  const errors = (body as { errors?: unknown } | null)?.errors
  if (!Array.isArray(errors)) return null
  const reported = (errors as unknown[]).filter((e): e is ReportedGraphQLError =>
    typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string')
  return reported.length > 0 ? reported : null
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
            // Sospeso DOPO il rinfresco (per esempio sospeso proprio adesso):
            // è una frase, non un ritorno al login.
            if (resultHasTenantSuspended(result)) {
              logger.warn('tenant suspended: stopping here', { operation: operation.operationName })
              o.onTenantSuspended?.()
            } else if (hasUnauthorized(result)) {
              logger.error('UNAUTHORIZED after token refresh', { operation: operation.operationName })
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
          logger.error('Token refresh failed (network)', { operation: operation.operationName, message: error.message })
          if (once(NETWORK_DEDUPE_KEY)) o.onNetworkError(error, { operation: operation.operationName })
        }
        observer.error(error)
      },
    )
    return () => { cancelled = true; sub?.unsubscribe() }
  })
}

/**
 * GLI ERRORI GIÀ MOSTRATI (verifica «Cosa resta cablato», dopo l'ondata 7).
 *
 * Il link degli errori mostra ogni errore GraphQL e di rete, tradotto nella
 * lingua di chi guarda. Le pagine che lo mostravano di nuovo nel loro
 * `onError` facevano comparire due avvisi per lo stesso errore. Qui si
 * ricordano i messaggi appena mostrati, così una pagina chiede
 * `wasNotifiedCentrally(e)` e non ripete. Un errore GraphQL passa sempre dal
 * link: è mostrato per costruzione.
 */
const recentlyNotified = new Map<string, number>()
const NOTIFIED_MEMORY_MS = 30_000

function rememberNotified(message: string): void {
  const now = Date.now()
  for (const [m, at] of recentlyNotified) if (now - at > NOTIFIED_MEMORY_MS) recentlyNotified.delete(m)
  recentlyNotified.set(message, now)
}

export function wasNotifiedCentrally(error: unknown): boolean {
  if (CombinedGraphQLErrors.is(error)) return true
  // A ServerError whose body carries GraphQL errors: the link reported each of
  // them (D77), so the page must not add a second, generic toast.
  if (graphQLErrorsInServerError(error) !== null) return true
  const message = error instanceof Error ? error.message
    : typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : null
  if (message === null) return false
  const at = recentlyNotified.get(message)
  return at !== undefined && Date.now() - at <= NOTIFIED_MEMORY_MS
}

export function createErrorLink(o: ErrorLinkOptions): ErrorLink {
  const logger = o.clientLogger ?? consoleLogger
  const once   = createDeduper(o.dedupeMs ?? DEFAULT_DEDUPE_MS)

  /** One GraphQL error, reported the same way whichever form it arrived in. */
  const reportGraphQLError = ({ message, path, extensions }: ReportedGraphQLError, operationName: string | undefined) => {
    const code = typeof extensions?.['code'] === 'string' ? extensions['code'] : undefined
    logger.error(`GraphQL error: ${message}`, {
      code,
      path:      path as unknown as Record<string, unknown> | undefined,
      operation: operationName,
    })
    rememberNotified(message)
    if (once(`gql:${message}`)) o.onGraphQLError(message, { code, path, operation: operationName })
  }

  return new ErrorLink(({ error, operation, forward }) => {
    /*
     * IL TENANT SOSPESO SI GUARDA PRIMA DI TUTTO.
     * Arriva come un 401 e somiglia a un token scaduto, ma rinfrescare non
     * serve: il token è buono, è il tenant che è chiuso. Questo ramo sta sopra
     * gli altri perché sotto c'è il rinfresco, e il rinfresco qui è il primo
     * passo del ciclo infinito.
     */
    if (isTenantSuspended(error)) {
      logger.warn('tenant suspended: no refresh, no login', { operation: operation.operationName })
      o.onTenantSuspended?.()
      return
    }
    // Stessa decisione per le due forme in cui UNAUTHORIZED può arrivare.
    if (isUnauthorizedServerError(error)) {
      logger.warn('UNAUTHORIZED arrived as a ServerError (content type is not GraphQL): refreshing anyway', {
        operation: operation.operationName,
      })
      return retryAfterRefresh(o, once, logger, operation, forward)
    }
    /*
     * The GraphQL errors, in either form: a combined error (already translated
     * by the i18n link, which sits inside this one) or the body of a non-2xx
     * response (D77), which never reached the i18n link and is translated here
     * with the same rule.
     */
    const graphQLErrors: readonly ReportedGraphQLError[] | null = CombinedGraphQLErrors.is(error)
      ? error.errors
      : graphQLErrorsInServerError(error)?.map((e) => (o.traduciErrore ? conFrase(e, o.traduciErrore) : e)) ?? null
    if (graphQLErrors) {
      const unauthorized = graphQLErrors.some((e) => e.extensions?.['code'] === 'UNAUTHORIZED')
      if (unauthorized) {
        return retryAfterRefresh(o, once, logger, operation, forward)
      }
      graphQLErrors.forEach((e) => reportGraphQLError(e, operation.operationName))
      return
    }

    logger.error(`Network error: ${error.message}`, { operation: operation.operationName })
    rememberNotified(error.message)
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
function conPezziTradotti(params: Record<string, string | number>, translate: TraduciErrore): Record<string, string | number> {
  const fuori: Record<string, string | number> = { ...params }
  for (const [nome, valore] of Object.entries(params)) {
    if (!nome.endsWith('Key') || typeof valore !== 'string') continue
    fuori[nome.slice(0, -3)] = translate(valore, params) ?? valore
  }
  return fuori
}

/**
 * One error with its key turned into the sentence. Shared by the i18n link
 * (errors inside a result) and the error link (errors inside the body of a
 * `ServerError`, D77): one rule, whichever way the error arrived.
 */
function conFrase<E extends { message: string; extensions?: unknown }>(e: E, translate: TraduciErrore): E {
  const i18n = (e.extensions as ErroreConChiave['extensions'])?.i18n
  if (!i18n || typeof i18n.key !== 'string') return e
  const params = conPezziTradotti((i18n.params ?? {}) as Record<string, string | number>, translate)
  const frase = translate(i18n.key, params)
  return frase === null ? e : { ...e, message: frase }
}

function conFrasi(result: ApolloLink.Result, translate: TraduciErrore): ApolloLink.Result {
  const errors = (result as { errors?: ErroreConChiave[] }).errors
  if (!errors || errors.length === 0) return result
  return {
    ...result,
    errors: errors.map((e) => conFrase(e, translate)),
  } as ApolloLink.Result
}

export function createI18nLink(translate: TraduciErrore): ApolloLink {
  return new ApolloLinkClass((operation, forward) =>
    new Observable<ApolloLink.Result>((observer) => {
      const sub = forward(operation).subscribe({
        next:     (result) => observer.next(conFrasi(result, translate)),
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
  if (!uri) throw new Error('createApolloClient: "uri" is missing (VITE_API_URL)')
  const httpLink = new HttpLink({ uri })
  /*
    L'ORDINE CONTA: il link che traduce sta DENTRO quello che segnala, così la
    frase è gia nella lingua giusta quando `ErrorLink` costruisce l'errore che
    le pagine vedono (e quando lo passa a `onGraphQLError`, che fa il toast).
  */
  const catena = traduciErrore
    ? [createErrorLink({ ...linkOptions, traduciErrore }), createI18nLink(traduciErrore), createAuthLink(getToken).concat(httpLink)]
    : [createErrorLink(linkOptions), createAuthLink(getToken).concat(httpLink)]
  return new ApolloClient({
    link:  from(catena),
    cache: new InMemoryCache(typePolicies ? { typePolicies } : undefined),
    ...(defaultOptions ? { defaultOptions } : {}),
  })
}

/**
 * SE UN ERRORE PORTA UNA CHIAVE PRECISA.
 *
 * Serve quando una pagina non deve solo mostrare l'errore, ma FARE qualcosa:
 * il caso che l'ha richiesta è il modulo di catalogo ripubblicato mentre
 * qualcuno lo compilava (ondata 8) — lì la pagina deve anche buttare le
 * risposte e ricaricare il modulo nuovo.
 *
 * Si guarda la CHIAVE e non il messaggio: il messaggio è prosa e cambia con la
 * lingua, la chiave è il contratto fra API e client.
 */
/**
 * IL CAMPO che un rifiuto del modulo accusa, se lo dice.
 *
 * I rifiuti dei moduli portano nei `params` sia `field` (l'etichetta, che
 * entra nella frase) sia `name` (il nome interno del campo). Il nome serve a
 * chi disegna il modulo per accendere l'errore ACCANTO alla casella giusta:
 * prima il messaggio arrivava solo come avviso all'angolo, spariva dopo pochi
 * secondi e nessun campo veniva marcato — su un modulo lungo si doveva
 * indovinare quale (revisione del 17 set 2026).
 *
 * `null` quando il rifiuto non riguarda un campo (un tetto, una revisione
 * cambiata): il chiamante allora mostra solo l'avviso, come prima.
 */
export function errorFieldName(error: unknown): string | null {
  for (const e of erroriDi(error)) {
    const params = e?.extensions?.i18n?.params
    if (params && typeof params === 'object') {
      const nome = (params as Record<string, unknown>)['name']
      if (typeof nome === 'string' && nome.trim() !== '') return nome
    }
  }
  return null
}

/**
 * The errors to look into: those of a combined error, those inside the body of
 * a `ServerError` (D77: the same errors, arrived with a non-2xx status and a
 * media type `HttpLink` does not read), or the error itself.
 */
function erroriDi(error: unknown): ErroreConChiave[] {
  const nelCorpo = graphQLErrorsInServerError(error)
  if (nelCorpo) return nelCorpo as ErroreConChiave[]
  const errori = (error as { errors?: ErroreConChiave[] } | null)?.errors
  return Array.isArray(errori) ? errori : [error as ErroreConChiave]
}

export function errorHasKey(error: unknown, key: string): boolean {
  return erroriDi(error).some((e) => {
    const chiave = e?.extensions?.i18n?.key
    return typeof chiave === 'string' && chiave === key
  })
}
