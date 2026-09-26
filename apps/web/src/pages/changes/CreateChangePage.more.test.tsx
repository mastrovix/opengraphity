/**
 * CREATING A CHANGE: from scratch, or as the resolving RFC of a problem/incident.
 *
 * What breaks for a user if these regress:
 * - an RFC opened from a problem or an incident must arrive pre-filled (title,
 *   affected CIs) AND carry the link back, or the problem never moves to
 *   "change requested" and the incident never resolves by itself;
 * - the change must not be sendable while a required piece is missing (type,
 *   why, what, CIs), nor while a CI has no groups — the API would refuse it
 *   and the user would only find out at the end;
 * - the customer's required custom fields are checked before sending;
 * - a server rejection must be readable in the page, not only in a toast;
 * - the groups of a CI fixed in another tab are re-read, without having to
 *   remove and re-add the CI (V-1), and a failed re-read is reported.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within, fireEvent } from '@testing-library/react'
import { DomainVocabularyContext } from '@/contexts/DomainVocabularyContext'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { CreateChangePage } = await import('./CreateChangePage')

const CHANGE_TYPES = [
  { value: 'standard', label: 'Standard', labels: [] },
  { value: 'normal', label: 'Normal', labels: [] },
]

const GROUPS = { ownerGroup: { id: 't1' }, supportGroup: { id: 't2' } }
const DB = { id: 'ci-db', name: 'orders-db', type: 'database', environment: 'production', ...GROUPS }
const APP = { id: 'ci-app', name: 'orders-app', type: 'application', environment: 'staging', ...GROUPS }
const ORPHAN = { id: 'ci-orphan', name: 'legacy-box', type: 'server', environment: 'production', ownerGroup: null, supportGroup: { id: 't2' } }

function page(route = '/changes/new') {
  return renderWithProviders(
    <DomainVocabularyContext.Provider value={{
      valuesOf: () => null, labelOf: () => null, colorOf: () => null, vocabularyLabelOf: () => null,
      entriesOf: (n) => (n === 'change_type' ? CHANGE_TYPES : null), loading: false, error: null,
    }}>
      <CreateChangePage />
    </DomainVocabularyContext.Provider>,
    { route, path: '/changes/new' },
  )
}

// Restores the console spies some tests install.
afterEach(() => { vi.restoreAllMocks() })

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetPreApprovedChangeTypes'] = { preApprovedChangeTypes: { types: [] } }
  // D21: the owner is chosen among the active people whose role can work on
  // changes — the server answers with those only (searchUsers with the permission).
  apolloFinto.risposte['SearchUsers'] = { searchUsers: [{ id: 'u1', name: 'Ada Lovelace', email: 'ada@x' }] }
  apolloFinto.risposte['GetTicketCIExclusions'] = { ticketCIExclusions: [{ ticketType: 'change', ciTypes: ['person'] }] }
  apolloFinto.risposte['GetTicketCreationCustomFields'] = { ticketCreationCustomFields: [] }
  apolloFinto.risposte['GetAllCIs'] = { allCIs: { items: [DB, APP, ORPHAN] } }
  apolloFinto.esiti['CreateChange'] = { data: { createChange: { id: 'chg-9', code: 'CHG00000009' } } }
})

async function pickType(user: ReturnType<typeof page>['user'], label = 'Normal') {
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: new RegExp(label) }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

async function addCI(user: ReturnType<typeof page>['user'], name: string) {
  fireEvent.change(screen.getByPlaceholderText('Search a CI by name...'), { target: { value: name.slice(0, 5) } })
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }))
}

const submit = () => screen.getByRole('button', { name: 'Create the change' })

describe('CreateChangePage — writing a change from scratch', () => {
  it('stays disabled until type, title, why, what and a CI are all there, then sends them trimmed', async () => {
    const { user } = page()
    await pickType(user)
    expect(submit()).toBeDisabled()
    await user.type(screen.getByLabelText(/^Title/), '  Upgrade DB  ')
    await user.type(screen.getByLabelText(/^Why/), ' EOL ')
    await user.type(screen.getByLabelText(/^What/), ' pg 16 ')
    expect(submit()).toBeDisabled()
    await user.click(screen.getByRole('combobox', { name: 'Change owner' }))
    // The page asks the server for the people who can work on changes.
    expect(apolloFinto.chiamata('SearchUsers')).toMatchObject({ permission: 'change.write' })
    await user.type(screen.getByRole('combobox', { name: 'Change owner' }), 'ada')
    await user.click(screen.getByRole('option', { name: /Ada Lovelace/ }))
    await addCI(user, 'orders-db')
    // The search is cleared and the excluded CI types are never proposed.
    expect(screen.getByPlaceholderText('Search a CI by name...')).toHaveValue('')
    expect(apolloFinto.chiamata('GetAllCIs')).toMatchObject({ search: 'order', excludeCiTypes: ['person'] })
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateChange')).toBeDefined())
    expect(apolloFinto.chiamata('CreateChange')).toEqual({
      input: {
        title: 'Upgrade DB', why: 'EOL', what: 'pg 16', changeOwner: 'u1',
        affectedCIIds: ['ci-db'], changeType: 'normal', customFields: [],
      },
    })
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('CHG00000009'))
    await attendiURL('/changes/chg-9')
  })

  it('a CI already chosen is not proposed again, and a chip can be removed', async () => {
    const { user } = page()
    await pickType(user)
    await addCI(user, 'orders-db')
    fireEvent.change(screen.getByPlaceholderText('Search a CI by name...'), { target: { value: 'orders' } })
    expect(await screen.findByRole('button', { name: /orders-app/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^orders-db/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove orders-db' }))
    expect(screen.queryByRole('button', { name: 'Remove orders-db' })).not.toBeInTheDocument()
  })

  it('a single character does not search', async () => {
    page()
    fireEvent.change(screen.getByPlaceholderText('Search a CI by name...'), { target: { value: 'o' } })
    expect(apolloFinto.chiamata('GetAllCIs')).toBeUndefined()
    expect(screen.queryByRole('button', { name: /orders-db/ })).not.toBeInTheDocument()
  })

  it('without an owner the change is sent with changeOwner null (not an empty id)', async () => {
    const { user } = page()
    await pickType(user, 'Standard')
    await user.type(screen.getByLabelText(/^Title/), 't')
    await user.type(screen.getByLabelText(/^Why/), 'w')
    await user.type(screen.getByLabelText(/^What/), 'x')
    await addCI(user, 'orders-app')
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateChange')).toMatchObject({ input: { changeOwner: null, changeType: 'standard' } }))
  })

  it('a required custom field of the customer blocks the send and says so; filled, it travels with the change', async () => {
    apolloFinto.risposte['GetTicketCreationCustomFields'] = {
      ticketCreationCustomFields: [{ name: 'window', label: 'Maintenance window', fieldType: 'string', required: true, enumValues: [], enumTypeName: null, visibleToEndUser: false, value: null, editable: true }],
    }
    const { user } = page()
    await pickType(user)
    await user.type(screen.getByLabelText(/^Title/), 't')
    await user.type(screen.getByLabelText(/^Why/), 'w')
    await user.type(screen.getByLabelText(/^What/), 'x')
    await addCI(user, 'orders-db')
    await user.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('Required field')
    expect(apolloFinto.chiamata('CreateChange')).toBeUndefined()
    await user.type(screen.getByLabelText(/Maintenance window/), ' Sat 22:00 ')
    // Typing clears the error on that field.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateChange')).toMatchObject({ input: { customFields: [{ name: 'window', value: 'Sat 22:00' }] } }))
  })

  it('a server rejection is shown in the page and the user stays on the form', async () => {
    apolloFinto.esiti['CreateChange'] = { error: new Error('CI orders-db is frozen') }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { user } = page()
    await pickType(user)
    await user.type(screen.getByLabelText(/^Title/), 't')
    await user.type(screen.getByLabelText(/^Why/), 'w')
    await user.type(screen.getByLabelText(/^What/), 'x')
    await addCI(user, 'orders-db')
    await user.click(submit())
    // Once in the banner, once through the (non-central) error toast.
    expect(await screen.findAllByText('CI orders-db is frozen')).not.toHaveLength(0)
    expect(toast.error).toHaveBeenCalledWith('CI orders-db is frozen')
    await attendiURL('/changes/new')
  })

  it('fields highlight while focused: they are the app\'s fields, lit by the .og-field:focus rule (26 Sep 2026)', async () => {
    const { user } = page()
    await pickType(user)
    for (const label of [/^Title/, /^Why/, /^What/]) {
      expect(screen.getByLabelText(label)).toHaveClass('og-field')
    }
    expect(screen.getByPlaceholderText('Search a CI by name...')).toHaveClass('og-field')
  })
})

describe('CreateChangePage — leaving and the type modal', () => {
  it('leaving the type modal without choosing goes back to the list: a change without type does not exist', async () => {
    const { user } = page()
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await attendiURL('/changes')
  })

  it('reopening the modal and cancelling keeps the type already chosen', async () => {
    const { user } = page()
    await pickType(user, 'Standard')
    await user.click(screen.getByRole('button', { name: 'Change' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('Standard')).toBeInTheDocument()
    await attendiURL('/changes/new')
  })

  it('the back link and Cancel both return to the list', async () => {
    const first = page()
    await pickType(first.user)
    await first.user.click(screen.getByRole('button', { name: 'Changes' }))
    await attendiURL('/changes')
    first.unmount()
    const second = page()
    await pickType(second.user)
    await second.user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    await attendiURL('/changes')
  })
})

describe('CreateChangePage — RFC from a problem or an incident', () => {
  it('from a problem: title and CIs are pre-filled, the banner explains, and the link travels with the change', async () => {
    apolloFinto.risposte['GetProblem'] = { problem: { id: 'p1', number: 'PRB0001', title: 'Disk full', affectedCIs: [DB] } }
    const { user } = page('/changes/new?problemId=p1')
    await pickType(user)
    expect(apolloFinto.chiamata('GetProblem')).toEqual({ id: 'p1' })
    expect(apolloFinto.chiamata('GetIncident')).toBeUndefined()
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Resolution of problem PRB0001: Disk full')
    expect(screen.getByText(/Resolving RFC for problem PRB0001 — Disk full\./)).toHaveTextContent(/moves to change requested/)
    expect(screen.getByRole('button', { name: 'Remove orders-db' })).toBeInTheDocument()
    // The pre-fill happens once: the user may rewrite the title freely.
    await user.clear(screen.getByLabelText(/^Title/))
    await user.type(screen.getByLabelText(/^Title/), 'Grow the disk')
    await user.type(screen.getByLabelText(/^Why/), 'w')
    await user.type(screen.getByLabelText(/^What/), 'x')
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateChange')).toMatchObject({
      input: { title: 'Grow the disk', problemId: 'p1', affectedCIIds: ['ci-db'] },
    }))
    expect((apolloFinto.chiamata('CreateChange')!['input'] as Record<string, unknown>)['incidentId']).toBeUndefined()
  })

  it('from an incident: the banner says it will resolve by itself, and incidentId travels', async () => {
    apolloFinto.risposte['GetIncident'] = { incident: { id: 'i1', number: 'INC0042', title: 'Site down', affectedCIs: null } }
    const { user } = page('/changes/new?incidentId=i1')
    await pickType(user)
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Resolution of incident INC0042: Site down')
    expect(screen.getByText(/Resolving RFC for incident INC0042/)).toHaveTextContent(/resolves by itself/)
    await user.type(screen.getByLabelText(/^Why/), 'w')
    await user.type(screen.getByLabelText(/^What/), 'x')
    await addCI(user, 'orders-app')
    await user.click(submit())
    await waitFor(() => expect(apolloFinto.chiamata('CreateChange')).toMatchObject({ input: { incidentId: 'i1' } }))
  })
})

describe('CreateChangePage — CIs without groups', () => {
  it('a CI without groups blocks the send and is named; the recheck clears it when the groups arrived', async () => {
    apolloFinto.query.mockResolvedValue({ data: { ciById: { id: 'ci-orphan', ...GROUPS } } })
    const { user } = page()
    await pickType(user)
    await user.type(screen.getByLabelText(/^Title/), 't')
    await user.type(screen.getByLabelText(/^Why/), 'w')
    await user.type(screen.getByLabelText(/^What/), 'x')
    await addCI(user, 'legacy-box')
    expect(screen.getByRole('alert')).toHaveTextContent('legacy-box')
    expect(submit()).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(apolloFinto.query).toHaveBeenCalledWith(expect.objectContaining({ variables: { id: 'ci-orphan' }, fetchPolicy: 'network-only' }))
    expect(submit()).toBeEnabled()
  })

  it('a CI that is still without groups (or gone) stays blocked after the recheck', async () => {
    apolloFinto.query.mockResolvedValue({ data: { ciById: null } })
    const { user } = page()
    await pickType(user)
    await addCI(user, 'legacy-box')
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent('legacy-box')
  })

  it('returning to the window re-reads the groups by itself', async () => {
    apolloFinto.query.mockResolvedValue({ data: { ciById: { id: 'ci-orphan', ...GROUPS } } })
    const { user } = page()
    await pickType(user)
    await addCI(user, 'legacy-box')
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('a hidden tab does not trigger the re-read', async () => {
    const { user } = page()
    await pickType(user)
    await addCI(user, 'legacy-box')
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(apolloFinto.query).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(document, 'visibilityState', original)
      else delete (document as unknown as Record<string, unknown>)['visibilityState']
    }
  })

  it('a failed re-read is reported and the button is usable again', async () => {
    apolloFinto.query.mockRejectedValue(new Error('network down'))
    const { user } = page()
    await pickType(user)
    await addCI(user, 'legacy-box')
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'))
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
  })
})
