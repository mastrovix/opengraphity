/**
 * Creating a problem (tour of 23 Sep 2026):
 *  - after the creation the app opens the NEW problem, as it does for a new
 *    change — it returned to the list, and the work starts on the detail;
 *  - the team is chosen among the SUPPORT teams, in a searchable picker
 *    (D10): the owner teams and the Change Manager team are not offered;
 *  - a team picked in the form is assigned right after the creation.
 *
 * The data hooks are replaced by controllable fakes (their own tests cover
 * the queries); the page's own queries and mutations go through the fake
 * Apollo, answered by operation name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { PriorityMatrix } from '@/lib/priority'
import type { SlaCoverageDecision } from '@/hooks/useSlaCoverageCheck'
import { CreateProblemPage } from './CreateProblemPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const state = vi.hoisted(() => ({
  sla: vi.fn<(input: unknown) => Promise<SlaCoverageDecision>>(),
}))

const MATRIX: PriorityMatrix = {
  impacts: ['low', 'medium', 'high'],
  urgencies: ['low', 'medium', 'high'],
  priorities: ['low', 'medium', 'high'],
  cells: [
    { key: 'medium|medium', inputs: ['medium', 'medium'], value: 'medium' },
  ],
}

vi.mock('@/hooks/usePriorityMatrix', () => ({ usePriorityMatrix: () => ({ matrix: MATRIX, loading: false, error: null }) }))
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => ({ values: [], loading: false, error: null }) }))
vi.mock('@/hooks/useTicketCIExclusions', () => ({ useTicketCIExclusions: () => ({ excluded: [], error: undefined }) }))
vi.mock('@/hooks/useSlaCoverageCheck', () => ({ useSlaCoverageCheck: () => state.sla }))
vi.mock('@/components/ticket/customFields/customFields', async (orig) => ({
  ...(await orig<typeof import('@/components/ticket/customFields/customFields')>()),
  useCreationCustomFieldDefs: () => ({ defs: [], loading: false, error: undefined }),
}))

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetTeamChoices'] = { teams: [
    { id: 'sup-1', name: 'SUP_Database Platform', type: 'support', isChangeManager: false },
    { id: 'own-1', name: 'OWN_Billing Owner', type: 'owner', isChangeManager: false },
    { id: 'cmo', name: 'Change Management Office', type: 'support', isChangeManager: true },
  ] }
  apolloFinto.esiti['CreateProblem'] = { data: { createProblem: { id: 'prb-7', title: 'Leak' } } }
  state.sla.mockReset().mockResolvedValue('covered')
  vi.mocked(toast.success).mockClear()
})

const render = () => renderWithProviders(<CreateProblemPage />, { route: '/problems/new' })

describe('CreateProblemPage', () => {
  it('offers the support teams only, assigns the chosen one, and opens the new problem', async () => {
    const { user } = render()
    await user.type(screen.getByPlaceholderText('E.g. Memory leak in the authentication service'), 'Leak')
    await user.type(screen.getByPlaceholderText('Describe the problem and its impact...'), 'Memory grows')

    const teamBox = screen.getByRole('combobox', { name: 'Team' })
    await user.click(teamBox)
    expect(await screen.findByRole('option', { name: 'SUP_Database Platform' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'OWN_Billing Owner' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Change Management Office' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'SUP_Database Platform' }))

    await user.click(screen.getByRole('button', { name: 'Create the problem' }))
    await waitFor(() => expect(apolloFinto.chiamata('CreateProblem')).toBeDefined())
    expect(apolloFinto.chiamata('CreateProblem')).toMatchObject({ input: { title: 'Leak', impact: 'medium', urgency: 'medium', description: 'Memory grows' } })
    expect(state.sla).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'problem', teamId: 'sup-1', teamName: 'SUP_Database Platform' }))
    await waitFor(() => expect(apolloFinto.chiamata('AssignProblemToTeam')).toEqual({ problemId: 'prb-7', teamId: 'sup-1' }))
    expect(toast.success).toHaveBeenCalledWith('Problem created')
    await attendiURL('/problems/prb-7')
  })

  it('without a team nothing is assigned, and the new problem still opens', async () => {
    const { user } = render()
    await user.type(screen.getByPlaceholderText('E.g. Memory leak in the authentication service'), 'Leak')
    await user.type(screen.getByPlaceholderText('Describe the problem and its impact...'), 'Memory grows')
    await user.click(screen.getByRole('button', { name: 'Create the problem' }))
    await attendiURL('/problems/prb-7')
    expect(apolloFinto.chiamata('AssignProblemToTeam')).toBeUndefined()
  })
})
