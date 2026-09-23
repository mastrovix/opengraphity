/**
 * CREATING AN INCIDENT WHILE THE SERVER IS STILL WORKING.
 *
 * The two sibling files cover what the form offers and what it sends. This
 * one covers two moments in between, both met by an agent in a hurry:
 *  - the tenant's priority matrix is read again while the form is open (it is
 *    `cache-and-network`: the cache answers first, the network after). The
 *    impact and urgency the agent already chose must survive that second
 *    answer — only an empty choice starts from the median of the scale;
 *  - while the creation is on its way the button says so and cannot be
 *    pressed again, or a double click opens two incidents for one outage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { inFlight, resetInFlight } from '@/test/apolloInFlight'
import { CreateIncidentPage } from './CreateIncidentPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))
// The rules, categories, exclusions, SLA check and AI card have their own tests.
vi.mock('@/hooks/useFormFieldRules', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useFormFieldRules')>()),
  useFormFieldRules: () => ({ rules: {}, error: undefined }),
}))
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => ({ values: ['network'], loading: false, error: null }) }))
vi.mock('@/hooks/useTicketCIExclusions', () => ({ useTicketCIExclusions: () => ({ excluded: [], error: undefined }) }))
vi.mock('@/hooks/useSlaCoverageCheck', () => ({ useSlaCoverageCheck: () => async () => 'covered' }))
vi.mock('@/components/ticket/customFields/customFields', async (orig) => ({
  ...(await orig<typeof import('@/components/ticket/customFields/customFields')>()),
  useCreationCustomFieldDefs: () => ({ defs: [], loading: false, error: undefined }),
}))
vi.mock('@/components/TriageSuggestionCard', () => ({ TriageSuggestionCard: () => null }))

const matrix = () => ({ priorityMatrix: {
  kind: 'priority', inputs: ['impact', 'urgency'], output: 'priority',
  inputValues: [['low', 'medium', 'high'], ['low', 'medium', 'high']],
  outputValues: ['low', 'medium', 'high', 'critical'],
  cells: [
    { key: 'medium|medium', inputs: ['medium', 'medium'], value: 'medium' },
    { key: 'high|low', inputs: ['high', 'low'], value: 'high' },
  ],
} })

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
  apolloFinto.risposte['GetPriorityMatrix'] = matrix()
  apolloFinto.risposte['GetTeams'] = { teams: [] }
  apolloFinto.risposte['GetTeamChoices'] = { teams: [] }
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [{ id: 'ci-1', name: 'db-prod-01', type: 'database', environment: 'production', supportGroup: null }] } }
})

/** The pressed button of a scale: the scales are the first and second group of level buttons. */
const pressed = (scale: 0 | 1) => screen.getAllByRole('group')[scale]!.querySelector('[aria-pressed="true"]')?.textContent

describe('CreateIncidentPage: while the server is still working', () => {
  it('a second answer of the matrix keeps the impact and urgency already chosen', async () => {
    const { user } = renderWithProviders(<CreateIncidentPage />, { route: '/incidents/new' })
    // The median of each scale is where an untouched form starts.
    expect(pressed(0)).toBe('medium')
    expect(pressed(1)).toBe('medium')
    await user.click(screen.getAllByRole('button', { name: 'high' })[0]!)
    await user.click(screen.getAllByRole('button', { name: 'low' })[1]!)
    // The network answers again, with the same matrix in a new object.
    apolloFinto.risposte['GetPriorityMatrix'] = matrix()
    await user.type(screen.getByRole('textbox', { name: /production database is unreachable/ }), 'DB down')
    expect(pressed(0)).toBe('high')
    expect(pressed(1)).toBe('low')
    expect(screen.getByText('P2')).toBeInTheDocument()
  })

  it('while the incident is being created the button says so and takes no second click', async () => {
    inFlight.add('CreateIncident')
    const { user } = renderWithProviders(<CreateIncidentPage />, { route: '/incidents/new' })
    await user.type(screen.getByRole('textbox', { name: /production database is unreachable/ }), 'DB down')
    await user.selectOptions(screen.getByLabelText(/Category/), 'network')
    await user.type(screen.getByRole('textbox', { name: /Describe what is happening/ }), 'Timeouts')
    await user.type(screen.getByPlaceholderText('Search by name...'), 'db')
    await user.click(await screen.findByRole('button', { name: /db-prod-01/ }))
    // Everything required is there: only the creation in flight holds the button.
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Create the incident' })).not.toBeInTheDocument()
  })
})
