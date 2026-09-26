/**
 * Roles page: the actions around the list.
 *
 * Deleting a role is irreversible, so it must go through a confirmation that
 * names the role, send the right key, tell the admin it worked and reload the
 * list; a "No" must send nothing at all; a refused delete must surface the
 * error instead of silently leaving the row there. "New role" must take the
 * admin to the editor, and a failed load must be said, not shown as an empty
 * organisation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { RolesPage } from './RolesPage'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { meFixture } from '@/test/mocks/gql'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ROLES = [
  { key: 'admin', name: null, permissions: ['admin.users'], isFactory: true, userCount: 1 },
  { key: 'kb_editor', name: 'KB editor', permissions: ['kb.read'], isFactory: false, userCount: 0 },
]

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  apolloFinto.risposte['GetMe'] = { me: meFixture('admin') }
  apolloFinto.risposte['GetRoles'] = { roles: ROLES }
})

const row = (name: string) => screen.getByText(name, { selector: 'td' }).closest('tr')!

describe('RolesPage actions', () => {
  it('deleting a custom role asks first, sends its key, confirms and reloads the list', async () => {
    const { user } = renderWithProviders(<RolesPage />, { route: '/roles' })
    await user.click(within(row('KB editor')).getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    // The confirmation names the role: the admin must know WHICH role goes.
    expect(within(dialog).getByText('Delete the role «KB editor»?')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(apolloFinto.chiamata('DeleteRole')).toEqual({ key: 'kb_editor' }))
    expect(toast.success).toHaveBeenCalledWith('Role deleted')
    // The list is reloaded, otherwise the deleted row stays on screen.
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('cancelling the confirmation deletes nothing', async () => {
    const { user } = renderWithProviders(<RolesPage />, { route: '/roles' })
    await user.click(within(row('KB editor')).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(apolloFinto.chiamate['DeleteRole']).toBeUndefined()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a refused delete is reported and the list is not reloaded as if it had worked', async () => {
    apolloFinto.esiti['DeleteRole'] = { error: new Error('The role is still assigned') }
    const { user } = renderWithProviders(<RolesPage />, { route: '/roles' })
    await user.click(within(row('KB editor')).getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The role is still assigned'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('a factory role explains why it cannot be deleted', () => {
    renderWithProviders(<RolesPage />, { route: '/roles' })
    // The disabled button carries the reason as its tooltip.
    expect(within(row('Admin')).getByRole('button', { name: 'Delete' })).toHaveAttribute('title', 'Factory roles cannot be deleted')
  })

  it('"New role" opens the editor', async () => {
    const { user } = renderWithProviders(<RolesPage />, { route: '/roles' })
    await user.click(screen.getByRole('button', { name: 'New role' }))
    await attendiURL('/roles/new')
  })

  it('a failed load is shown as an error, not as an empty list', () => {
    apolloFinto.erroriQuery['GetRoles'] = new Error('forbidden')
    renderWithProviders(<RolesPage />, { route: '/roles' })
    expect(screen.getByRole('alert')).toHaveTextContent('forbidden')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
