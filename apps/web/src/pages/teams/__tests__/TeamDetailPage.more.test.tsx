/**
 * TEAM DETAIL: sourcing, type, manager, Change Manager flag, CIs.
 *
 * The team page is where the facts that route work are written: the manager
 * receives escalations, the Change Manager team approves normal and emergency
 * changes, Sourcing decides whether a team can be the supplier of a UC. If
 * any of these writes the wrong thing, or silently loses the "are you sure"
 * step, tickets are routed to nobody. The existing test covers adding and
 * removing members; this one covers the rest of what an administrator does
 * here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))

// The team type is a customer vocabulary: each test decides what the dictionary holds.
const vocab = vi.hoisted(() => ({ entries: [] as Array<{ value: string; label: string | null }> }))
vi.mock('@/contexts/DomainVocabularyContext', () => ({
  useDomainVocabularies: () => ({
    entriesOf: () => vocab.entries,
    valuesOf: () => vocab.entries.map((e) => e.value),
    labelOf: (_v: string, value: string) => vocab.entries.find((e) => e.value === value)?.label ?? null,
    colorOf: () => null,
  }),
}))

const { TeamDetailPage } = await import('../TeamDetailPage')

const member = (id: string, name: string, role = 'operator') => ({ id, name, email: `${id}@example.com`, role })
const baseTeam = {
  id: 'team-1', name: 'Network', description: 'Routers and links', type: null as string | null, sourcing: null as string | null,
  createdAt: '2026-09-01T00:00:00Z', isChangeManager: false as boolean | null,
  manager: null as { id: string; name: string; email: string } | null,
  members: [member('u-1', 'Anna Rossi', 'l2_support'), member('u-2', 'Bruno Verdi')],
  ownedCIs: [] as Array<Record<string, string>>, supportedCIs: [] as Array<Record<string, string>>,
}
const withTeam = (over: Partial<typeof baseTeam> = {}) => { apolloFinto.risposte['GetTeam'] = { team: { ...baseTeam, ...over } } }

const show = () => renderWithProviders(<TeamDetailPage />, { route: '/teams/team-1', path: '/teams/:id' })
const location = () => screen.getByTestId('location').textContent

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
  vocab.entries = []
  withTeam()
})

describe('loading states', () => {
  it('a team that does not exist says so instead of rendering an empty page', () => {
    apolloFinto.risposte['GetTeam'] = { team: null }
    show()
    expect(screen.getByText('Team not found.')).toBeInTheDocument()
  })

  it('a failed load shows the error and retries on request', async () => {
    apolloFinto.erroriQuery['GetTeam'] = new Error('network down')
    const { user } = show()
    expect(screen.getByText(/network down/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry|try again/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('information', () => {
  it('shows the header, and a member role by its organization name when roles are readable', () => {
    apolloFinto.risposte['GetMe'] = { me: { id: 'me', name: 'Admin', email: 'a@x', role: 'admin', permissions: ['admin.users'] } }
    apolloFinto.risposte['GetRoles'] = { roles: [{ key: 'l2_support', name: 'L2 Support', permissions: [], isFactory: false, userCount: 1 }] }
    show()
    expect(screen.getByRole('heading', { name: 'Network' })).toBeInTheDocument()
    expect(screen.getByText('Routers and links')).toBeInTheDocument()
    // F-29: the role NAME, not the technical key.
    expect(screen.getByText('L2 Support')).toBeInTheDocument()
    expect(screen.queryByText('l2_support')).toBeNull()
  })

  it('a team without Sourcing offers "not set" only as the current state, and choosing a value saves it', async () => {
    const { user } = show()
    const sourcing = screen.getByRole('combobox', { name: 'Sourcing' })
    expect(sourcing).toHaveValue('')
    expect(within(sourcing).getByRole('option', { name: '— not set —' })).toBeDisabled()
    await user.selectOptions(sourcing, 'external')
    expect(apolloFinto.chiamata('UpdateTeam')).toEqual({ id: 'team-1', input: { sourcing: 'external' } })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Team updated'))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a team with Sourcing no longer offers "not set": it can be changed, not removed', () => {
    withTeam({ sourcing: 'internal' })
    show()
    const sourcing = screen.getByRole('combobox', { name: 'Sourcing' })
    expect(sourcing).toHaveValue('internal')
    expect(within(sourcing).queryByRole('option', { name: '— not set —' })).toBeNull()
  })

  it('without a team-type vocabulary the type is read-only and the page says where to add values', () => {
    withTeam({ type: 'vendor' })
    show()
    expect(screen.queryByRole('combobox', { name: 'Type' })).toBeNull()
    expect(screen.getByText('vendor')).toBeInTheDocument()
    expect(screen.getByText(/No team type in the dictionary/)).toBeInTheDocument()
  })

  it('without a vocabulary and without a type, a dash stands in for the badge', () => {
    show()
    const typeField = screen.getByText(/No team type in the dictionary/).parentElement!
    expect(within(typeField).getByText('—')).toBeInTheDocument()
  })

  it('with a vocabulary the type is chosen from it, by label, and saved', async () => {
    vocab.entries = [{ value: 'owner', label: 'Owner team' }, { value: 'support', label: null }]
    const { user } = show()
    const type = screen.getByRole('combobox', { name: 'Type' })
    expect(within(type).getAllByRole('option').map((o) => o.textContent)).toEqual(['— no type —', 'Owner team', 'support'])
    await user.selectOptions(type, 'support')
    expect(apolloFinto.chiamata('UpdateTeam')).toEqual({ id: 'team-1', input: { type: 'support' } })
  })

  it('a team that already has a type cannot go back to "no type"', () => {
    vocab.entries = [{ value: 'owner', label: 'Owner team' }]
    withTeam({ type: 'owner' })
    show()
    expect(within(screen.getByRole('combobox', { name: 'Type' })).queryByRole('option', { name: '— no type —' })).toBeNull()
  })

  it('a failed update is reported', async () => {
    apolloFinto.esiti['UpdateTeam'] = { error: new Error('sourcing refused') }
    const { user } = show()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sourcing' }), 'internal')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sourcing refused'))
  })
})

describe('Change Manager team', () => {
  it('ticking the box makes this team the one that approves changes', async () => {
    const { user } = show()
    await user.click(screen.getByRole('checkbox', { name: 'Make it the Change Manager team' }))
    expect(apolloFinto.chiamata('SetChangeManagerTeam')).toEqual({ teamId: 'team-1', value: true })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Change Manager team updated'))
  })

  it('unticking it removes the role', async () => {
    withTeam({ isChangeManager: true })
    const { user } = show()
    await user.click(screen.getByRole('checkbox', { name: /This team approves changes/ }))
    expect(apolloFinto.chiamata('SetChangeManagerTeam')).toEqual({ teamId: 'team-1', value: false })
  })

  it('a refusal is reported', async () => {
    apolloFinto.esiti['SetChangeManagerTeam'] = { error: new Error('not allowed') }
    const { user } = show()
    await user.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not allowed'))
  })
})

describe('manager', () => {
  it('a team without a manager assigns one directly from its members, filtered by name or email', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Assign' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Assign manager')).toBeInTheDocument()
    await user.type(within(dialog).getByRole('textbox', { name: 'Search a member...' }), 'u-2@EXAMPLE')
    expect(within(dialog).queryByRole('button', { name: /Anna Rossi/ })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: /Bruno Verdi/ }))
    expect(apolloFinto.chiamata('SetTeamManager')).toEqual({ teamId: 'team-1', userId: 'u-2' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast.success).toHaveBeenCalledWith('Manager updated')
  })

  it('a search that matches nobody says so', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Assign' }))
    await user.type(screen.getByRole('textbox', { name: 'Search a member...' }), 'zzz')
    expect(screen.getByText('No member found')).toBeInTheDocument()
  })

  it('replacing an existing manager asks to confirm first, naming both people', async () => {
    withTeam({ manager: { id: 'u-1', name: 'Anna Rossi', email: 'u-1@example.com' } })
    const { user } = show()
    expect(screen.getByRole('link', { name: 'Anna Rossi' })).toHaveAttribute('href', '/users/u-1')
    await user.click(screen.getByRole('button', { name: 'Change' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Change manager')).toBeInTheDocument()
    // The current manager is not a candidate to replace themself.
    expect(within(dialog).queryByRole('button', { name: /Anna Rossi/ })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: /Bruno Verdi/ }))
    expect(apolloFinto.chiamate['SetTeamManager']).toBeUndefined()
    expect(dialog).toHaveTextContent('The current manager Anna Rossi will be replaced by Bruno Verdi. Confirm?')
    // Cancelling the banner goes back to the list, still without writing.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).getByRole('textbox', { name: 'Search a member...' })).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /Bruno Verdi/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    expect(apolloFinto.chiamata('SetTeamManager')).toEqual({ teamId: 'team-1', userId: 'u-2' })
  })

  it('closing the manager dialog writes nothing', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Assign' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['SetTeamManager']).toBeUndefined()
  })

  it('a refused assignment is reported', async () => {
    apolloFinto.esiti['SetTeamManager'] = { error: new Error('user left') }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Assign' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Bruno Verdi/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('user left'))
  })

  it('removing the manager asks first (F-43); cancelling keeps them', async () => {
    withTeam({ manager: { id: 'u-1', name: 'Anna Rossi', email: 'u-1@example.com' } })
    const { user } = show()
    const remove = screen.getByRole('button', { name: 'Remove manager' })
    await user.hover(remove)
    await user.unhover(remove)
    await user.click(remove)
    expect(await screen.findByText(/Remove the manager of «Network»\?/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText(/Remove the manager of «Network»\?/)).toBeNull())
    expect(apolloFinto.chiamate['RemoveTeamManager']).toBeUndefined()
  })

  it('confirming the removal removes the manager', async () => {
    withTeam({ manager: { id: 'u-1', name: 'Anna Rossi', email: 'u-1@example.com' } })
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Remove manager' }))
    const confirm = await screen.findByText(/Remove the manager of «Network»\?/)
    const dialog = confirm.closest('[role="dialog"]') as HTMLElement
    await user.click(within(dialog).getByRole('button', { name: /delete|confirm|remove/i }))
    expect(apolloFinto.chiamata('RemoveTeamManager')).toEqual({ teamId: 'team-1' })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Manager removed'))
  })

  it('a refused removal is reported', async () => {
    apolloFinto.esiti['RemoveTeamManager'] = { error: new Error('last manager') }
    withTeam({ manager: { id: 'u-1', name: 'Anna Rossi', email: 'u-1@example.com' } })
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Remove manager' }))
    const dialog = (await screen.findByText(/Remove the manager of «Network»\?/)).closest('[role="dialog"]') as HTMLElement
    await user.click(within(dialog).getByRole('button', { name: /delete|confirm|remove/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('last manager'))
  })
})

describe('members', () => {
  it('a team with no members says so', () => {
    withTeam({ members: [] })
    show()
    expect(screen.getByText('No members')).toBeInTheDocument()
  })

  it('the add dialog waits for the users, then filters out members and non-matching users', async () => {
    const { user, rerender } = show()
    await user.click(screen.getByRole('button', { name: '+ Add member' }))
    // Users not arrived yet: a loading line, not "no user to add".
    expect(within(screen.getByRole('dialog')).getByText('Loading...')).toBeInTheDocument()
    apolloFinto.risposte['GetUsers'] = { users: [member('u-1', 'Anna Rossi'), member('u-3', 'Carla Neri'), member('u-4', 'Dario Blu')] }
    rerender(<TeamDetailPage />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Add a member to Network')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Anna Rossi/ })).toBeNull()
    await user.type(within(dialog).getByRole('textbox', { name: 'Search a user...' }), '  carla ')
    expect(within(dialog).queryByRole('button', { name: /Dario Blu/ })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: /Carla Neri/ }))
    expect(apolloFinto.chiamata('SetTeamMember')).toEqual({ teamId: 'team-1', userId: 'u-3', member: true })
  })

  it('when everyone is already a member the dialog says there is nobody to add, and closes', async () => {
    apolloFinto.risposte['GetUsers'] = { users: [member('u-1', 'Anna Rossi')] }
    const { user } = show()
    await user.click(screen.getByRole('button', { name: '+ Add member' }))
    expect(screen.getByText('No user to add')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('removing a member says so; a refusal is reported', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: 'Remove Bruno Verdi from the team' }))
    expect(apolloFinto.chiamata('SetTeamMember')).toEqual({ teamId: 'team-1', userId: 'u-2', member: false })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Member removed'))
    apolloFinto.esiti['SetTeamMember'] = { error: new Error('not a member') }
    await user.click(screen.getByRole('button', { name: 'Remove Anna Rossi from the team' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not a member'))
  })
})

describe('configuration items', () => {
  it('empty owned and supported lists say so', async () => {
    const { user } = show()
    await user.click(screen.getByRole('button', { name: /CI Owned \(0\)/ }))
    await user.click(screen.getByRole('button', { name: /CI Supported \(0\)/ }))
    expect(screen.getByText('No owned CIs')).toBeInTheDocument()
    expect(screen.getByText('No supported CIs')).toBeInTheDocument()
  })

  it('a CI row shows its metamodel type label and opens the CI page', async () => {
    withTeam({
      ownedCIs: [{ id: 'ci-1', name: 'db-prod-01', type: 'database', environment: 'production', status: 'active' }],
      supportedCIs: [{ id: 'ci-2', name: 'crm', type: 'application', environment: 'production', status: 'active' }],
    })
    const { user } = show()
    await user.click(screen.getByRole('button', { name: /CI Owned \(1\)/ }))
    // F-23: the label from the metamodel, not a humanised key.
    expect(screen.getByText('Database')).toBeInTheDocument()
    await user.click(screen.getByText('db-prod-01'))
    await waitFor(() => expect(location()).toBe('/ci/database/ci-1'))
  })

  it('a supported CI opens its page too', async () => {
    withTeam({ supportedCIs: [{ id: 'ci-2', name: 'crm', type: 'application', environment: 'production', status: 'active' }] })
    const { user } = show()
    await user.click(screen.getByRole('button', { name: /CI Supported \(1\)/ }))
    await user.click(screen.getByText('crm'))
    await waitFor(() => expect(location()).toBe('/ci/application/ci-2'))
  })
})
