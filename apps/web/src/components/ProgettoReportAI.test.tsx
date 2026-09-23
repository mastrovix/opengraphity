/**
 * «DESCRIBE THE REPORT AND I WILL DESIGN IT» — the AI modal of the report
 * builder.
 *
 * The user writes what they need, reads back what the AI understood, and
 * only then puts the design in the builder, where nothing is saved until they
 * save it. The review is the whole point: a proposal is accepted knowing WHAT
 * is accepted — the chart, the measure, the grouping, the entities with their
 * filters written as sentences, the links, and what was discarded and why, in
 * the user's language. And whatever happens (a failure, «Edit the
 * description») the description the user wrote is never lost.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apolloFinto } from '@/test/apolloFinto'
import type { ProgettoReport } from './ProgettoReportAI'

/** Mutations still waiting for the server (the fake answers at once otherwise). */
const inFlight = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  return {
    ...base,
    useMutation: (doc: Parameters<typeof base.useMutation>[0], opts?: Parameters<typeof base.useMutation>[1]) => {
      const [fn, state] = base.useMutation(doc, opts) as [unknown, Record<string, unknown>]
      return [fn, { ...state, loading: inFlight.has(nomeOperazione(doc)) }]
    },
  }
})
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { ModaleProgettoReportAI } = await import('./ProgettoReportAI')

