/**
 * A PERSON'S PAGE (`/users/:id`): who they are, their role, their teams.
 *
 * An administrator comes here to change three things, and each one decides
 * what the person can do: the ROLE (chosen among the organization's roles),
 * whether the person is ACTIVE (a deactivated person cannot sign in and gets
 * no work, but keeps their history), and the TEAMS they belong to (which
 * decides what is assigned to them).
 *
 * What must not regress: deactivation is always confirmed first and never
 * offered on one's own page (an administrator must not lock themselves out);
 * the role is saved only when it really changes; a team is added or removed
 * by sending the WHOLE new list, built from the current one; and a person that
 * cannot be loaded is said, not shown as an empty page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { withVocabularyLabels } from '@/test/vocabularies'
import { apolloFinto } from '@/test/apolloFinto'
import { formatDate } from '@/lib/datetime'
import { UserDetailPage } from './UserDetailPage'

// The shared fake answers at once: a query named in `held` stays in flight.
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useQuery>[0]
  type Opts = Parameters<typeof m.useQuery>[1]
  return {
    ...m,
    useQuery: (doc: Doc, opts?: Opts) => {
      const r = m.useQuery(doc, opts)
      return held.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const person = (over: Record<string, unknown> = {}) => ({
  id: 'u2', tenantId: 'acme', name: 'Anna Bianchi', code: 'USR-0002', active: true, firstName: 'Anna', lastName: 'Bianchi',
  email: 'anna@acme.com', role: 'operator', roleName: null, slackId: 'U02ABC', createdAt: '2026-03-01T09:00:00Z',
  teams: [{ id: 't1', name: 'Network', type: 'support' }, { id: 't2', name: 'DBA', type: null }], ...over,
})

const me = (over: Record<string, unknown> = {}) => ({ me: {
  id: 'u1', name: 'Admin', email: 'admin@acme.com', role: 'admin', roleName: null, permissions: ['admin.users'],
  slackId: null, emailNotifications: true, language: null, teams: [], ...over,
} })

const ALL_TEAMS = [
  { id: 't1', name: 'Network', description: null, type: 'support' },
  { id: 't2', name: 'DBA', description: null, type: null },
  { id: 't3', name: 'Platform', description: 'Kubernetes and CI', type: 'owner' },
  { id: 't4', name: 'Service Desk', description: null, type: null },
]

const renderPage = () => renderWithProviders(
  withVocabularyLabels(<UserDetailPage />, { team_type: { support: 'Support', owner: 'Owner' } }),
  { route: '/users/u2', path: '/users/:id' },
)

/** The value shown under a field label. */
const fieldValue = (label: string) => screen.getByText(label, { selector: 'div' }).parentElement!.nextElementSibling!.textContent

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetUser'] = { user: person() }
  apolloFinto.risposte['GetTeams'] = { teams: ALL_TEAMS }
  apolloFinto.risposte['GetMe'] = me()
  apolloFinto.risposte['GetRoles'] = { roles: [
    { key: 'admin', name: null, permissions: [], isFactory: true, userCount: 1 },
    { key: 'operator', name: null, permissions: [], isFactory: true, userCount: 4 },
    { key: 'auditor', name: 'Auditor', permissions: [], isFactory: false, userCount: 0 },
  ] }
})

