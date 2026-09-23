/**
 * OPENING A PROBLEM: THE FORM BEFORE THE SEND.
 *
 * The main suite covers the happy path (team, creation, opening the new
 * problem). These tests pin what the form decides BEFORE anything is sent,
 * because each of those decisions, if it regressed, would create a problem
 * that is silently wrong:
 *  - the priority is DERIVED from impact × urgency through the customer's
 *    matrix, starting from the middle of the scale; a pair the matrix does not
 *    cover (or a matrix not loaded) must stop the creation and say why;
 *  - the category is optional, from the customer's vocabulary, and when
 *    chosen it travels with the problem AND with the SLA coverage check;
 *  - the SLA check can say "covered", "create anyway" (the problem carries
 *    the acknowledgement) or "go back" (nothing is created); if the check
 *    itself fails, nothing is created either, and the reason is shown;
 *  - the affected CIs are searched without the excluded types, picked and
 *    removed; the customer's required fields are checked first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within, fireEvent } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'
import type { PriorityMatrix } from '@/lib/priority'
import type { SlaCoverageDecision } from '@/hooks/useSlaCoverageCheck'
import type { CustomFieldDefView } from '@/components/ticket/customFields/customFields'

vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const fake = moduloApollo()
  return {
    ...fake,
    // A mutation can be made to be still running.
    useMutation: (doc: Parameters<typeof nomeOperazione>[0], opts?: Parameters<typeof fake.useMutation>[1]) => {
      const [mutate, result] = fake.useMutation(doc, opts)
      return [mutate, { ...result, loading: state.busy.has(nomeOperazione(doc)) }]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))

const MATRIX: PriorityMatrix = {
  impacts: ['low', 'medium', 'high'],
  urgencies: ['low', 'medium', 'high'],
  priorities: ['low', 'medium', 'high', 'critical'],
  cells: [
    { key: 'medium|medium', inputs: ['medium', 'medium'], value: 'medium' },
    { key: 'high|high', inputs: ['high', 'high'], value: 'critical' },
    { key: 'high|medium', inputs: ['high', 'medium'], value: 'high' },
    // A combination the customer has not filled in yet.
    { key: 'low|low', inputs: ['low', 'low'], value: null },
  ],
}

const state = vi.hoisted(() => ({
  matrix: null as PriorityMatrix | null,
  categories: { values: [] as string[], loading: false },
  excluded: [] as readonly string[] | undefined,
  defs: [] as CustomFieldDefView[],
  defsCategory: [] as Array<string | undefined>,
  sla: vi.fn<(input: unknown) => Promise<SlaCoverageDecision>>(),
  busy: new Set<string>(),
}))

vi.mock('@/hooks/usePriorityMatrix', () => ({ usePriorityMatrix: () => ({ matrix: state.matrix, loading: false, error: null }) }))
vi.mock('@/hooks/useEnumValues', () => ({ useEnumValues: () => ({ ...state.categories, error: null }) }))
vi.mock('@/hooks/useTicketCIExclusions', () => ({ useTicketCIExclusions: () => ({ excluded: state.excluded, error: undefined }) }))
vi.mock('@/hooks/useSlaCoverageCheck', () => ({ useSlaCoverageCheck: () => state.sla }))
vi.mock('@/components/ticket/customFields/customFields', async (orig) => ({
  ...(await orig<typeof import('@/components/ticket/customFields/customFields')>()),
  useCreationCustomFieldDefs: (_entity: string, category?: string) => {
    state.defsCategory.push(category)
    return { defs: state.defs, loading: false, error: undefined }
  },
}))

const { CreateProblemPage } = await import('./CreateProblemPage')

const LABELS = {
  impact:   { low: 'Low', medium: 'Medium', high: 'High' },
  urgency:  { low: 'Low', medium: 'Medium', high: 'High' },
  priority: { medium: 'Medium', high: 'High', critical: 'Critical' },
  category: { database: 'Database' },
  environment: { production: 'Production' },
}

const DB = { id: 'ci-db', name: 'orders-db', type: 'database', environment: 'production' }
const APP = { id: 'ci-app', name: 'orders-app', type: 'application' }

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  state.matrix = MATRIX
  state.categories = { values: [], loading: false }
  state.excluded = ['person']
  state.defs = []
  state.defsCategory = []
  state.busy.clear()
  state.sla.mockReset().mockResolvedValue('covered')
  apolloFinto.risposte['GetTeamChoices'] = { teams: [{ id: 'sup-1', name: 'SUP_Database Platform', type: 'support', isChangeManager: false }] }
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [DB, APP] } }
  apolloFinto.esiti['CreateProblem'] = { data: { createProblem: { id: 'prb-9', title: 'Leak' } } }
})

const page = () => renderWithProviders(withVocabularyLabels(<CreateProblemPage />, LABELS), { route: '/problems/new', path: '/problems/new' })

const level = (group: 'Impact' | 'Urgency', label: string) =>
  within(screen.getByRole('group', { name: new RegExp(`^${group}`) })).getByRole('button', { name: label })

/** The box showing the derived priority: its code and its label. */
const derived = () => screen.getByText('Priority (derived)').nextElementSibling as HTMLElement

