/**
 * THE SERVER HAS NOT ANSWERED YET: waiting states for the fake Apollo.
 *
 * `apolloFinto` answers every operation at once, so a page under test never
 * shows what it shows while it waits: the placeholders of a first load, a
 * button that says «Saving…» and refuses a second click, a dialog that cannot
 * be dismissed while a bulk action runs. Those are promises the product makes
 * (a double click must not fire two transitions), so they deserve tests. This
 * module wraps the fake and changes nothing else about it:
 *
 *   vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())
 *   inFlight.add('UpdateIncident')   // reports `loading: true` (a query has no data yet)
 *   hold('ResolveIncident')          // its calls do not settle until release('ResolveIncident')
 *   answerEach('ResolveIncident', (v) => v?.['id'] === 'inc-2' ? { error: new Error('no') } : { data: {} })
 *                                    // one answer per call, when calls of one batch must differ
 *
 * Two more things work as in Apollo Client 4 (checked on 4.3.1):
 *  - `onCompleted` receives the options of the call as its second argument,
 *    variables included — a page that reads them («assigned to whom?») sees
 *    them, where `apolloFinto` passes only the data;
 *  - a lazy query answered with `apolloFinto.erroriQuery[name]` REJECTS, it
 *    does not resolve with `{ error }`. The rejection reaches whoever chains
 *    on the promise; the fake never leaves one unhandled by itself.
 */
import { apolloFinto, moduloApollo, nomeOperazione } from './apolloFinto'

type Base = ReturnType<typeof moduloApollo>
type Doc = Parameters<typeof nomeOperazione>[0]
type LazyOptions = { variables?: Record<string, unknown> }
interface MutationOptions {
  variables?: Record<string, unknown>
  onCompleted?: (data: unknown, options?: unknown) => void
  onError?: (error: Error, options?: unknown) => void
}

/** Operations still waiting for the server: `loading` is true, a query has no data. */
export const inFlight = new Set<string>()

const gates = new Map<string, { promise: Promise<void>; open: () => void }>()

type Outcome = { data?: unknown; error?: Error }
const outcomes = new Map<string, (variables: Record<string, unknown> | undefined) => Outcome>()

/** Each call of this mutation is answered by `decide(variables)` instead of `apolloFinto.esiti[name]`. */
export function answerEach(name: string, decide: (variables: Record<string, unknown> | undefined) => Outcome): void {
  outcomes.set(name, decide)
}

/** The calls of this operation wait until `release(name)`. */
export function hold(name: string): void {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  gates.set(name, { promise, open })
}

/** The server answers: the held calls of this operation go on. */
export function release(name: string): void {
  gates.get(name)?.open()
  gates.delete(name)
}

/** Nothing waits any more (call it in `beforeEach`). */
export function resetInFlight(): void {
  inFlight.clear()
  for (const gate of gates.values()) gate.open()
  gates.clear()
  outcomes.clear()
}

/** A rejection handed to whoever chains on it, never reported as unhandled because of the fake. */
function rejection(error: Error): PromiseLike<never> {
  return {
    then(onFulfilled, onRejected) {
      const next = Promise.reject(error).then(onFulfilled, onRejected)
      next.catch(() => {})
      return next
    },
  }
}

export function apolloModuleWithInFlight() {
  const base = moduloApollo()
  return {
    ...base,
    useQuery: (...args: Parameters<Base['useQuery']>) => {
      const result = base.useQuery(...args)
      return inFlight.has(nomeOperazione(args[0])) ? { ...result, data: undefined, loading: true } : result
    },
    useMutation: (doc: Doc, hookOptions: MutationOptions = {}) => {
      const name = nomeOperazione(doc)
      // `apolloFinto` returns a plain array: its items are typed here, as Apollo types them.
      const [mutate, result] = base.useMutation(doc, hookOptions) as unknown as [(options: MutationOptions) => Promise<unknown>, Record<string, unknown>]
      const execute = (options: MutationOptions = {}) => {
        const outcome = (async () => {
          await gates.get(name)?.promise
          // `apolloFinto` reads its answer synchronously when called: set right before, it is this call's.
          const decide = outcomes.get(name)
          if (decide) apolloFinto.esiti[name] = decide(options.variables)
          const onCompleted = options.onCompleted ?? hookOptions.onCompleted
          const merged = { ...hookOptions, ...options }
          return mutate(onCompleted ? { ...options, onCompleted: (data: unknown) => onCompleted(data, merged) } : options)
        })()
        // As Apollo 4 does (preventUnhandledRejection): a `void mutate()` nobody awaits is not an
        // unhandled rejection; whoever awaits it still gets the rejection.
        outcome.catch(() => {})
        return outcome
      }
      return [execute, { ...result, loading: inFlight.has(name) }] as const
    },
    useLazyQuery: (doc: Doc) => {
      const name = nomeOperazione(doc)
      const [run, result] = base.useLazyQuery(doc) as unknown as [(options: LazyOptions) => Promise<unknown>, Record<string, unknown>]
      const execute = (options: LazyOptions = {}) => {
        const error = apolloFinto.erroriQuery[name]
        if (!error) return run(options)
        ;(apolloFinto.chiamate[name] ??= []).push(options.variables)
        return rejection(error)
      }
      return [execute, { ...result, loading: inFlight.has(name) }] as const
    },
  }
}
