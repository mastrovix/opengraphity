/**
 * LA FRASE DI UN ERRORE, nella lingua di chi guarda.
 *
 * L'API manda un `message` inglese e stabile (log, metriche, integrazioni) e —
 * quando l'errore riguarda la persona davanti allo schermo — una CHIAVE in
 * `extensions.i18n`. Questo link la risolve prima che l'errore arrivi alle
 * pagine, così le decine di `onError: (e) => toast.error(e.message)` che
 * esistono già si trovano il messaggio tradotto senza essere toccate.
 *
 * Il difetto che chiude: l'API non sa in che lingua guarda chi legge, e per
 * mesi la risposta è stata scrivere i messaggi in italiano — che in
 * un'interfaccia inglese restavano italiani.
 */
import { describe, it, expect } from 'vitest'
import { ApolloClient, ApolloLink, InMemoryCache, from, gql } from '@apollo/client/core'
import { Observable } from '@apollo/client/utilities'
import { CombinedGraphQLErrors } from '@apollo/client/errors'
import { createI18nLink } from '../apollo.js'

const QUERY = gql`query Q { x }`

/** Una risposta finta col corpo che manderebbe l'API. */
function finto(errors: unknown[]): ApolloLink {
  return new ApolloLink(() =>
    new Observable<ApolloLink.Result>((o) => {
      o.next({ data: null, errors } as unknown as ApolloLink.Result)
      o.complete()
    }))
}

/** Il messaggio come lo vede una pagina: `e.message` dentro `onError`. */
async function primoErrore(errors: unknown[]): Promise<string> {
  const client = new ApolloClient({
    link:  from([createI18nLink(traduci), finto(errors)]),
    cache: new InMemoryCache(),
  })
  try {
    await client.query({ query: QUERY, fetchPolicy: 'no-cache' })
    throw new Error('la query doveva fallire')
  } catch (e) {
    if (!CombinedGraphQLErrors.is(e)) throw e
    return e.errors[0]!.message
  }
}

const traduci = (key: string, params?: Record<string, string | number>) =>
  key === 'errors.ola.responseMinutes' ? 'I minuti di presa in carico devono essere maggiori di zero.'
    : key === 'errors.riskBand.duplicate' ? `La fascia «${String(params?.['band'])}» compare due volte.`
      : null

describe('createI18nLink', () => {
  it('la chiave diventa la frase: il messaggio del server viene sostituito', async () => {
    const messaggio = await primoErrore([
      { message: 'responseMinutes must be > 0', extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.ola.responseMinutes' } } },
    ])
    expect(messaggio).toBe('I minuti di presa in carico devono essere maggiori di zero.')
  })

  it('i parametri arrivano alla frase: sono DATI, non prosa', async () => {
    const messaggio = await primoErrore([
      { message: 'Band "alta" appears twice.', extensions: { i18n: { key: 'errors.riskBand.duplicate', params: { band: 'alta' } } } },
    ])
    expect(messaggio).toBe('La fascia «alta» compare due volte.')
  })

  /**
   * Un'API più nuova del bundle: una chiave che questo client non conosce. Non
   * si nasconde e non si mostra una chiave grezza — resta il messaggio del
   * server, che è vero e leggibile (e inglese, che è la lingua del prodotto).
   */
  it('una chiave che il bundle non conosce lascia il messaggio del server', async () => {
    const messaggio = await primoErrore([
      { message: 'something the client cannot name yet', extensions: { i18n: { key: 'errors.delFuturo' } } },
    ])
    expect(messaggio).toBe('something the client cannot name yet')
  })

  it("un errore senza chiave non viene toccato: non tutti gli errori sono per una persona", async () => {
    const messaggio = await primoErrore([
      { message: 'Cannot query field "nope" on type "Query".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
    ])
    expect(messaggio).toBe('Cannot query field "nope" on type "Query".')
  })
})
