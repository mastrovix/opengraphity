import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { UsersPage } from './UsersPage'
import { exportToCsv } from '@/lib/csvExport'
import { GET_USERS } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { teamsMock, type UserRowFixture } from '@/test/mocks/gql'

vi.mock('@/lib/csvExport', () => ({ exportToCsv: vi.fn() }))

const USERS: UserRowFixture[] = [
  { id: 'u1', name: 'Mario Rossi',   email: 'mario@acme.com', role: 'admin',    createdAt: '2026-09-01T10:00:00Z' },
  { id: 'u2', name: 'Anna Bianchi',  email: 'anna@acme.com',  role: 'operator', createdAt: '2026-08-01T10:00:00Z' },
  { id: 'u3', name: 'Luca Verdi',    email: 'luca@acme.com',  role: 'viewer',   createdAt: null },
]

/** GET_USERS per qualunque sort (la pagina passa sortField/sortDirection dallo stato). */
function usersAnySort(users = USERS): GqlMock {
  return {
    request: { query: GET_USERS, variables: () => true },
    result: { data: { users: users.map((u) => ({ __typename: 'User', teams: [], ...u })) } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')
const names = () => bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent)

async function applyRoleFilter(user: ReturnType<typeof renderWithProviders>['user'], role: string) {
  await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
  await user.click(screen.getByRole('button', { name: '+ Add filter' }))
  const [fieldSelect] = screen.getAllByRole('combobox')
  await user.selectOptions(fieldSelect!, 'role')
  const selects = screen.getAllByRole('combobox')
  expect(selects).toHaveLength(3)                 // campo, operatore, valore
  expect(selects[1]).toHaveValue('equals')
  await user.selectOptions(selects[2]!, role)
  await user.click(screen.getByRole('button', { name: 'Apply' }))
}

beforeEach(() => { vi.mocked(exportToCsv).mockClear() })

describe('UsersPage', () => {
  it('elenca gli utenti con ruolo e conteggio', async () => {
    renderWithProviders(<UsersPage />, { mocks: [usersAnySort(), teamsMock()], route: '/users' })
    expect(await screen.findByText('Mario Rossi')).toBeInTheDocument()
    expect(names()).toEqual(['Mario Rossi', 'Anna Bianchi', 'Luca Verdi'])
    expect(screen.getByText('3 users')).toBeInTheDocument()
    expect(within(bodyRows()[0]!).getByText('Admin')).toBeInTheDocument()
  })

  it('il filtro avanzato è applicato client-side: riduce le righe e il conteggio', async () => {
    const { user } = renderWithProviders(<UsersPage />, { mocks: [usersAnySort(), teamsMock()], route: '/users' })
    await screen.findByText('Mario Rossi')
    await applyRoleFilter(user, 'operator')
    await waitFor(() => expect(names()).toEqual(['Anna Bianchi']))
    expect(screen.getByText('1 user')).toBeInTheDocument()
    // il filtro finisce nella URL (persistInQuery) e la pagina torna alla prima
    expect(screen.getByTestId('location').textContent).toMatch(/^\/users\?filters=/)
  })

  it('Reset del filtro ripristina tutte le righe', async () => {
    const { user } = renderWithProviders(<UsersPage />, { mocks: [usersAnySort(), teamsMock()], route: '/users' })
    await screen.findByText('Mario Rossi')
    await applyRoleFilter(user, 'viewer')
    await waitFor(() => expect(names()).toEqual(['Luca Verdi']))
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(names()).toHaveLength(3))
    expect(screen.getByTestId('location')).toHaveTextContent('/users')
  })

  it('l\'export CSV riceve le righe FILTRATE, non tutte', async () => {
    const { user } = renderWithProviders(<UsersPage />, { mocks: [usersAnySort(), teamsMock()], route: '/users' })
    await screen.findByText('Mario Rossi')
    await applyRoleFilter(user, 'admin')
    await waitFor(() => expect(names()).toEqual(['Mario Rossi']))

    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(exportToCsv).toHaveBeenCalledTimes(1))
    const [filename, columns, rows] = vi.mocked(exportToCsv).mock.calls[0]! as [string, { key: string }[], { id: string }[]]
    expect(filename).toBe('users')
    expect(columns.map((c) => c.key)).toEqual(['name', 'email', 'role', 'createdAt'])
    expect(rows.map((r) => r.id)).toEqual(['u1'])
  })

  it('senza filtro l\'export contiene tutte le righe', async () => {
    const { user } = renderWithProviders(<UsersPage />, { mocks: [usersAnySort(), teamsMock()], route: '/users' })
    await screen.findByText('Mario Rossi')
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(exportToCsv).toHaveBeenCalledTimes(1))
    expect((vi.mocked(exportToCsv).mock.calls[0]![2] as { id: string }[]).map((r) => r.id)).toEqual(['u1', 'u2', 'u3'])
  })

  it('ordinare per colonna aggiorna la URL (?sort=) e rilancia la query', async () => {
    const seen: unknown[] = []
    const spyMock: GqlMock = {
      request: { query: GET_USERS, variables: (v) => { seen.push(v); return true } },
      result: { data: { users: USERS.map((u) => ({ __typename: 'User', teams: [], ...u })) } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    const { user } = renderWithProviders(<UsersPage />, { mocks: [spyMock, teamsMock()], route: '/users' })
    await screen.findByText('Mario Rossi')
    await user.click(within(screen.getByRole('columnheader', { name: 'Email' })).getByRole('button'))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/users?sort=email%3Aasc'))
    await waitFor(() => expect(seen).toContainEqual({ sortField: 'email', sortDirection: 'asc' }))
  })

  it('click su una riga naviga al dettaglio utente', async () => {
    const { user } = renderWithProviders(<UsersPage />, { mocks: [usersAnySort(), teamsMock()], route: '/users' })
    await user.click(await screen.findByText('Anna Bianchi'))
    expect(screen.getByTestId('location')).toHaveTextContent('/users/u2')
  })

  it('errore della query → QueryError con retry (nessuna tabella vuota spacciata per "nessun utente")', async () => {
    const err: GqlMock = { request: { query: GET_USERS, variables: () => true }, error: new Error('users unavailable') }
    renderWithProviders(<UsersPage />, { mocks: [err, teamsMock()], route: '/users' })
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('users unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No users')).not.toBeInTheDocument()
  })

  it('"New User" apre il modale con i campi obbligatori e Create disabilitato finché incompleto', async () => {
    const { user } = renderWithProviders(<UsersPage />, { mocks: [usersAnySort(), teamsMock()], route: '/users' })
    await screen.findByText('Mario Rossi')
    await user.click(screen.getByRole('button', { name: '+ New User' }))
    const dialog = await screen.findByRole('dialog', { name: 'New user' })
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled()
    await user.type(within(dialog).getByPlaceholderText('mario@acme.com'), 'x@y.z')
    await user.type(within(dialog).getByPlaceholderText('Mario'), 'X')
    await user.type(within(dialog).getByPlaceholderText('Rossi'), 'Y')
    await user.type(within(dialog).getByPlaceholderText('At least 8 characters'), 'password1')
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
