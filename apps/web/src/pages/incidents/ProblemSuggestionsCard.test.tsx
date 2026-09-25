/**
 * THE PROBLEMS STILL OPEN ON THE INCIDENT'S CIs, on their own card (owner, 25 Sep 2026).
 *
 * What these pin:
 *  - each suggestion says why it is there (the incident's CIs it affects) and its workaround;
 *    a known error says so, any other problem shows its step as the workflow names it;
 *  - «Link» is the operator's: only who may link sees it, and a click links this problem to
 *    this incident and reads both the incident and the suggestions again, so the problem
 *    leaves this card for the linked tickets;
 *  - a failed link says so; a failed read says why; nothing open says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

const state = vi.hoisted(() => ({ mutationOpts: undefined as unknown }))

vi.mock('@apollo/client/react', async () => {
  const m = (await import('@/test/apolloFinto')).moduloApollo()
  return {
    ...m,
    useMutation: (doc: unknown, opts: unknown) => {
      state.mutationOpts = opts
      return (m.useMutation as (d: unknown, o: unknown) => unknown)(doc, opts)
    },
  }
})
vi.mock('@/hooks/useWorkflowSteps', () => ({
  useWorkflowSteps: () => ({ labelFor: (s: string) => ({ documentato: 'Documented', in_analisi: 'Under investigation' } as Record<string, string>)[s] ?? s }),
}))
const showError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/showError', () => ({ showError, errorMessage: (e: unknown) => String(e) }))

const { ProblemSuggestionsCard } = await import('./ProblemSuggestionsCard')

const SUGGESTIONS = [
  { id: 'p1', number: 'PRB0000044', title: 'Picchi di CPU', status: 'documentato', knownError: true, workaround: 'Riavviare il pool delle connessioni',
    cis: [{ id: 'd1', name: 'DB-CRM' }, { id: 's2', name: 'SRV-020' }] },
  { id: 'p2', number: 'PRB0000051', title: 'Lentezza del portale', status: 'in_analisi', knownError: false, workaround: null,
    cis: [{ id: 's2', name: 'SRV-020' }] },
]
const mount = (canLink = true) => renderWithProviders(<ProblemSuggestionsCard incidentId="inc-1" canLink={canLink} />)

beforeEach(() => {
  apolloFinto.reset()
  showError.mockReset()
  apolloFinto.risposte['IncidentProblemSuggestions'] = { incidentProblemSuggestions: SUGGESTIONS }
})

describe('ProblemSuggestionsCard', () => {
  it('each suggestion: why it is there and its workaround; a known error says so, another problem its step', () => {
    mount()
    const [first, second] = screen.getAllByRole('listitem')
    expect(first).toHaveTextContent('PRB0000044')
    expect(first).toHaveTextContent('Known error')
    // The known error's step would only say it again.
    expect(first).not.toHaveTextContent('Documented')
    expect(first).toHaveTextContent('On DB-CRM, SRV-020')
    expect(first).toHaveTextContent('Workaround: Riavviare il pool delle connessioni')
    expect(second).not.toHaveTextContent('Known error')
    expect(second).toHaveTextContent('Under investigation')
    expect(second).not.toHaveTextContent('Workaround:')
    expect(screen.getByRole('link', { name: 'Picchi di CPU' })).toHaveAttribute('href', '/problems/p1')
  })

  it('«Link» links this problem to this incident and reads both lists again: the problem moves to the linked tickets', async () => {
    const { user } = mount()
    await user.click(screen.getAllByRole('button', { name: 'Link' })[0]!)
    expect(apolloFinto.chiamata('LinkIncidentToProblem')).toEqual({ problemId: 'p1', incidentId: 'inc-1' })
    expect(state.mutationOpts).toMatchObject({ refetchQueries: ['GetIncident', 'IncidentProblemSuggestions'], awaitRefetchQueries: true })
    expect(showError).not.toHaveBeenCalled()
  })

  it('only who may link sees «Link»', () => {
    mount(false)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Link' })).toBeNull()
  })

  it('a refused link says so', async () => {
    apolloFinto.esiti['LinkIncidentToProblem'] = { error: new Error('forbidden') }
    const { user } = mount()
    await user.click(screen.getAllByRole('button', { name: 'Link' })[0]!)
    expect(showError).toHaveBeenCalledWith(expect.any(Error), 'Linking the problem failed: forbidden')
  })

  it('nothing open on the CIs says so; a failed read says why', () => {
    apolloFinto.risposte['IncidentProblemSuggestions'] = { incidentProblemSuggestions: [] }
    const first = mount()
    expect(screen.getByText('No problem is open on this incident\'s CIs.')).toBeInTheDocument()
    first.unmount()
    apolloFinto.erroriQuery['IncidentProblemSuggestions'] = new Error('neo4j down')
    mount()
    expect(screen.getByRole('alert')).toHaveTextContent('The problems open on this incident\'s CIs could not be read: neo4j down')
  })
})
