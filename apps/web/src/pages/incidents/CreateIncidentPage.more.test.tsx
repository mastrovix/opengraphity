/**
 * Creating an incident: what is SENT, and when the page refuses to send.
 *
 * This is the most used form of the product. The sibling test proves that
 * impact, urgency and priority come from the tenant's matrix; this one covers
 * the submit path, where every regression lands on a service desk agent in the
 * middle of an outage:
 *
 * - the incident carries the chosen CIs, the trimmed text and the tenant's
 *   custom fields, and a team picked in the form is assigned right after;
 * - "Create without SLA" must travel as `acknowledgeNoSla`, and "Go back"
 *   must create nothing;
 * - when the field rules, the matrix or the SLA check cannot be read the page
 *   says so and creates nothing — it never sends a ticket "blind";
 * - a required custom field left empty blocks the submit next to the field.
 *
 * The data hooks are replaced by controllable fakes (their own tests cover
 * the queries); the page's own queries and mutations go through the fake
 * Apollo, answered by operation name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { PriorityMatrix } from '@/lib/priority'
import type { FieldRules } from '@/hooks/useFormFieldRules'
import type { CustomFieldDefView } from '@/components/ticket/customFields/customFields'
import type { SlaCoverageDecision } from '@/hooks/useSlaCoverageCheck'
import { CreateIncidentPage } from './CreateIncidentPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const state = vi.hoisted(() => ({
  matrix: null as PriorityMatrix | null,
  matrixLoading: false,
  matrixError: null as Error | null,
  rules: {} as Record<string, FieldRules>,
  rulesError: undefined as Error | undefined,
  categories: ['network', 'hardware'] as string[],
  categoriesLoading: false,
  customDefs: [] as CustomFieldDefView[],
  excluded: [] as readonly string[] | undefined,
  sla: vi.fn<(input: unknown) => Promise<SlaCoverageDecision>>(),
  triage: { severity: 'high', category: 'hardware', teamName: 'Network Ops' as string | null },
}))

vi.mock('@/hooks/usePriorityMatrix', () => ({
  usePriorityMatrix: () => ({ matrix: state.matrix, loading: state.matrixLoading, error: state.matrixError }),
}))
vi.mock('@/hooks/useFormFieldRules', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useFormFieldRules')>()),
  useFormFieldRules: () => ({ rules: state.rules, error: state.rulesError }),
}))
vi.mock('@/hooks/useEnumValues', () => ({
  useEnumValues: () => ({ values: state.categories, loading: state.categoriesLoading, error: null }),
}))
vi.mock('@/hooks/useTicketCIExclusions', () => ({
  useTicketCIExclusions: () => ({ excluded: state.excluded, error: undefined }),
}))
vi.mock('@/hooks/useSlaCoverageCheck', () => ({
  useSlaCoverageCheck: () => state.sla,
}))
vi.mock('@/components/ticket/customFields/customFields', async (orig) => ({
  ...(await orig<typeof import('@/components/ticket/customFields/customFields')>()),
  useCreationCustomFieldDefs: () => ({ defs: state.customDefs, loading: false, error: undefined }),
}))
// The AI card is its own component with its own tests; here only its
// `onApply` contract matters: what the page does with an accepted suggestion.
vi.mock('@/components/TriageSuggestionCard', () => ({
  TriageSuggestionCard: (p: { onApply: (v: { severity: string; category: string; teamName: string | null }) => void }) => (
    <button type="button" onClick={() => p.onApply(state.triage)}>fake apply triage</button>
  ),
}))

const MATRIX: PriorityMatrix = {
  impacts: ['low', 'medium', 'high'],
  urgencies: ['low', 'medium', 'high'],
  priorities: ['low', 'medium', 'high', 'critical'],
  cells: [
    { key: 'low|low', inputs: ['low', 'low'], value: 'low' },
    { key: 'medium|medium', inputs: ['medium', 'medium'], value: 'medium' },
    { key: 'high|medium', inputs: ['high', 'medium'], value: 'high' },
    { key: 'high|high', inputs: ['high', 'high'], value: 'critical' },
  ],
}

const CIS = [
  { id: 'ci-1', name: 'db-prod-01', type: 'database', environment: 'production' },
  { id: 'ci-2', name: 'db-prod-02', type: 'database', environment: 'production' },
]
const TEAMS = [{ id: 'tm-1', name: 'Network Ops' }, { id: 'tm-2', name: 'DBA' }]

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: CIS } }
  apolloFinto.risposte['GetTeams'] = { teams: TEAMS }
  apolloFinto.esiti['CreateIncident'] = { data: { createIncident: { id: 'inc-9' } } }
  Object.assign(state, {
    matrix: MATRIX, matrixLoading: false, matrixError: null, rules: {}, rulesError: undefined,
    categories: ['network', 'hardware'], categoriesLoading: false, customDefs: [], excluded: [],
    triage: { severity: 'high', category: 'hardware', teamName: 'Network Ops' },
  })
  state.sla.mockReset().mockResolvedValue('covered')
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

function render() {
  return renderWithProviders(<CreateIncidentPage />, { route: '/incidents/new' })
}

type R = ReturnType<typeof render>

async function fillRequired(r: R) {
  await r.user.type(screen.getByRole('textbox', { name: /production database is unreachable/ }), '  DB down  ')
  await r.user.selectOptions(screen.getByLabelText(/Category/), 'network')
  await r.user.type(screen.getByRole('textbox', { name: /Describe what is happening/ }), ' Timeouts everywhere ')
  await pickCI(r, 'db-prod-01')
}

async function pickCI(r: R, name: string) {
  await r.user.type(screen.getByPlaceholderText('Search by name...'), 'db')
  await r.user.click(await screen.findByRole('button', { name: new RegExp(name) }))
}

const submit = () => screen.getByRole('button', { name: 'Create the incident' })

describe('submit is possible only with the required fields', () => {
  it('stays disabled until title, category, description and a CI are there', async () => {
    const r = render()
    expect(submit()).toBeDisabled()
    await fillRequired(r)
    expect(submit()).toBeEnabled()
  })

  it('removing the only CI disables it again', async () => {
    const r = render()
    await fillRequired(r)
    const tag = screen.getByText('db-prod-01', { selector: 'span' })
    await r.user.click(tag.querySelector('button')!)
    expect(screen.queryByText('db-prod-01')).not.toBeInTheDocument()
    expect(submit()).toBeDisabled()
  })

  it('a CI already chosen is not offered again, and a one-letter search asks nothing', async () => {
    const r = render()
    await pickCI(r, 'db-prod-01')
    await r.user.type(screen.getByPlaceholderText('Search by name...'), 'db')
    expect(await screen.findByRole('button', { name: /db-prod-02/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /db-prod-01/ })).not.toBeInTheDocument()
    await r.user.clear(screen.getByPlaceholderText('Search by name...'))
    await r.user.type(screen.getByPlaceholderText('Search by name...'), 'd')
    expect(screen.queryByRole('button', { name: /db-prod-02/ })).not.toBeInTheDocument()
  })
})

describe('what a created incident carries', () => {
  it('sends trimmed text, the matrix pair, the CIs and the custom fields, then assigns the team and goes back to the list', async () => {
    state.customDefs = [{ name: 'site', label: 'Site', fieldType: 'string', required: false, enumValues: [], enumTypeName: null, visibleToEndUser: false }]
    const r = render()
    await fillRequired(r)
    await r.user.type(screen.getByLabelText('Site'), ' Milan ')

    // Pick a team from the dropdown, filtering by name.
    await r.user.type(screen.getByPlaceholderText('Search a team by name...'), 'dba')
    expect(screen.queryByRole('button', { name: 'Network Ops' })).not.toBeInTheDocument()
    await r.user.click(screen.getByRole('button', { name: 'DBA' }))
    expect(screen.queryByPlaceholderText('Search a team by name...')).not.toBeInTheDocument()

    await r.user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateIncident')).toBeDefined())
    expect(apolloFinto.chiamata('CreateIncident')).toEqual({
      input: {
        title: 'DB down',
        // The median of each of the tenant's scales is preselected.
        impact: 'medium', urgency: 'medium',
        category: 'network',
        description: 'Timeouts everywhere',
        affectedCIIds: ['ci-1'],
        customFields: [{ name: 'site', value: 'Milan' }],
      },
    })
    // The SLA check is asked about THIS incident, team included.
    expect(state.sla).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'incident', priority: 'medium', category: 'network', teamId: 'tm-2', teamName: 'DBA' }))
    await waitFor(() => expect(apolloFinto.chiamata('AssignIncidentToTeam')).toEqual({ id: 'inc-9', teamId: 'tm-2' }))
    expect(toast.success).toHaveBeenCalledWith('Incident created')
    await attendiURL('/incidents')
  })

  it('"Create without SLA" travels as acknowledgeNoSla, and no team means no assignment', async () => {
    state.sla.mockResolvedValue('accepted')
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateIncident')).toMatchObject({ input: { acknowledgeNoSla: true } }))
    expect(apolloFinto.chiamata('AssignIncidentToTeam')).toBeUndefined()
  })

  it('"Go back" on the SLA warning creates nothing and gives the button back', async () => {
    state.sla.mockResolvedValue('cancelled')
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    await waitFor(() => expect(state.sla).toHaveBeenCalled())
    await waitFor(() => expect(submit()).toBeEnabled())
    expect(apolloFinto.chiamata('CreateIncident')).toBeUndefined()
  })

  it('an SLA check that cannot run blocks the creation and says why', async () => {
    state.sla.mockRejectedValue(new Error('sla service down'))
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Could not check whether an SLA policy covers the incident: sla service down')))
    expect(apolloFinto.chiamata('CreateIncident')).toBeUndefined()
  })

  it('a non-Error rejection of the SLA check is still reported', async () => {
    state.sla.mockRejectedValue('offline')
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('covers the incident: offline')))
  })

  it('a refused creation stays on the page and shows the error', async () => {
    apolloFinto.esiti['CreateIncident'] = { error: new Error('assertDomainValue: bad impact') }
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByTestId('location')).toHaveTextContent('/incidents/new')
  })

  it('a failed team assignment is reported with its own message', async () => {
    apolloFinto.esiti['AssignIncidentToTeam'] = { error: new Error('no such team') }
    const r = render()
    await fillRequired(r)
    await r.user.type(screen.getByPlaceholderText('Search a team by name...'), 'Net')
    await r.user.click(screen.getByRole('button', { name: 'Network Ops' }))
    await r.user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Team assignment: no such team')))
  })
})

describe('the page refuses to send when it cannot tell what is valid', () => {
  it('field rules unavailable: nothing is sent', async () => {
    state.rulesError = new Error('rules offline')
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Cannot validate required fields: rules offline'))
    expect(state.sla).not.toHaveBeenCalled()
  })

  it('matrix unavailable: nothing is sent', async () => {
    state.matrixError = new Error('matrices offline')
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Domain matrices are unreachable (matrices offline)'))
    expect(state.sla).not.toHaveBeenCalled()
  })

  it('a pair the matrix does not cover: the message says what to do, nothing is sent', async () => {
    const r = render()
    await fillRequired(r)
    // low × high has no cell in MATRIX.
    await r.user.click(screen.getAllByRole('button', { name: 'low' })[0]!)
    await r.user.click(screen.getAllByRole('button', { name: 'high' })[1]!)
    expect(screen.getByText('to be filled in, in the matrix')).toBeInTheDocument()
    await r.user.click(submit())
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('does not cover the selected combination'))
    expect(state.sla).not.toHaveBeenCalled()
  })

  it('a required custom field left empty is flagged next to it, and typing clears the flag', async () => {
    state.customDefs = [{ name: 'site', label: 'Site', fieldType: 'string', required: true, enumValues: [], enumTypeName: null, visibleToEndUser: false }]
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    expect(await screen.findByText('Required field')).toBeInTheDocument()
    expect(state.sla).not.toHaveBeenCalled()
    await r.user.type(screen.getByLabelText(/Site/), 'x')
    expect(screen.queryByText('Required field')).not.toBeInTheDocument()
  })
})

describe('matrix loading and the AI triage suggestion', () => {
  it('while the matrix loads, the priority says "loading" and the scales are empty', () => {
    state.matrix = null
    state.matrixLoading = true
    render()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getAllByText('Loading...').length).toBeGreaterThan(0)
  })

  it('while the categories load, the select is not offered', () => {
    state.categoriesLoading = true
    render()
    expect(screen.queryByLabelText(/Category/)).not.toBeInTheDocument()
  })

  it('a matrix with an empty scale preselects nothing', () => {
    state.matrix = { ...MATRIX, impacts: [], urgencies: [] }
    render()
    expect(screen.getByText('to be filled in, in the matrix')).toBeInTheDocument()
  })

  it('applying a suggestion sets the matrix pair of that priority, the category and the team', async () => {
    const r = render()
    await r.user.click(screen.getByRole('button', { name: 'fake apply triage' }))
    // "high" comes only from high × medium in MATRIX.
    expect(screen.getAllByRole('button', { name: 'high' })[0]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('button', { name: 'medium' })[1]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText(/Category/)).toHaveValue('hardware')
    expect(screen.getByText('Network Ops')).toBeInTheDocument()

    // The chosen team can be removed, which brings the search back.
    await r.user.click(screen.getByText('Network Ops').querySelector('button')!)
    expect(screen.getByPlaceholderText('Search a team by name...')).toHaveValue('')
  })

  it('a suggested priority the matrix cannot produce leaves the user\'s pair alone; an unknown team is ignored', async () => {
    state.triage = { severity: 'nonexistent', category: 'network', teamName: 'Ghost team' }
    const r = render()
    await r.user.click(screen.getAllByRole('button', { name: 'low' })[0]!)
    await r.user.click(screen.getByRole('button', { name: 'fake apply triage' }))
    expect(screen.getAllByRole('button', { name: 'low' })[0]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText(/Category/)).toHaveValue('network')
    expect(screen.getByPlaceholderText('Search a team by name...')).toBeInTheDocument()
  })

  it('a suggestion without a team touches only priority and category', async () => {
    state.triage = { severity: 'low', category: 'network', teamName: null }
    const r = render()
    await r.user.click(screen.getByRole('button', { name: 'fake apply triage' }))
    expect(screen.getAllByRole('button', { name: 'low' })[0]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByPlaceholderText('Search a team by name...')).toBeInTheDocument()
  })
})

describe('navigation and small interactions', () => {
  it('both "Incidents" and "Cancel" go back to the list without creating anything', async () => {
    const r = render()
    await r.user.click(screen.getByRole('button', { name: /Incidents/ }))
    await attendiURL('/incidents')
    r.unmount()
    const r2 = render()
    await r2.user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(apolloFinto.chiamata('CreateIncident')).toBeUndefined()
  })

  it('hover and focus styling does not break the inputs', async () => {
    const r = render()
    const back = screen.getByRole('button', { name: /Incidents/ })
    fireEvent.mouseEnter(back); fireEvent.mouseLeave(back)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.mouseEnter(cancel); fireEvent.mouseLeave(cancel)
    for (const el of [
      screen.getByRole('textbox', { name: /production database is unreachable/ }),
      screen.getByRole('textbox', { name: /Describe what is happening/ }),
      screen.getByPlaceholderText('Search by name...'),
    ]) { fireEvent.focus(el); fireEvent.blur(el) }
    // The team dropdown closes a moment after the field loses focus.
    const teamInput = screen.getByPlaceholderText('Search a team by name...')
    await r.user.click(teamInput)
    expect(screen.getByRole('button', { name: 'DBA' })).toBeInTheDocument()
    fireEvent.blur(teamInput)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'DBA' })).not.toBeInTheDocument())
  })
})
