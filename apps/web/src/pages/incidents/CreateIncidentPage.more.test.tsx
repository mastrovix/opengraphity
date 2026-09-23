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
  // No support group: the team is a free choice (or none).
  { id: 'ci-1', name: 'db-prod-01', type: 'database', environment: 'production', supportGroup: null },
  // With a support group: the team is prefilled with it.
  { id: 'ci-2', name: 'db-prod-02', type: 'database', environment: 'production', supportGroup: { id: 'tm-2', name: 'DBA' } },
  { id: 'ci-3', name: 'db-prod-03', type: 'database', environment: 'production', supportGroup: { id: 'tm-1', name: 'Network Ops' } },
]
const TEAMS = [{ id: 'tm-1', name: 'Network Ops' }, { id: 'tm-2', name: 'DBA' }]

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: CIS } }
  apolloFinto.risposte['GetTeams'] = { teams: TEAMS }
  // D10: the picker offers the support teams; the owner team is in the tenant, not in the list.
  apolloFinto.risposte['GetTeamChoices'] = { teams: [
    ...TEAMS.map((t) => ({ ...t, type: 'support', isChangeManager: false })),
    { id: 'tm-3', name: 'OWN_Billing Owner', type: 'owner', isChangeManager: false },
  ] }
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
  it('sends trimmed text, the matrix pair, the CIs, the custom fields and the chosen team, then opens the new incident', async () => {
    state.customDefs = [{ name: 'site', label: 'Site', fieldType: 'string', required: false, enumValues: [], enumTypeName: null, visibleToEndUser: false }]
    const r = render()
    await fillRequired(r)
    await r.user.type(screen.getByLabelText('Site'), ' Milan ')

    // Pick a team from the picker, filtering by name: support teams only (D10).
    const teamBox = screen.getByRole('combobox', { name: 'Team' })
    await r.user.click(teamBox)
    expect(await screen.findByRole('option', { name: 'Network Ops' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'OWN_Billing Owner' })).not.toBeInTheDocument()
    await r.user.type(teamBox, 'dba')
    expect(screen.queryByRole('option', { name: 'Network Ops' })).not.toBeInTheDocument()
    await r.user.click(screen.getByRole('option', { name: 'DBA' }))
    expect(teamBox).toHaveValue('DBA')

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
        // The team travels with the creation: one assignment, no second call.
        teamId: 'tm-2',
      },
    })
    // The SLA check is asked about THIS incident, team included.
    expect(state.sla).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'incident', priority: 'medium', category: 'network', teamId: 'tm-2', teamName: 'DBA' }))
    expect(apolloFinto.chiamata('AssignIncidentToTeam')).toBeUndefined()
    expect(toast.success).toHaveBeenCalledWith('Incident created')
    // Straight to the new incident, as a new change does.
    await attendiURL('/incidents/inc-9')
  })

  it('"Create without SLA" travels as acknowledgeNoSla, and no team means no assignment', async () => {
    state.sla.mockResolvedValue('accepted')
    const r = render()
    await fillRequired(r)
    await r.user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateIncident')).toMatchObject({ input: { acknowledgeNoSla: true } }))
    expect(apolloFinto.chiamata('CreateIncident')!['input']).not.toHaveProperty('teamId')
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

  it('a team refused by the API (it no longer exists) is shown, and nothing is half-done', async () => {
    apolloFinto.esiti['CreateIncident'] = { error: new Error('The chosen team no longer exists in this organization: choose another one.') }
    const r = render()
    await fillRequired(r)
    await r.user.type(screen.getByRole('combobox', { name: 'Team' }), 'Net')
    await r.user.click(await screen.findByRole('option', { name: 'Network Ops' }))
    await r.user.click(submit())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('no longer exists')))
    expect(apolloFinto.chiamata('CreateIncident')).toMatchObject({ input: { teamId: 'tm-1' } })
    expect(apolloFinto.chiamata('AssignIncidentToTeam')).toBeUndefined()
  })
})

/**
 * THE TEAM OF A NEW INCIDENT IS THE SUPPORT GROUP OF ITS CI (23 Sep 2026, the
 * owner's rule): prefilled from the first chosen CI that has one, changeable,
 * never overwritten once changed by hand, and never replaced by the AI.
 */
