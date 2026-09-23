/**
 * A FAKE APOLLO FOR PAGE TESTS THAT ARE ABOUT BEHAVIOUR, NOT ABOUT THE WIRE.
 *
 * `MockedProvider` checks the exact query text and variables, which is right
 * when the test is about what goes over the network. For a page with eight
 * queries and five mutations, where the test is about what the page DOES with
 * the answers, it turns every test into a copy of the page's queries. This
 * fake answers by operation NAME:
 *
 *   vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
 *   apolloFinto.risposte['GetThings'] = { things: [...] }        // or (vars) => ({...})
 *   apolloFinto.esiti['CreateThing']  = { data: { createThing: { id: 'x' } } }  // or { error: new Error() }
 *   apolloFinto.chiamata('CreateThing') // → the variables of the last call
 *
 * A mutation calls its own `onCompleted`/`onError` as Apollo would, so the
 * page's reactions (toast, refetch, closing a panel) run too.
 *
 * AND IT FAILS AS APOLLO CLIENT 4 FAILS (tour of 23 Sep 2026). Apollo 4.3
 * (`react/hooks/useMutation.js`) calls `onError` and THEN rejects the promise
 * of `mutate`; a failed lazy query rejects too; a promise nobody awaits is
 * not an unhandled rejection (`preventUnhandledRejection`), one that is
 * awaited throws into the caller. This fake used to RESOLVE a failed mutation
 * with `{ errors }`: tests ran code after the await that the app never runs,
 * and a caller that awaited a refused mutation without a catch — an
 * unhandled rejection in the browser — passed. Now it does what Apollo does,
 * so such a caller fails its test run.
 */
import { vi } from 'vitest'

type Doc = { definitions: Array<{ kind: string; name?: { value: string } }> }
type Esito = { data?: unknown; error?: Error }
type Opts = { variables?: Record<string, unknown>; skip?: boolean; onCompleted?: (d: unknown, options?: unknown) => void; onError?: (e: Error, options?: unknown) => void }

export const nomeOperazione = (doc: Doc): string =>
  doc.definitions.find((d) => d.kind === 'OperationDefinition')?.name?.value ?? ''

export const apolloFinto = {
  /** Operation name → data, or a function of the variables. */
  risposte: {} as Record<string, unknown>,
  /** Operation name → error for a query. */
  erroriQuery: {} as Record<string, Error>,
  /** Mutation name → what it resolves to. Absent = `{ data: {} }`. */
  esiti: {} as Record<string, Esito>,
  /** Every call, per operation name. */
  chiamate: {} as Record<string, Array<Record<string, unknown> | undefined>>,
  refetch: vi.fn(async () => ({ data: {} })),
  query: vi.fn(),
  mutate: vi.fn(),
  reset() {
    this.risposte = {}; this.erroriQuery = {}; this.esiti = {}; this.chiamate = {}
    this.refetch.mockClear(); this.query.mockReset(); this.mutate.mockReset()
  },
  chiamata(nome: string): Record<string, unknown> | undefined {
    return this.chiamate[nome]?.at(-1)
  },
}

function registra(nome: string, variables?: Record<string, unknown>) {
  ;(apolloFinto.chiamate[nome] ??= []).push(variables)
}

/** Like Apollo's `preventUnhandledRejection`: the promise still rejects for whoever awaits it. */
function comeApollo<T>(promise: T): T {
  if (promise instanceof Promise) promise.catch(() => {})
  return promise
}

/** The refetch the pages get: the shared mock, protected as Apollo protects its own. */
const refetchComeApollo = (...args: unknown[]) => comeApollo((apolloFinto.refetch as (...a: unknown[]) => unknown)(...args))

function dati(nome: string, variables?: Record<string, unknown>): unknown {
  const r = apolloFinto.risposte[nome]
  return typeof r === 'function' ? (r as (v?: Record<string, unknown>) => unknown)(variables) : r
}

const mutazioni = new Map<string, ReturnType<typeof vi.fn>>()

export function moduloApollo() {
  return {
    useQuery: (doc: Doc, opts: Opts = {}) => {
      const nome = nomeOperazione(doc)
      if (!opts.skip) registra(nome, opts.variables)
      const error = apolloFinto.erroriQuery[nome]
      return {
        data: opts.skip || error ? undefined : dati(nome, opts.variables),
        loading: false, error, refetch: refetchComeApollo, previousData: undefined,
        fetchMore: vi.fn(), networkStatus: 7,
      }
    },
    useLazyQuery: (doc: Doc) => {
      const nome = nomeOperazione(doc)
      const run = vi.fn((o: Opts = {}) => comeApollo((async () => {
        registra(nome, o.variables)
        // A failed lazy query rejects in Apollo 4 (its result carries no `error` by default).
        const error = apolloFinto.erroriQuery[nome]
        if (error) throw error
        return { data: dati(nome, o.variables) }
      })()))
      return [run, { data: dati(nome), loading: false, called: true }]
    },
    useMutation: (doc: Doc, opts: Opts = {}) => {
      const nome = nomeOperazione(doc)
      // One stable function per mutation: a re-render must not lose the calls.
      const fn = mutazioni.get(nome) ?? vi.fn()
      mutazioni.set(nome, fn)
      fn.mockImplementation((o: Opts = {}) => comeApollo((async () => {
        registra(nome, o.variables)
        const esito = apolloFinto.esiti[nome] ?? { data: {} }
        const options = { ...opts, ...o }
        if (esito.error) {
          // Apollo Client 4: onError first, then the promise rejects.
          ;(o.onError ?? opts.onError)?.(esito.error, options)
          throw esito.error
        }
        ;(o.onCompleted ?? opts.onCompleted)?.(esito.data, options)
        return { data: esito.data }
      })()))
      return [fn, { loading: false, data: undefined, error: undefined }]
    },
    useApolloClient: () => ({ query: apolloFinto.query, mutate: apolloFinto.mutate, refetchQueries: vi.fn(), cache: { evict: vi.fn(), gc: vi.fn() } }),
    useSubscription: () => ({ data: undefined }),
  }
}
