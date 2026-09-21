/**
 * Ondata 7 di «Nulla cablato»: la pagina Ruoli e l'editor dei permessi.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { PERMISSIONS } from '@opengraphity/types'
import { RolesPage } from './RolesPage'
import { RoleEditorPage } from './RoleEditorPage'
import { CREATE_ROLE, UPDATE_ROLE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock, rolesMock } from '@/test/mocks/gql'

const me = () => meMock('admin', { maxUsageCount: Number.POSITIVE_INFINITY })

describe('RolesPage', () => {
  it('elenca i ruoli con tipo, permessi e persone; si elimina solo un ruolo personalizzato senza persone', async () => {
    renderWithProviders(<RolesPage />, {
      mocks: [me(), rolesMock([{ key: 'service_desk', name: 'Service Desk', permissions: ['workspace.use', 'incident.read'], userCount: 0 }, { key: 'cab', name: 'CAB', userCount: 2 }])],
      route: '/roles',
    })
    const row = (name: string) => screen.getByRole('link', { name }).closest('tr')!
    expect(await screen.findByRole('link', { name: 'Service Desk' })).toBeInTheDocument()

    expect(within(row('Admin')).getByText('Factory')).toBeInTheDocument()
    expect(within(row('Admin')).getByText(`${PERMISSIONS.length} of ${PERMISSIONS.length}`)).toBeInTheDocument()
    expect(within(row('Admin')).getByRole('button', { name: 'Delete' })).toBeDisabled()

    expect(within(row('Service Desk')).getByText('Custom')).toBeInTheDocument()
    expect(within(row('Service Desk')).getByText(`2 of ${PERMISSIONS.length}`)).toBeInTheDocument()
    expect(within(row('Service Desk')).getByRole('button', { name: 'Delete' })).toBeEnabled()
    // con persone: prima si assegna loro un altro ruolo
    expect(within(row('CAB')).getByRole('button', { name: 'Delete' })).toBeDisabled()
    expect(within(row('Service Desk')).getByRole('link', { name: 'Duplicate' })).toHaveAttribute('href', '/roles/new?from=service_desk')
  })
})

describe('RoleEditorPage', () => {
  it('nuovo ruolo: area intera con un clic, avviso «solo portale», invio dei permessi nell\'ordine del catalogo', async () => {
    const seen: unknown[] = []
    const create: GqlMock = {
      request: { query: CREATE_ROLE, variables: (v: unknown) => { seen.push(v); return true } },
      result: { data: { createRole: { __typename: 'Role', key: 'kb_editor', name: 'KB editor', permissions: ['kb.read', 'kb.write', 'kb.rate'], isFactory: false, userCount: 0 } } },
    }
    const { user } = renderWithProviders(<RoleEditorPage />, { mocks: [me(), rolesMock(), create, rolesMock()], route: '/roles/new', path: '/roles/new' })

    const name = await screen.findByLabelText('Name')
    await user.type(name, 'KB editor')
    // senza «Area di lavoro» il ruolo entra solo nel portale, e la pagina lo dice
    expect(screen.getByText(/No permission selected/)).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /Knowledge base: write/ }))
    await user.click(screen.getByRole('checkbox', { name: /Knowledge base: read/ }))
    expect(screen.getByText(/can only use the self-service portal/)).toBeInTheDocument()
    // «Seleziona tutta l'area» completa la Knowledge base
    const kbCard = screen.getByText('Knowledge base', { selector: 'span' }).closest('div')!.parentElement!
    await user.click(within(kbCard).getByRole('button', { name: 'Select the whole area' }))
    expect(screen.getByRole('checkbox', { name: /Rate an article/ })).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ input: { name: 'KB editor', permissions: ['kb.read', 'kb.write', 'kb.rate'] } })
  })

  it('ruolo di fabbrica: il nome può restare vuoto, e togliere «Persone, team e ruoli» avvisa prima di salvare', async () => {
    const seen: unknown[] = []
    const update: GqlMock = {
      request: { query: UPDATE_ROLE, variables: (v: unknown) => { seen.push(v); return true } },
      result: { data: { updateRole: { __typename: 'Role', key: 'admin', name: null, permissions: [], isFactory: true, userCount: 1 } } },
    }
    const { user } = renderWithProviders(<RoleEditorPage />, { mocks: [me(), rolesMock(), update, rolesMock()], route: '/roles/admin', path: '/roles/:key' })
    const people = await screen.findByRole('checkbox', { name: /People, teams and roles/ })
    expect(screen.getByText('admin')).toBeInTheDocument()
    expect(screen.getByText(/Leave empty to keep the product name «Admin»/)).toBeInTheDocument()
    await user.click(people)
    expect(screen.getByText(/At least one active person must keep/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toHaveLength(1))
    const sent = seen[0] as { key: string; input: { name: string | null; permissions: string[] } }
    expect(sent.key).toBe('admin')
    expect(sent.input.name).toBeNull()
    expect(sent.input.permissions).not.toContain('admin.users')
    expect(sent.input.permissions).toHaveLength(PERMISSIONS.length - 1)
  })
})

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
