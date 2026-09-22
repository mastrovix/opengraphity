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
 */
import { vi } from 'vitest'

type Doc = { definitions: Array<{ kind: string; name?: { value: string } }> }
type Esito = { data?: unknown; error?: Error }
type Opts = { variables?: Record<string, unknown>; skip?: boolean; onCompleted?: (d: unknown) => void; onError?: (e: Error) => void }

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
        loading: false, error, refetch: apolloFinto.refetch, previousData: undefined,
        fetchMore: vi.fn(), networkStatus: 7,
      }
    },
    useLazyQuery: (doc: Doc) => {
      const nome = nomeOperazione(doc)
      const run = vi.fn(async (o: Opts = {}) => { registra(nome, o.variables); return { data: dati(nome, o.variables) } })
      return [run, { data: dati(nome), loading: false, called: true }]
    },
    useMutation: (doc: Doc, opts: Opts = {}) => {
      const nome = nomeOperazione(doc)
      // One stable function per mutation: a re-render must not lose the calls.
      const fn = mutazioni.get(nome) ?? vi.fn()
      mutazioni.set(nome, fn)
      fn.mockImplementation(async (o: Opts = {}) => {
        registra(nome, o.variables)
        const esito = apolloFinto.esiti[nome] ?? { data: {} }
        if (esito.error) {
          const onError = o.onError ?? opts.onError
          if (onError) { onError(esito.error); return { errors: [esito.error] } }
          throw esito.error
        }
        ;(o.onCompleted ?? opts.onCompleted)?.(esito.data)
        return { data: esito.data }
      })
      return [fn, { loading: false, data: undefined, error: undefined }]
    },
    useApolloClient: () => ({ query: apolloFinto.query, mutate: apolloFinto.mutate, refetchQueries: vi.fn(), cache: { evict: vi.fn(), gc: vi.fn() } }),
    useSubscription: () => ({ data: undefined }),
  }
}