const PROPOSAL: ProgettoReport = {
  prompt: 'Average cost of open incidents by status, per month',
  title: 'Incident cost by status',
  chartType: 'bar_horizontal',
  metric: 'avg',
  metricField: 'cost',
  groupByNodeId: 'n1',
  groupByField: 'status',
  groupByGranularity: 'month',
  limit: 10,
  sortDir: 'DESC',
  why: 'Bars compare the statuses side by side.',
  nodes: [
    {
      id: 'n1', entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident', isRoot: true, isResult: true,
      selectedFields: ['number', 'title'], positionX: 300, positionY: 80, why: 'You asked about incidents.',
      filters: JSON.stringify([
        { field: 'status', operator: 'in', value: ['new', 'open'] },
        { field: 'created_at', operator: 'last_n_days', value: 30 },
        { field: 'closed_at', operator: 'is_null', value: null },
      ]),
    },
    {
      id: 'n2', entityType: 'Team', neo4jLabel: 'Team', label: 'Team', isRoot: false, isResult: false,
      selectedFields: [], positionX: 300, positionY: 280, why: '', filters: null,
    },
  ],
  edges: [
    { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Assigned team' },
    { id: 'e2', sourceNodeId: 'n1', targetNodeId: 'n9', relationshipType: 'AFFECTS', direction: 'outgoing', label: '' },
    { id: 'e3', sourceNodeId: 'n8', targetNodeId: 'n2', relationshipType: 'MEMBER_OF', direction: 'outgoing', label: 'Member' },
  ],
  discarded: [
    { what: 'Filter on colour', key: 'reportProposal.discard.filterFieldUnknown', params: '{"name":"colour","entity":"Incident"}' },
  ],
  notes: ['Costs in other currencies are not converted.'],
}

beforeEach(() => {
  apolloFinto.reset()
  inFlight.clear()
  toast.error.mockReset()
  apolloFinto.esiti['ProposeReportSection'] = { data: { proposeReportSection: PROPOSAL } }
})

function mount(descrizioneIniziale?: string) {
  const onChiudi = vi.fn()
  const onApplica = vi.fn()
  const user = userEvent.setup()
  const r = render(<ModaleProgettoReportAI onChiudi={onChiudi} onApplica={onApplica} descrizioneIniziale={descrizioneIniziale} />)
  return { ...r, user, onChiudi, onApplica }
}

const description = () => screen.getByRole('textbox', { name: 'What report do you need?' })
const designButton = () => screen.getByRole('button', { name: /^(Design|Designing…)$/ })

/** Writes the request and asks for the design. */
async function ask(user: ReturnType<typeof userEvent.setup>, text = PROPOSAL.prompt) {
  await user.clear(description())
  await user.type(description(), text)
  await user.click(designButton())
  await screen.findByText('What I understood')
}

describe('ModaleProgettoReportAI — the request', () => {
  it('is a dialog named after what it does, with an empty box by default', () => {
    mount()
    expect(screen.getByRole('dialog', { name: 'Describe the report and I will design it' })).toBeInTheDocument()
    expect(screen.getByText(/I build it in the builder as if you had done it by hand/)).toBeInTheDocument()
    expect(description()).toHaveValue('')
  })

  it('starts from the last description, so changing a word does not mean rewriting three lines', () => {
    mount('Open incidents by team, as bars')
    expect(description()).toHaveValue('Open incidents by team, as bars')
    expect(designButton()).toBeEnabled()
  })

  it('Design waits for a real sentence: fewer than 8 characters (spaces aside) is not one', async () => {
    const { user } = mount()
    expect(designButton()).toBeDisabled()
    await user.type(description(), '   short   ')
    expect(designButton()).toBeDisabled()
    await user.type(description(), 'er text')
    expect(designButton()).toBeEnabled()
  })

  it('sends the description without the surrounding spaces', async () => {
    const { user } = mount()
    await user.type(description(), '   Incidents by team   ')
    await user.click(designButton())
    expect(apolloFinto.chiamata('ProposeReportSection')).toEqual({ prompt: 'Incidents by team' })
  })

  it('while the AI designs, the button says so and cannot be pressed again', () => {
    inFlight.add('ProposeReportSection')
    mount('Incidents by team, as bars')
    expect(designButton()).toHaveTextContent('Designing…')
    expect(designButton()).toBeDisabled()
  })

  it('a failed design shows the error and keeps the description on the form', async () => {
    apolloFinto.esiti['ProposeReportSection'] = { error: new Error('The AI service is not configured') }
    const { user } = mount()
    await user.type(description(), 'Incidents by team, as bars')
    await user.click(designButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The AI service is not configured'))
    expect(description()).toHaveValue('Incidents by team, as bars')
    expect(screen.queryByText('What I understood')).not.toBeInTheDocument()
  })

  it('Cancel, the × and Escape all close without applying anything', async () => {
    const { user, onChiudi, onApplica } = mount('Incidents by team')
    await user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!)
    await user.keyboard('{Escape}')
    expect(onChiudi).toHaveBeenCalledTimes(3)
    expect(onApplica).not.toHaveBeenCalled()
  })
})

describe('ModaleProgettoReportAI — the review', () => {
  it('repeats the request and says what was understood: chart, measure, grouping, period, order, why', async () => {
    const { user } = mount()
    await ask(user)
    expect(screen.getByText('You asked').nextSibling).toHaveTextContent(PROPOSAL.prompt)
    expect(screen.getByText('Incident cost by status')).toBeInTheDocument()
    expect(screen.getByText('Chart:').textContent).toBe('Chart: Horizontal bars')
    expect(screen.getByText(/^Measure:/)).toHaveTextContent('Measure: Average · cost')
    expect(screen.getByText(/^Grouped by:/)).toHaveTextContent('Grouped by: Incident · status')
    expect(screen.getByText(/^Period:/)).toHaveTextContent('Period: By month')
    expect(screen.getByText(/^Limit and order:/)).toHaveTextContent('Limit and order: 10 · DESC')
    expect(screen.getByText('Bars compare the statuses side by side.')).toBeInTheDocument()
  })

  it('a count reads as a count, and there is no grouping, period or reason line when there is none', async () => {
    apolloFinto.esiti['ProposeReportSection'] = { data: { proposeReportSection: {
      ...PROPOSAL, chartType: 'kpi', metric: 'count', metricField: null, groupByNodeId: null, groupByField: null,
      groupByGranularity: null, why: '',
    } } }
    const { user } = mount()
    await ask(user)
    expect(screen.getByText(/^Chart:/)).toHaveTextContent('Chart: Total number')
    expect(screen.getByText(/^Measure:/)).toHaveTextContent('Measure: Count')
    expect(screen.queryByText(/^Grouped by:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Period:/)).not.toBeInTheDocument()
    expect(screen.queryByText('Bars compare the statuses side by side.')).not.toBeInTheDocument()
  })

  it('a grouping on a node that is not in the proposal names the field alone; a measure without a field still names the measure', async () => {
    apolloFinto.esiti['ProposeReportSection'] = { data: { proposeReportSection: { ...PROPOSAL, groupByNodeId: 'gone', metricField: null } } }
    const { user } = mount()
    await ask(user)
    expect(screen.getByText(/^Grouped by:/)).toHaveTextContent(/^Grouped by: status$/)
    expect(screen.getByText(/^Measure:/)).toHaveTextContent(/^Measure: Average/)
    expect(screen.getByText(/^Measure:/)).not.toHaveTextContent('undefined')
  })

  it('lists the entities: the main one marked, its columns, its filters as sentences and why it is there', async () => {
    const { user } = mount()
    await ask(user)
    const incident = screen.getByText('Incident', { selector: 'span' }).closest('li') as HTMLElement
    expect(within(incident).getByText('main')).toBeInTheDocument()
    expect(within(incident).getByText('columns: number, title')).toBeInTheDocument()
    const filters = within(incident).getAllByRole('listitem').map((li) => li.textContent?.trim())
    expect(filters).toEqual(['status is one of new, open', 'created_at last N days 30', 'closed_at is empty'])
    expect(within(incident).getByText('You asked about incidents.')).toBeInTheDocument()
    const team = screen.getByText('Team', { selector: 'span' }).closest('li') as HTMLElement
    expect(within(team).queryByText('main')).not.toBeInTheDocument()
    expect(within(team).queryByText(/columns:/)).not.toBeInTheDocument()
    expect(within(team).queryByRole('list')).not.toBeInTheDocument()
  })

  it('the links read «from → to (relation)», with the relationship type or the id when a name is missing', async () => {
    const { user } = mount()
    await ask(user)
    expect(screen.getByText('Incident → Team (Assigned team)')).toBeInTheDocument()
    expect(screen.getByText('Incident → n9 (AFFECTS)')).toBeInTheDocument()
    expect(screen.getByText('n8 → Team (Member)')).toBeInTheDocument()
  })

  it('what was discarded is explained in the user\'s language, and what could not be done is listed', async () => {
    const { user } = mount()
    await ask(user)
    expect(screen.getByText('What I discarded')).toBeInTheDocument()
    const discarded = screen.getByText('Filter on colour').closest('li') as HTMLElement
    expect(discarded).toHaveTextContent('Filter on colour — Filter discarded: the field «colour» does not exist on Incident.')
    expect(screen.getByText('What I could not do')).toBeInTheDocument()
    expect(screen.getByText('Costs in other currencies are not converted.')).toBeInTheDocument()
  })

  it('a proposal without links, discards or notes shows none of those sections', async () => {
    apolloFinto.esiti['ProposeReportSection'] = { data: { proposeReportSection: { ...PROPOSAL, edges: [], discarded: [], notes: [] } } }
    const { user } = mount()
    await ask(user)
    expect(screen.queryByText(/→/)).not.toBeInTheDocument()
    expect(screen.queryByText('What I discarded')).not.toBeInTheDocument()
    expect(screen.queryByText('What I could not do')).not.toBeInTheDocument()
  })

  it('unreadable filters or discard parameters do not break the review: the problem is logged and the rest is shown', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.esiti['ProposeReportSection'] = { data: { proposeReportSection: {
      ...PROPOSAL,
      nodes: [{ ...PROPOSAL.nodes[0]!, filters: '{broken' }, { ...PROPOSAL.nodes[1]!, filters: '[]' }],
      discarded: [{ what: 'Something', key: 'reportProposal.discard.tooManyNodes', params: 'not json' }],
    } } }
    const { user } = mount()
    await ask(user)
    const incident = screen.getByText('Incident', { selector: 'span' }).closest('li') as HTMLElement
    expect(within(incident).queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByText('Something').closest('li')).toHaveTextContent(/^Something — Past .* entities the report graph stops being readable/)
    expect(consoleError).toHaveBeenCalledWith('Unreadable filters in a report proposal', expect.any(SyntaxError))
    expect(consoleError).toHaveBeenCalledWith('Unreadable params on a discarded proposal item', expect.any(SyntaxError))
  })

  it('«Put it in the builder» hands the whole proposal over and closes', async () => {
    const { user, onApplica, onChiudi } = mount()
    await ask(user)
    expect(screen.getByText(/you see the preview on your real data/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Put it in the builder' }))
    expect(onApplica).toHaveBeenCalledWith(PROPOSAL)
    expect(onChiudi).toHaveBeenCalledTimes(1)
  })

  it('«Edit the description» goes back to the box with the text as it was', async () => {
    const { user, onApplica } = mount()
    await ask(user, 'Average cost of open incidents by status')
    await user.click(screen.getByRole('button', { name: 'Edit the description' }))
    expect(description()).toHaveValue('Average cost of open incidents by status')
    expect(onApplica).not.toHaveBeenCalled()
  })

  it('Cancel on the review closes without applying', async () => {
    const { user, onApplica, onChiudi } = mount()
    await ask(user)
    await user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(onChiudi).toHaveBeenCalledTimes(1)
    expect(onApplica).not.toHaveBeenCalled()
  })
})
