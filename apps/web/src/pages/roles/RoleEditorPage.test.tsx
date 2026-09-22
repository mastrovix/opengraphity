/**
 * The role editor decides what everyone with a role can do. The sibling
 * RolesPage test covers creating a role and editing a factory one; here the
 * paths an admin also relies on:
 * - "Duplicate" (`?from=`) starts from the source role's permissions and a
 *   "Copy of" name, and still CREATES a new role (never updates the source);
 * - a custom role nobody holds can be deleted after confirming; one held by
 *   people, or a factory role, cannot, and the page says why;
 * - clearing an area removes exactly that area's permissions;
 * - a missing role or a load error is said, not rendered as an empty editor;
 * - a refused save leaves the admin on the page with the error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { FACTORY_ROLE_PERMISSIONS } from '@opengraphity/types'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { meFixture } from '@/test/mocks/gql'
import { RoleEditorPage } from './RoleEditorPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const custom = (key: string, name: string, permissions: string[], userCount = 0) =>
  ({ key, name, permissions, isFactory: false, userCount })

const ROLES = [
  { key: 'admin', name: null, permissions: [...FACTORY_ROLE_PERMISSIONS.admin], isFactory: true, userCount: 1 },
  custom('kb_editor', 'KB editor', ['workspace.use', 'kb.read', 'kb.write']),
  custom('cab', 'CAB', ['workspace.use'], 3),
]

function open(route: string, path = '/roles/:key') {
  return renderWithProviders(<RoleEditorPage />, { route, path })
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetMe'] = { me: meFixture('admin') }
  apolloFinto.risposte['GetRoles'] = { roles: ROLES }
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

describe('RoleEditorPage — duplicate', () => {
  it('starts from the source role and creates a new one', async () => {
    const { user } = open('/roles/new?from=kb_editor', '/roles/new')
    expect(screen.getByRole('heading', { name: 'New role' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Copy of KB editor')
    expect(screen.getByRole('checkbox', { name: /Knowledge base: write/ })).toBeChecked()
    // A new role has no key yet and cannot be deleted.
    expect(screen.queryByText('Key')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('CreateRole')).toBeDefined())
    expect(apolloFinto.chiamata('CreateRole')).toEqual({ input: { name: 'Copy of KB editor', permissions: ['workspace.use', 'kb.read', 'kb.write'] } })
    expect(apolloFinto.chiamate['UpdateRole']).toBeUndefined()
    expect(toast.success).toHaveBeenCalledWith('Role created')
    await attendiURL('/roles')
  })

  it('an unknown source starts from an empty role', () => {
    open('/roles/new?from=ghost', '/roles/new')
    expect(screen.getByLabelText('Name')).toHaveValue('')
    // No name: nothing to save yet.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

describe('RoleEditorPage — custom role', () => {
  it('shows key and holders; clearing an area removes exactly its permissions', async () => {
    const { user } = open('/roles/kb_editor')
    expect(screen.getByRole('heading', { name: 'KB editor' })).toBeInTheDocument()
    expect(screen.getByText('kb_editor')).toBeInTheDocument()
    expect(screen.getByText('0 people have this role')).toBeInTheDocument()
    const kbCard = screen.getByText('Knowledge base', { selector: 'span' }).closest('div')!.parentElement!
    // Two of the area are selected, not all: the button offers to select the rest.
    await user.click(within(kbCard).getByRole('button', { name: 'Select the whole area' }))
    await user.click(within(kbCard).getByRole('button', { name: 'Clear the area' }))
    expect(screen.getByRole('checkbox', { name: /Knowledge base: read/ })).not.toBeChecked()
    // Unticking a single permission works too.
    await user.click(screen.getByRole('checkbox', { name: /Workspace/ }))
    expect(screen.getByText(/No permission selected/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), ' KB readers ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateRole')).toBeDefined())
    expect(apolloFinto.chiamata('UpdateRole')).toEqual({ key: 'kb_editor', input: { name: 'KB readers', permissions: [] } })
    expect(toast.success).toHaveBeenCalledWith('Role saved')
  })

  it('a custom role without a name cannot be saved', async () => {
    const { user } = open('/roles/kb_editor')
    await user.clear(screen.getByLabelText('Name'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('deletes a role nobody holds, after confirming', async () => {
    const { user } = open('/roles/kb_editor')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete the role «KB editor»?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(apolloFinto.chiamata('DeleteRole')).toEqual({ key: 'kb_editor' }))
    expect(toast.success).toHaveBeenCalledWith('Role deleted')
    await attendiURL('/roles')
  })

  it('does nothing when the deletion is not confirmed', async () => {
    const { user } = open('/roles/kb_editor')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamate['DeleteRole']).toBeUndefined()
  })

  it('a refused deletion shows the error and stays on the role', async () => {
    apolloFinto.esiti['DeleteRole'] = { error: new Error('in use') }
    const { user } = open('/roles/kb_editor')
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('in use'))
    expect(screen.getByRole('heading', { name: 'KB editor' })).toBeInTheDocument()
  })

  it('a role held by people cannot be deleted, and the button says why', () => {
    open('/roles/cab')
    const del = screen.getByRole('button', { name: 'Delete' })
    expect(del).toBeDisabled()
    expect(del).toHaveAttribute('title', 'Give the people with this role another role first')
  })

  it('a refused save shows the error and stays on the page', async () => {
    apolloFinto.esiti['UpdateRole'] = { error: new Error('duplicate name') }
    const { user } = open('/roles/cab')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('duplicate name'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'CAB' })).toBeInTheDocument()
  })

  it('cancel goes back to the list without saving', async () => {
    const { user } = open('/roles/cab')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await attendiURL('/roles')
    expect(apolloFinto.chiamate['UpdateRole']).toBeUndefined()
  })
})

describe('RoleEditorPage — missing data', () => {
  it('an unknown role key says not found instead of an empty editor', () => {
    open('/roles/ghost')
    expect(screen.getByRole('alert')).toHaveTextContent('Role ghost not found.')
    expect(screen.getByRole('heading', { name: 'Edit role' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('a load error is shown', () => {
    apolloFinto.erroriQuery['GetRoles'] = new Error('roles down')
    open('/roles/cab')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the roles: roles down')
  })
})
