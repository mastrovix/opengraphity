/**
 * EventActions: the paths the first test file does not walk.
 *
 * An operator uses these buttons dozens of times a day, straight from the
 * console row. What must not regress:
 *  - "Re-evaluate now" tells the outcome in words, and an empty answer is an
 *    error, not a silent success;
 *  - "Open incident" asks first, does nothing on "cancel", and on success
 *    lands on the new incident (otherwise the operator has to hunt for it);
 *  - `only` / `exclude` really pick the actions, so the detail page never
 *    shows the same action twice, and a row with no possible action renders
 *    nothing at all;
 *  - "Link to CI" is honest about aliases: for a resource kind that cannot
 *    carry one there is no checkbox and the request never asks for one;
 *  - a failure keeps the dialog open and says what went wrong.
 *
 * The fake Apollo answers by operation name: these tests are about what the
 * component does with the answers, not about the exact documents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { apolloFinto } from '@/test/apolloFinto'
import { renderWithProviders } from '@/test/utils'
import type { EventRow } from '@/types/events'
import { EventActions } from './EventActions'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const EVENT: EventRow = {
  id: 'e1', status: 'firing', severity: 'critical', title: 'Disk full on db-99', resource: 'db-99', resourceKind: 'hostname',
  count: 3, lastSeenAt: '2026-09-09T08:00:00Z', acknowledgedAt: null,
  source: { id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
  ci: null, incident: null, suppressedBy: null, correlation: 'skipped_orphan', correlationAt: '2026-09-09T08:00:00Z',
  flappingSince: null, transitions24h: 0, matchReason: 'ambiguous',
}

const CIS = [
  { id: 'ci-a', name: 'db-99', type: 'server', status: 'active', environment: 'production' },
  { id: 'ci-b', name: 'db-99-replica', type: 'server', status: 'active', environment: 'staging' },
]

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

function renderActions(props: Partial<Parameters<typeof EventActions>[0]> = {}) {
  const onChanged = vi.fn()
  const utils = renderWithProviders(<EventActions event={EVENT} onChanged={onChanged} {...props} />)
  return { ...utils, onChanged }
}

describe('EventActions — re-evaluate', () => {
  it('names the outcome of the re-evaluation and refreshes the caller', async () => {
    apolloFinto.esiti['ReevaluateEvent'] = { data: { reevaluateEvent: { ...EVENT, correlation: 'attached' } } }
    const { user, onChanged } = renderActions()
    await user.click(screen.getByRole('button', { name: 'Re-evaluate now' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Alarm re-evaluated: attached to the incident'))
    expect(apolloFinto.chiamata('ReevaluateEvent')).toEqual({ id: 'e1' })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('an answer without an outcome is reported as a failure, not as a success', async () => {
    apolloFinto.esiti['ReevaluateEvent'] = { data: { reevaluateEvent: { ...EVENT, correlation: null } } }
    const { user, onChanged } = renderActions()
    await user.click(screen.getByRole('button', { name: 'Re-evaluate now' }))
    // Its own words: a re-evaluation creates no incident, so it must not say
    // «Incident created» (the shared text it used until 23 Sep 2026).
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: The server answered without the outcome of the re-evaluation'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('is not offered when the correlation cannot be re-evaluated', () => {
    renderActions({ event: { ...EVENT, correlation: 'attached' } })
    expect(screen.queryByRole('button', { name: 'Re-evaluate now' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument()
  })
})

describe('EventActions — acknowledge', () => {
  it('a refused acknowledgement says why and does not refresh', async () => {
    apolloFinto.esiti['AcknowledgeEvent'] = { error: new Error('not allowed') }
    const { user, onChanged } = renderActions({ only: ['acknowledge'] })
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: not allowed'))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('an already acknowledged alarm offers no second acknowledgement', () => {
    renderActions({ event: { ...EVENT, acknowledgedAt: '2026-09-09T08:30:00Z' } })
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull()
  })
})

describe('EventActions — open incident', () => {
  it('cancelling the confirmation creates nothing', async () => {
    const { user } = renderActions({ only: ['openIncident'] })
    await user.click(screen.getByRole('button', { name: 'Open incident' }))
    const dialog = await screen.findByRole('dialog')
    // The body of the confirmation is the alarm title: the operator sees WHAT becomes an incident.
    expect(within(dialog).getByText('Disk full on db-99')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamata('CreateIncidentFromEvent')).toBeUndefined()
  })

  it('confirmed: creates the incident, announces its number and navigates to it', async () => {
    apolloFinto.esiti['CreateIncidentFromEvent'] = { data: { createIncidentFromEvent: { id: 'inc-7', number: 'INC00000007' } } }
    const { user, onChanged } = renderActions({ only: ['openIncident'] })
    await user.click(screen.getByRole('button', { name: 'Open incident' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/incidents/inc-7'))
    expect(apolloFinto.chiamata('CreateIncidentFromEvent')).toEqual({ eventId: 'e1' })
    expect(toast.success).toHaveBeenCalledWith('Incident INC00000007 created')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('an empty answer is an error and does not navigate anywhere', async () => {
    apolloFinto.esiti['CreateIncidentFromEvent'] = { data: { createIncidentFromEvent: null } }
    const { user, onChanged } = renderActions({ only: ['openIncident'] })
    await user.click(screen.getByRole('button', { name: 'Open incident' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: Incident created but empty response'))
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('a suppressed alarm, or one that already has an incident, cannot open another', () => {
    const { unmount } = renderActions({ event: { ...EVENT, correlation: 'suppressed' } })
    expect(screen.queryByRole('button', { name: 'Open incident' })).toBeNull()
    unmount()
    renderActions({ event: { ...EVENT, incident: { id: 'i1', number: 'INC1', status: 'new' } } as unknown as EventRow })
    expect(screen.queryByRole('button', { name: 'Open incident' })).toBeNull()
  })
})

describe('EventActions — which actions are shown', () => {
  it('not compact: every action carries its visible label', () => {
    renderActions()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Re-evaluate now', 'Acknowledge', 'Resolve', 'Open incident', 'Link to CI',
    ])
  })

  it('`exclude` removes exactly the actions named', () => {
    renderActions({ exclude: ['reevaluate', 'openIncident'] })
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Acknowledge', 'Resolve', 'Link to CI'])
  })

  it('renders nothing when no action is possible', () => {
    // Resolved, already linked to a CI and not re-evaluable: an empty container
    // would still take space in the row, so the component must render null.
    const { container } = renderWithProviders(
      <EventActions event={{ ...EVENT, status: 'resolved', correlation: 'attached', ci: { id: 'c', name: 'x' } } as unknown as EventRow} />,
    )
    expect(container.querySelector('button')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('EventActions — resolve dialog', () => {
  it('cancel closes the dialog without resolving; a blank note is sent as null', async () => {
    const { user, onChanged } = renderActions({ only: ['resolve'] })
    await user.click(screen.getByRole('button', { name: 'Resolve' }))
    let dialog = await screen.findByRole('dialog', { name: 'Resolve alarm' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamata('ResolveEvent')).toBeUndefined()

    await user.click(screen.getByRole('button', { name: 'Resolve' }))
    dialog = await screen.findByRole('dialog', { name: 'Resolve alarm' })
    await user.type(within(dialog).getByLabelText('Note (optional)'), '   ')
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }))
    // Whitespace is not a note: the history must not show an empty comment.
    await waitFor(() => expect(apolloFinto.chiamata('ResolveEvent')).toEqual({ id: 'e1', note: null }))
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('EventActions — dialogs close with Escape', () => {
  it('Escape closes both dialogs without sending anything', async () => {
    const { user } = renderActions({ only: ['resolve', 'linkCI'] })
    await user.click(screen.getByRole('button', { name: 'Resolve' }))
    await screen.findByRole('dialog', { name: 'Resolve alarm' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Link to CI' }))
    await screen.findByRole('dialog', { name: 'Link to a CI' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate).toEqual({})
  })
})

describe('EventActions — link to CI dialog', () => {
  it('a resource kind without aliases: no checkbox, a line explains why, and no alias is requested', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: CIS } }
    apolloFinto.esiti['LinkEventToCI'] = { data: { linkEventToCI: { id: 'e1' } } }
    const { user, onChanged } = renderActions({ event: { ...EVENT, resourceKind: 'name' }, only: ['linkCI'] })
    await user.click(screen.getByRole('button', { name: 'Link to CI' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link to a CI' })
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    expect(within(dialog).getByText(/an alias can only be remembered for a hostname/)).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('Search CI'), 'db-99')
    const replica = (await within(dialog).findByText('db-99-replica')).closest('button')!
    await user.click(replica)
    await user.click(within(dialog).getByRole('button', { name: 'Link to CI' }))
    await waitFor(() => expect(apolloFinto.chiamata('LinkEventToCI')).toEqual({ eventId: 'e1', ciId: 'ci-b', createAlias: false }))
    expect(toast.success).toHaveBeenCalledWith('Alarm linked to db-99-replica')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('unticking "remember" sends createAlias=false even for an aliasable kind', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: CIS } }
    const { user } = renderActions({ only: ['linkCI'] })
    await user.click(screen.getByRole('button', { name: 'Link to CI' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link to a CI' })
    await user.click(within(dialog).getByRole('checkbox', { name: /Remember this name/ }))
    await user.type(within(dialog).getByLabelText('Search CI'), 'db-99')
    await user.click((await within(dialog).findByText('db-99')).closest('button')!)
    await user.click(within(dialog).getByRole('button', { name: 'Link to CI' }))
    await waitFor(() => expect(apolloFinto.chiamata('LinkEventToCI')).toEqual({ eventId: 'e1', ciId: 'ci-a', createAlias: false }))
  })

  it('typing again clears the selection, so a stale choice cannot be linked', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: CIS } }
    const { user } = renderActions({ only: ['linkCI'] })
    await user.click(screen.getByRole('button', { name: 'Link to CI' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link to a CI' })
    const submit = within(dialog).getByRole('button', { name: 'Link to CI' })
    await user.type(within(dialog).getByLabelText('Search CI'), 'db-99')
    await user.click((await within(dialog).findByText('db-99')).closest('button')!)
    expect(submit).toBeEnabled()
    await user.type(within(dialog).getByLabelText('Search CI'), 'x')
    expect(submit).toBeDisabled()
  })

  it('no match says "No results"; a search error is shown as an alert', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [] } }
    const { user, unmount } = renderActions({ only: ['linkCI'] })
    await user.click(screen.getByRole('button', { name: 'Link to CI' }))
    let dialog = await screen.findByRole('dialog', { name: 'Link to a CI' })
    await user.type(within(dialog).getByLabelText('Search CI'), 'zz')
    const list = within(dialog).getByRole('list', { name: 'CI search results' })
    // Until the debounce catches up the list says "loading", never "no results" for an old search.
    expect(within(list).getByText('Loading...')).toBeInTheDocument()
    expect(await within(list).findByText('No results')).toBeInTheDocument()
    unmount()

    apolloFinto.erroriQuery['GetAllCIs'] = new Error('search is down')
    const second = renderActions({ only: ['linkCI'] })
    await second.user.click(screen.getByRole('button', { name: 'Link to CI' }))
    dialog = await screen.findByRole('dialog', { name: 'Link to a CI' })
    await second.user.type(within(dialog).getByLabelText('Search CI'), 'db')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('search is down')
  })

  it('a failed link keeps the dialog open; cancel then closes it', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: CIS } }
    apolloFinto.esiti['LinkEventToCI'] = { error: new Error('CI is retired') }
    const { user, onChanged } = renderActions({ only: ['linkCI'] })
    await user.click(screen.getByRole('button', { name: 'Link to CI' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link to a CI' })
    await user.type(within(dialog).getByLabelText('Search CI'), 'db-99')
    await user.click((await within(dialog).findByText('db-99')).closest('button')!)
    await user.click(within(dialog).getByRole('button', { name: 'Link to CI' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: CI is retired'))
    expect(screen.getByRole('dialog', { name: 'Link to a CI' })).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