const submit = () => screen.getByRole('button', { name: 'Create the problem' })

async function fillIn(user: ReturnType<typeof page>['user']) {
  await user.type(screen.getByLabelText(/^Title/), 'Leak')
  await user.type(screen.getByLabelText(/^Description/), 'Memory grows')
}

describe('CreateProblemPage — the priority is derived from the matrix', () => {
  it('impact and urgency start in the middle of the scale, and the priority follows the matrix with its code', async () => {
    const { user } = page()
    expect(level('Impact', 'Medium')).toHaveAttribute('aria-pressed', 'true')
    expect(level('Urgency', 'Medium')).toHaveAttribute('aria-pressed', 'true')
    expect(derived()).toHaveTextContent('P3Medium')
    await user.click(level('Impact', 'High'))
    expect(level('Impact', 'High')).toHaveAttribute('aria-pressed', 'true')
    expect(level('Impact', 'Medium')).toHaveAttribute('aria-pressed', 'false')
    expect(derived()).toHaveTextContent('P2High')
    await user.click(level('Urgency', 'High'))
    expect(derived()).toHaveTextContent('P1Critical')
  })

  it('a pair the matrix does not cover says so, and stops the creation with the reason', async () => {
    const { user } = page()
    await user.click(level('Impact', 'Low'))
    await user.click(level('Urgency', 'Low'))
    expect(derived()).toHaveTextContent('—to be filled in, in the matrix')
    await fillIn(user)
    await user.click(submit())
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/^The priority matrix does not cover the selected combination/))
    expect(state.sla).not.toHaveBeenCalled()
    expect(apolloFinto.chiamata('CreateProblem')).toBeUndefined()
  })

  it('while the matrix is not loaded no level is offered and nothing can be created', async () => {
    state.matrix = null
    const { user } = page()
    expect(within(screen.getByRole('group', { name: /^Impact/ })).queryAllByRole('button')).toHaveLength(0)
    expect(derived()).toHaveTextContent('—to be filled in, in the matrix')
    await fillIn(user)
    await user.click(submit())
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/^The priority matrix does not cover/))
    expect(apolloFinto.chiamata('CreateProblem')).toBeUndefined()
  })

  it('a matrix with no value on a scale leaves that level unchosen, and derives nothing', () => {
    state.matrix = { ...MATRIX, urgencies: [] }
    const { unmount } = page()
    expect(level('Impact', 'Medium')).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByRole('group', { name: /^Urgency/ })).queryAllByRole('button')).toHaveLength(0)
    expect(derived()).toHaveTextContent('—to be filled in, in the matrix')
    unmount()
    state.matrix = { ...MATRIX, impacts: [] }
    page()
    expect(within(screen.getByRole('group', { name: /^Impact/ })).queryAllByRole('button')).toHaveLength(0)
    expect(level('Urgency', 'Medium')).toHaveAttribute('aria-pressed', 'true')
    expect(derived()).toHaveTextContent('—to be filled in, in the matrix')
  })

  it('a matrix read again after the user picked a level keeps the user choice', async () => {
    const { user, rerender } = page()
    await user.click(level('Impact', 'High'))
    state.matrix = { ...MATRIX }
    rerender(withVocabularyLabels(<CreateProblemPage />, LABELS))
    expect(level('Impact', 'High')).toHaveAttribute('aria-pressed', 'true')
    expect(derived()).toHaveTextContent('P2High')
  })
})