describe('the team of a new incident', () => {
  it('choosing a CI with a support group prefills the team with it, says where it comes from, and sends it', async () => {
    const r = render()
    await pickCI(r, 'db-prod-02')
    const teamBox = screen.getByRole('combobox', { name: 'Team' })
    expect(teamBox).toHaveValue('DBA')
    expect(screen.getByText('The support group of db-prod-02: you can choose another team.')).toBeInTheDocument()
    await r.user.type(screen.getByRole('textbox', { name: /production database is unreachable/ }), 'DB down')
    await r.user.selectOptions(screen.getByLabelText(/Category/), 'network')
    await r.user.type(screen.getByRole('textbox', { name: /Describe what is happening/ }), 'Timeouts')
    await r.user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateIncident')).toMatchObject({ input: { affectedCIIds: ['ci-2'], teamId: 'tm-2' } }))
  })

  it('with a support group «no team» is not offered: the incident goes to a team', async () => {
    const r = render()
    await pickCI(r, 'db-prod-02')
    await r.user.click(screen.getByRole('combobox', { name: 'Team' }))
    expect(await screen.findByRole('option', { name: 'Network Ops' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '— No team —' })).not.toBeInTheDocument()
  })

  it('a team changed by hand is kept when more CIs are added', async () => {
    const r = render()
    await pickCI(r, 'db-prod-02')
    const teamBox = screen.getByRole('combobox', { name: 'Team' })
    await r.user.click(teamBox)
    await r.user.click(await screen.findByRole('option', { name: 'Network Ops' }))
    expect(teamBox).toHaveValue('Network Ops')
    await pickCI(r, 'db-prod-03')
    expect(teamBox).toHaveValue('Network Ops')
    expect(screen.queryByText(/The support group of/)).not.toBeInTheDocument()
  })

  it('several CIs: the first chosen one that has a support group gives the team', async () => {
    const r = render()
    await pickCI(r, 'db-prod-01')
    await pickCI(r, 'db-prod-03')
    await pickCI(r, 'db-prod-02')
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('Network Ops')
    expect(screen.getByText('The support group of db-prod-03: you can choose another team.')).toBeInTheDocument()
  })

  it('a CI without a support group: the team starts empty, and the page says what happens', async () => {
    const r = render()
    await pickCI(r, 'db-prod-01')
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('')
    expect(screen.getByRole('note')).toHaveTextContent('This CI has no support group: choose a team, or the incident will be created without one.')
  })

  it('the AI suggestion never replaces the support group of the CI', async () => {
    const r = render()
    await pickCI(r, 'db-prod-02')
    await r.user.click(screen.getByRole('button', { name: 'fake apply triage' }))
    // It may still set priority and category...
    expect(screen.getByLabelText(/Category/)).toHaveValue('hardware')
    // ...but the team stays the CI's support group.
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('DBA')
  })

  it('the AI suggestion fills the team when no CI has a support group and nobody chose', async () => {
    const r = render()
    await pickCI(r, 'db-prod-01')
    await r.user.click(screen.getByRole('button', { name: 'fake apply triage' }))
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('Network Ops')
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
    const teamBox = screen.getByRole('combobox', { name: 'Team' })
    expect(teamBox).toHaveValue('Network Ops')

    // The chosen team can be removed.
    await r.user.click(teamBox)
    await r.user.click(await screen.findByRole('option', { name: '— No team —' }))
    expect(teamBox).toHaveValue('')
  })

  it('a suggested priority the matrix cannot produce leaves the user\'s pair alone; an unknown team is ignored', async () => {
    state.triage = { severity: 'nonexistent', category: 'network', teamName: 'Ghost team' }
    const r = render()
    await r.user.click(screen.getAllByRole('button', { name: 'low' })[0]!)
    await r.user.click(screen.getByRole('button', { name: 'fake apply triage' }))
    expect(screen.getAllByRole('button', { name: 'low' })[0]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText(/Category/)).toHaveValue('network')
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('')
  })

  it('a suggestion without a team touches only priority and category', async () => {
    state.triage = { severity: 'low', category: 'network', teamName: null }
    const r = render()
    await r.user.click(screen.getByRole('button', { name: 'fake apply triage' }))
    expect(screen.getAllByRole('button', { name: 'low' })[0]).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('combobox', { name: 'Team' })).toHaveValue('')
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
    // The team list closes when the field loses focus.
    const teamInput = screen.getByRole('combobox', { name: 'Team' })
    await r.user.click(teamInput)
    expect(await screen.findByRole('option', { name: 'DBA' })).toBeInTheDocument()
    fireEvent.blur(teamInput)
    await waitFor(() => expect(screen.queryByRole('option', { name: 'DBA' })).not.toBeInTheDocument())
  })
})
