/**
 * Users page, the parts UsersPage.test.tsx does not reach: CREATING a user
 * and the team picker inside the form, plus the few states of the list that
 * change what an admin believes (a deactivated account, a load error).
 *
 * Why they matter:
 * - the form must send exactly what the API's `CreateUserInput` takes: the
 *   full name built from first + last, the chosen role (the organization's
 *   own, F-29: never a hard-wired one) and the chosen teams, once each;
 * - the team picker offers only teams not chosen yet and lets a chip be
 *   removed: a user silently created in the wrong team gets the wrong queue;
 * - a deactivated account must look deactivated in the list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { meFixture } from '@/test/mocks/gql'
import { UsersPage } from './UsersPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const USERS = [
  { id: 'u1', name: 'Mario Rossi', email: 'mario@acme.com', role: 'admin', roleName: null, active: true, createdAt: '2026-09-01T10:00:00Z' },
  { id: 'u2', name: 'Old Account', email: 'old@acme.com', role: 'viewer', roleName: null, active: false, createdAt: null },
]
const TEAMS = [
  { id: 't1', name: 'Network Ops', description: 'Routers and switches', type: 'support' },
  { id: 't2', name: 'Service Desk', description: null, type: null },
  { id: 't3', name: 'Database Admins', description: null, type: 'support' },
]
const ROLES = [
  { key: 'operator', name: null, permissions: [], isFactory: true, userCount: 1 },
  { key: 'auditor', name: 'Auditor', permissions: [], isFactory: false, userCount: 0 },
]

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  apolloFinto.risposte['GetMe'] = { me: meFixture('admin') }
  apolloFinto.risposte['GetUsers'] = { users: USERS }
  apolloFinto.risposte['GetTeams'] = { teams: TEAMS }
  apolloFinto.risposte['GetRoles'] = { roles: ROLES }
})

async function openForm() {
  const view = renderWithProviders(<UsersPage />, { route: '/users' })
  await view.user.click(screen.getByRole('button', { name: 'New User' }))
  return { ...view, dialog: screen.getByRole('dialog', { name: 'New user' }) }
}

describe('UsersPage — list states', () => {
  it('a deactivated account carries a «Deactivated» mark next to its name', () => {
    renderWithProviders(<UsersPage />, { route: '/users' })
    const row = screen.getByText('Old Account').closest('tr')!
    expect(within(row).getByText('Deactivated')).toBeInTheDocument()
    expect(within(screen.getByText('Mario Rossi').closest('tr')!).queryByText('Deactivated')).not.toBeInTheDocument()
  })

  it('a load error offers a retry that reloads the list', async () => {
    apolloFinto.risposte['GetUsers'] = undefined
    apolloFinto.erroriQuery['GetUsers'] = new Error('users unavailable')
    const { user } = renderWithProviders(<UsersPage />, { route: '/users' })
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('UsersPage — create user', () => {
  it('starts on the organization\'s first role and sends name, email, password, chosen role and teams', async () => {
    apolloFinto.esiti['CreateUser'] = { data: { createUser: { id: 'u9', name: 'Jane Smith', email: 'jane@acme.com', role: 'auditor' } } }
    const { user, dialog } = await openForm()
    const role = within(dialog).getByLabelText(/^Role/)
    // F-29: the default is the first role the organization HAS, not a hard-wired one.
    expect(role).toHaveValue('operator')
    await user.selectOptions(role, 'auditor')

    await user.type(within(dialog).getByPlaceholderText('jane@acme.com'), 'jane@acme.com')
    await user.type(within(dialog).getByPlaceholderText('Jane'), ' Jane')
    await user.type(within(dialog).getByPlaceholderText('Smith'), 'Smith ')
    await user.type(within(dialog).getByPlaceholderText('At least 8 characters'), 'password1')

    const search = within(dialog).getByRole('searchbox', { name: 'Search teams…' })
    await user.type(search, 'ops')
    const options = within(within(dialog).getByRole('listbox')).getAllByRole('option')
    // Only teams whose name matches, with their type and description to tell them apart.
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Network Ops(support)Routers and switches')
    await user.click(options[0]!)
    expect(search).toHaveValue('')
    expect(within(dialog).getByText('Network Ops (support)')).toBeInTheDocument()

    await user.type(search, 'desk')
    await user.click(within(dialog).getByRole('option', { name: /Service Desk/ }))

    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(apolloFinto.chiamata('CreateUser')).toEqual({ input: {
      name: 'Jane Smith', email: 'jane@acme.com', password: 'password1', role: 'auditor', teamIds: ['t1', 't2'],
    } })
    expect(toast.success).toHaveBeenCalledWith('User created')
    // The form closes on success and the list is reloaded to show the new user.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a chosen team leaves the suggestions, and removing its chip brings it back', async () => {
    const { user, dialog } = await openForm()
    const search = within(dialog).getByRole('searchbox', { name: 'Search teams…' })
    await user.type(search, 'a')
    await user.click(within(dialog).getByRole('option', { name: /Database Admins/ }))

    await user.type(search, 'a')
    expect(within(dialog).queryByRole('option', { name: /Database Admins/ })).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Remove Database Admins' }))
    expect(within(dialog).queryByText('Database Admins (support)')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: /Database Admins/ })).toBeInTheDocument()
  })

  it('a search that matches nothing shows no empty dropdown', async () => {
    const { user, dialog } = await openForm()
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search teams…' }), 'zzz')
    expect(within(dialog).queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('a team without a type is shown by name only; a chosen team that vanished from the list draws no nameless chip', async () => {
    const { user, dialog } = await openForm()
    const search = within(dialog).getByRole('searchbox', { name: 'Search teams…' })
    await user.type(search, 'desk')
    await user.click(within(dialog).getByRole('option', { name: /Service Desk/ }))
    expect(within(dialog).getByRole('button', { name: 'Remove Service Desk' }).parentElement).toHaveTextContent(/^Service Desk$/)

    // The team list reloads without it (deleted meanwhile): the next render drops the chip.
    apolloFinto.risposte['GetTeams'] = { teams: TEAMS.filter((t) => t.id !== 't2') }
    await user.type(search, 'x')
    expect(within(dialog).queryByRole('button', { name: 'Remove Service Desk' })).not.toBeInTheDocument()
  })

  it('while the roles are still loading the role picker offers nothing to pick', async () => {
    apolloFinto.risposte['GetRoles'] = undefined
    const { dialog } = await openForm()
    const role = within(dialog).getByLabelText(/^Role/)
    expect(within(role).getAllByRole('option').map((o) => o.textContent)).toEqual(['Loading...'])
    // Without a role the user cannot be created.
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('the dialog\'s own close button closes it', async () => {
    const { user, dialog } = await openForm()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