describe('CreateProblemPage — the category', () => {
  it('while the categories load it says so', () => {
    state.categories = { values: [], loading: true }
    page()
    expect(screen.queryByRole('combobox', { name: 'Category' })).not.toBeInTheDocument()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('offers the customer categories by label, and the chosen one travels with the problem and the SLA check', async () => {
    state.categories = { values: ['database', 'network'], loading: false }
    const { user } = page()
    const select = screen.getByRole('combobox', { name: 'Category' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['-- Pick a category --', 'Database', 'network'])
    await user.selectOptions(select, 'database')
    // The custom fields of the opening form depend on the category.
    expect(state.defsCategory.at(-1)).toBe('database')
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateProblem')).toBeDefined())
    expect(state.sla).toHaveBeenCalledWith({
      entityType: 'problem', priority: 'medium', priorityLabel: 'Medium',
      category: 'database', categoryLabel: 'Database', teamId: null, teamName: null,
    })
    expect(apolloFinto.chiamata('CreateProblem')).toEqual({ input: {
      title: 'Leak', impact: 'medium', urgency: 'medium', category: 'database',
      description: 'Memory grows', affectedCIs: [], customFields: [],
    } })
  })

  it('a category without a label is named by its value in the SLA check; none chosen sends none', async () => {
    state.categories = { values: ['database', 'network'], loading: false }
    const { user } = page()
    expect(state.defsCategory.at(-1)).toBeUndefined()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'network')
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(state.sla).toHaveBeenCalledWith(expect.objectContaining({ category: 'network', categoryLabel: 'network' })))
  })

  it('without a category the SLA check asks for none, and the problem carries none', async () => {
    const { user } = page()
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateProblem')).toBeDefined())
    expect(state.sla).toHaveBeenCalledWith(expect.objectContaining({ category: null, categoryLabel: null }))
    expect(apolloFinto.chiamata('CreateProblem')!['input']).not.toHaveProperty('category')
  })
})

describe('CreateProblemPage — the SLA coverage check decides', () => {
  it('no policy, and the user creates it anyway: the problem carries the acknowledgement', async () => {
    state.sla.mockResolvedValue('accepted')
    const { user } = page()
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateProblem')).toMatchObject({ input: { acknowledgeNoSla: true } }))
    await attendiURL('/problems/prb-9')
  })

  it('a covered problem does not carry the acknowledgement', async () => {
    const { user } = page()
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateProblem')).toBeDefined())
    expect(apolloFinto.chiamata('CreateProblem')!['input']).not.toHaveProperty('acknowledgeNoSla')
  })

  it('while the check runs the form cannot be sent twice; going back creates nothing and frees the form', async () => {
    let decide: (d: SlaCoverageDecision) => void = () => {}
    state.sla.mockImplementation(() => new Promise<SlaCoverageDecision>((resolve) => { decide = resolve }))
    const { user } = page()
    await fillIn(user)
    await user.click(submit())
    expect(submit()).toBeDisabled()
    decide('cancelled')
    await waitFor(() => expect(submit()).toBeEnabled())
    expect(state.sla).toHaveBeenCalledTimes(1)
    expect(apolloFinto.chiamata('CreateProblem')).toBeUndefined()
    await attendiURL('/problems/new')
  })

  it('a check that fails says why and creates nothing', async () => {
    state.sla.mockRejectedValue(new Error('policies unavailable'))
    const { user } = page()
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not check whether an SLA policy covers the problem: policies unavailable'))
    expect(apolloFinto.chiamata('CreateProblem')).toBeUndefined()
    await waitFor(() => expect(submit()).toBeEnabled())
  })

  it('a check that fails with something that is not an Error still says what it was', async () => {
    state.sla.mockRejectedValue('timeout')
    const { user } = page()
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not check whether an SLA policy covers the problem: timeout'))
  })
})

describe('CreateProblemPage — affected CIs', () => {
  const searchBox = () => screen.getByPlaceholderText('Search by name...')

  it('searches from two characters without the excluded types, and a picked CI becomes a chip', async () => {
    const { user } = page()
    fireEvent.change(searchBox(), { target: { value: 'o' } })
    expect(apolloFinto.chiamata('GetAllCIs')).toBeUndefined()
    fireEvent.change(searchBox(), { target: { value: 'or' } })
    expect(apolloFinto.chiamata('GetAllCIs')).toEqual({ search: 'or', limit: 20, excludeCiTypes: ['person'] })
    // Each result says what it is: the type and the environment, with the customer's labels.
    expect(screen.getByRole('button', { name: /orders-db/ })).toHaveTextContent('Database · Production')
    expect(screen.getByRole('button', { name: /orders-app/ })).toHaveTextContent('Application')
    await user.click(screen.getByRole('button', { name: /orders-db/ }))
    expect(searchBox()).toHaveValue('')
    expect(screen.getByText('orders-db')).toBeInTheDocument()
    // Searching again, the CI already picked is not offered twice.
    fireEvent.change(searchBox(), { target: { value: 'or' } })
    expect(screen.queryByRole('button', { name: /orders-db/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /orders-app/ })).toBeInTheDocument()
  })

  it('the picked CIs travel with the problem, and a removed one does not', async () => {
    const { user } = page()
    fireEvent.change(searchBox(), { target: { value: 'or' } })
    await user.click(screen.getByRole('button', { name: /orders-db/ }))
    fireEvent.change(searchBox(), { target: { value: 'or' } })
    await user.click(screen.getByRole('button', { name: /orders-app/ }))
    await user.click(within(screen.getByText('orders-app')).getByRole('button'))
    expect(screen.queryByText('orders-app')).not.toBeInTheDocument()
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateProblem')).toMatchObject({ input: { affectedCIs: ['ci-db'] } }))
  })

  it('does not search while the excluded types are unknown', () => {
    state.excluded = undefined
    page()
    fireEvent.change(searchBox(), { target: { value: 'orders' } })
    expect(apolloFinto.chiamata('GetAllCIs')).toBeUndefined()
  })

  it('the search box highlights while focused', () => {
    page()
    fireEvent.focus(searchBox())
    expect(searchBox().style.borderColor).toBe('var(--color-brand)')
    fireEvent.blur(searchBox())
    expect(searchBox().style.borderColor).toBe('var(--color-border)')
  })
})

describe('CreateProblemPage — the customer fields, failures and leaving', () => {
  it('a required customer field blocks the send, before the SLA check; filled in, it travels trimmed', async () => {
    state.defs = [{ name: 'vendor_ref', label: 'Vendor reference', fieldType: 'string', required: true, enumValues: [], enumTypeName: null, visibleToEndUser: false }]
    const { user } = page()
    await fillIn(user)
    await user.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('Required field')
    expect(state.sla).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText(/Vendor reference/), ' V-42 ')
    // Typing clears the error of that field.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateProblem')).toMatchObject({ input: { customFields: [{ name: 'vendor_ref', value: 'V-42' }] } }))
  })

  it('while the problem is being created, the button says so and cannot be pressed twice', async () => {
    state.busy.add('CreateProblem')
    const { user } = page()
    await fillIn(user)
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
  })

  it('a creation refused by the server is reported and the user stays on the form', async () => {
    apolloFinto.esiti['CreateProblem'] = { error: new Error('title already used') }
    const { user } = page()
    await fillIn(user)
    await user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('title already used'))
    expect(toast.success).not.toHaveBeenCalled()
    await attendiURL('/problems/new')
  })

  it('a team that cannot be assigned is reported, and the problem, created anyway, still opens', async () => {
    apolloFinto.esiti['AssignProblemToTeam'] = { error: new Error('team is archived') }
    const { user } = page()
    await fillIn(user)
    await user.click(screen.getByRole('combobox', { name: 'Team' }))
    await user.click(await screen.findByRole('option', { name: 'SUP_Database Platform' }))
    await user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Team assignment: team is archived'))
    expect(toast.success).toHaveBeenCalledWith('Problem created')
    await attendiURL('/problems/prb-9')
  })

  it('Cancel goes back to the list without creating anything', async () => {
    const { user } = page()
    await fillIn(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await attendiURL('/problems')
    expect(apolloFinto.chiamata('CreateProblem')).toBeUndefined()
  })

  it('the back link goes to the list, and highlights under the pointer', async () => {
    const { user } = page()
    const back = screen.getByRole('button', { name: '← Problems' })
    await user.hover(back)
    expect(back.style.color).toBe('var(--color-brand)')
    await user.unhover(back)
    expect(back.style.color).toBe('var(--color-slate-light)')
    await user.click(back)
    await attendiURL('/problems')
  })
})