describe('who the person is', () => {
  it('shows name, role, code, names, e-mail, Slack and when the person was created, and asks for THIS person', () => {
    renderPage()
    expect(apolloFinto.chiamata('GetUser')).toEqual({ id: 'u2' })
    const heading = screen.getByRole('heading', { level: 1, name: 'Anna Bianchi' })
    // The role badge next to the name.
    expect(within(heading.parentElement!).getByText('Operator')).toBeInTheDocument()
    expect(fieldValue('ID')).toBe('u2')
    expect(fieldValue('Code')).toBe('USR-0002')
    expect(fieldValue('First name')).toBe('Anna')
    expect(fieldValue('Last name')).toBe('Bianchi')
    expect(fieldValue('Email')).toBe('anna@acme.com')
    expect(fieldValue('Slack ID')).toBe('U02ABC')
    expect(fieldValue('Created')).toBe(formatDate('2026-03-01T09:00:00Z'))
    expect(screen.getByRole('link', { name: /Users/ })).toHaveAttribute('href', '/users')
  })

  it('what is not known shows as a dash', () => {
    apolloFinto.risposte['GetUser'] = { user: person({ firstName: null, slackId: null, createdAt: null }) }
    renderPage()
    expect(fieldValue('First name')).toBe('—')
    expect(fieldValue('Slack ID')).toBe('—')
    expect(fieldValue('Created')).toBe('—')
  })

  it('while the person loads, it says so', () => {
    held.add('GetUser')
    renderPage()
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('a person that cannot be loaded shows the error, and Retry reloads', async () => {
    apolloFinto.erroriQuery['GetUser'] = new Error('users unavailable')
    const { user } = renderPage()
    expect(screen.getByText('users unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('a person that does not exist is said so', () => {
    apolloFinto.risposte['GetUser'] = { user: null }
    renderPage()
    expect(screen.getByText('User not found.')).toBeInTheDocument()
  })
})

describe('active or not', () => {
  it('deactivating asks first; declining changes nothing, confirming deactivates', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Deactivate' }))
    let dialog = screen.getByRole('dialog', { name: 'Deactivate Anna Bianchi?' })
    expect(within(dialog).getByText(/They will no longer be able to sign in/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamata('SetUserActive')).toBeUndefined()

    await user.click(screen.getByRole('button', { name: 'Deactivate' }))
    dialog = screen.getByRole('dialog', { name: 'Deactivate Anna Bianchi?' })
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }))
    expect(apolloFinto.chiamata('SetUserActive')).toEqual({ userId: 'u2', active: false })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Person deactivated'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a deactivated person is marked so, and can be reactivated after confirming', async () => {
    apolloFinto.risposte['GetUser'] = { user: person({ active: false }) }
    const { user } = renderPage()
    expect(screen.getByText('Deactivated')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reactivate' }))
    const dialog = screen.getByRole('dialog', { name: 'Reactivate Anna Bianchi?' })
    expect(within(dialog).getByText(/They will be able to sign in again/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Reactivate' }))
    expect(apolloFinto.chiamata('SetUserActive')).toEqual({ userId: 'u2', active: true })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Person reactivated'))
  })

  it('on one\'s own page there is no way to deactivate oneself', () => {
    apolloFinto.risposte['GetMe'] = me({ id: 'u2' })
    renderPage()
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull()
  })
})

describe('the role', () => {
  it('is chosen among the organization\'s roles, and saved only when it changes', async () => {
    const { user } = renderPage()
    const select = screen.getByRole('combobox', { name: 'Role' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Admin', 'Operator', 'Auditor'])
    expect(select).toHaveValue('operator')
    expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull()
    await user.selectOptions(select, 'auditor')
    await user.selectOptions(select, 'operator')
    // Back to the current role: nothing to save.
    expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull()
    await user.selectOptions(select, 'auditor')
    await user.click(screen.getByRole('button', { name: 'Save role' }))
    expect(apolloFinto.chiamata('SetUserRole')).toEqual({ userId: 'u2', role: 'auditor' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Role changed'))
    // Saved: the choice goes back to what the server says, and the button goes away.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull())
  })

  it('a role the API refuses (the last one that manages people) shows the API\'s reason', async () => {
    apolloFinto.esiti['SetUserRole'] = { error: new Error('The last administrator cannot lose the role') }
    const { user } = renderPage()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'auditor')
    await user.click(screen.getByRole('button', { name: 'Save role' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The last administrator cannot lose the role'))
  })

  it('without the roles of the organization the only choice is the current role', () => {
    apolloFinto.risposte['GetMe'] = me({ permissions: [] })
    renderPage()
    expect(apolloFinto.chiamata('GetRoles')).toBeUndefined()
    expect(within(screen.getByRole('combobox', { name: 'Role' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Operator'])
  })
})

describe('the teams', () => {
  it('lists the person\'s teams with the Dictionary name of their type, each one opening its page', () => {
    renderPage()
    expect(screen.getByText('Team (2)')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Network' })).toHaveAttribute('href', '/teams/t1')
    expect(screen.getByRole('link', { name: 'DBA' })).toHaveAttribute('href', '/teams/t2')
    expect(screen.getByText('Support')).toBeInTheDocument()
  })

  it('a team type the Dictionary does not have shows its value, and is reported as outside the vocabulary', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    apolloFinto.risposte['GetUser'] = { user: person({ teams: [{ id: 't9', name: 'Acme Hosting', type: 'vendor' }] }) }
    renderPage()
    expect(screen.getByText('vendor')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalledWith('[team_type] "vendor" is not in the vocabulary of this tenant (support, owner)')
  })

  // Review of 23 Sep 2026: one membership at a time — rewriting the whole set from the list last read reverted quick clicks.
  it('removing a team touches that membership only', async () => {
    const { user } = renderPage()
    const [removeNetwork] = screen.getAllByTitle('Remove from team')
    await user.click(removeNetwork!)
    expect(apolloFinto.chiamata('SetTeamMember')).toEqual({ teamId: 't1', userId: 'u2', member: false })
    expect(apolloFinto.chiamata('UpdateUserTeams')).toBeUndefined()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Teams updated'))
  })

  it('the remove button turns red under the pointer', () => {
    renderPage()
    const [remove] = screen.getAllByTitle('Remove from team')
    fireEvent.mouseEnter(remove!)
    expect(remove!.style.background).toBe('var(--color-danger-bg)')
    fireEvent.mouseLeave(remove!)
    expect(remove!.style.background).toBe('none')
  })

  it('adding offers only the teams the person is not in, and adds that membership only', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Add to a team' }))
    expect(screen.getByText('Available teams')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Network/ })).toBeNull()
    const platform = screen.getByRole('button', { name: /Platform/ })
    expect(within(platform).getByText('Kubernetes and CI')).toBeInTheDocument()
    expect(within(platform).getByText('Owner')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Service Desk/ })).toBeInTheDocument()
    await user.click(platform)
    expect(apolloFinto.chiamata('SetTeamMember')).toEqual({ teamId: 't3', userId: 'u2', member: true })
    expect(screen.queryByText('Available teams')).toBeNull()
  })

  it('the list of teams to add closes without adding', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Add to a team' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('Available teams')).toBeNull()
    expect(apolloFinto.chiamata('SetTeamMember')).toBeUndefined()
  })

  it('a person with no team, and no team left to add, are both said', async () => {
    apolloFinto.risposte['GetUser'] = { user: person({ teams: [] }) }
    apolloFinto.risposte['GetTeams'] = { teams: [] }
    const { user } = renderPage()
    expect(screen.getByText('No team assigned')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add to a team' }))
    expect(screen.getByText('No other team available')).toBeInTheDocument()
  })

  it('until the teams of the organization arrive there is nothing to add', async () => {
    delete apolloFinto.risposte['GetTeams']
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Add to a team' }))
    expect(screen.getByText('No other team available')).toBeInTheDocument()
  })

  it('a change of teams the API refuses shows its reason', async () => {
    apolloFinto.esiti['SetTeamMember'] = { error: new Error('team is archived') }
    const { user } = renderPage()
    await user.click(screen.getAllByTitle('Remove from team')[0]!)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('team is archived'))
  })
})
