import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { gql } from '@apollo/client'
import { AuditLogPage } from './AuditLogPage'
import { renderWithProviders, type GqlMock } from '@/test/utils'

// Stesso documento (privato) di AuditLogPage.tsx.
const GET_AUDIT_LOG = gql`
  query GetAuditLog(
    $page: Int, $pageSize: Int,
    $filters: String,
    $sortField: String, $sortDirection: String
  ) {
    auditLog(
      page: $page, pageSize: $pageSize,
      filters: $filters,
      sortField: $sortField, sortDirection: $sortDirection
    ) {
      items {
        id userId userEmail action entityType entityId details ipAddress createdAt
      }
      total
    }
  }
`

interface Entry { id: string; userEmail: string; action: string; entityType: string; details?: string | null }

function entries(list: Entry[]) {
  return list.map((e) => ({
    __typename: 'AuditEntry', userId: 'u1', entityId: '0123456789abcdef', details: null, ipAddress: null,
    createdAt: '2026-09-08T10:00:00Z', ...e,
  }))
}

type Vars = { page: number; pageSize: number; filters?: string; sortField?: string; sortDirection: string }

/** Registra le variabili viste e risponde con `items`. */
function auditMock(match: (v: Vars) => boolean, items: Entry[], seen?: Vars[]): GqlMock {
  return {
    request: { query: GET_AUDIT_LOG, variables: (v) => { const ok = match(v as Vars); if (ok) seen?.push(v as Vars); return ok } },
    result: { data: { auditLog: { __typename: 'AuditLogPage', items: entries(items), total: items.length } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

const ALL: Entry[] = [
  { id: 'a1', userEmail: 'mario@acme.com', action: 'login',           entityType: 'User' },
  { id: 'a2', userEmail: 'anna@acme.com',  action: 'incident.create', entityType: 'Incident', details: '{"title":"Server down"}' },
]
const ONLY_LOGIN: Entry[] = [ALL[0]!]

const actions = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row').map((r) => within(r).getAllByRole('cell')[2]!.textContent)

describe('AuditLogPage', () => {
  it('prima query: pagina 1, pageSize 50, desc, senza filtri', async () => {
    const seen: Vars[] = []
    renderWithProviders(<AuditLogPage />, { mocks: [auditMock(() => true, ALL, seen)] })
    expect(await screen.findByText('mario@acme.com')).toBeInTheDocument()
    expect(seen[0]).toEqual({ page: 1, pageSize: 50, sortDirection: 'desc' })
    expect(screen.getByText('2 entries')).toBeInTheDocument()
  })

  it('"Applica" passa il gruppo di filtri alla query (server-side) e torna a pagina 1', async () => {
    const seen: Vars[] = []
    const unfiltered = auditMock((v) => v.filters === undefined, ALL, seen)
    const filtered   = auditMock((v) => typeof v.filters === 'string', ONLY_LOGIN, seen)
    const { user } = renderWithProviders(<AuditLogPage />, { mocks: [unfiltered, filtered] })
    await screen.findByText('anna@acme.com')

    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: '+ Add filter' }))
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'action')
    expect(screen.getAllByRole('combobox')[1]).toHaveValue('contains')
    await user.type(screen.getByPlaceholderText('Valore…'), 'login')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(actions()).toEqual(['login']))
    const last = seen.at(-1)!
    expect(last.page).toBe(1)
    const group = JSON.parse(last.filters!) as { rules: { field: string; operator: string; value: string; logic: string }[] }
    expect(group.rules).toHaveLength(1)
    expect(group.rules[0]).toMatchObject({ field: 'action', operator: 'contains', value: 'login', logic: 'AND' })
    expect(screen.getByText('1 entries')).toBeInTheDocument()
  })

  it('Reset rimuove i filtri dalla query', async () => {
    const seen: Vars[] = []
    const { user } = renderWithProviders(<AuditLogPage />, { mocks: [auditMock(() => true, ALL, seen)] })
    await screen.findByText('anna@acme.com')
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: '+ Add filter' }))
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'userEmail')
    await user.type(screen.getByPlaceholderText('Valore…'), 'anna')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(seen.at(-1)?.filters).toBeDefined())
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(seen.at(-1)?.filters).toBeUndefined())
  })

  it('ordinare per colonna rilancia la query con sortField/sortDirection', async () => {
    const seen: Vars[] = []
    const { user } = renderWithProviders(<AuditLogPage />, { mocks: [auditMock(() => true, ALL, seen)] })
    await screen.findByText('anna@acme.com')
    await user.click(within(screen.getByRole('columnheader', { name: 'Action' })).getByRole('button'))
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ sortField: 'action', sortDirection: 'asc', page: 1 }))
    await user.click(within(screen.getByRole('columnheader', { name: 'Action' })).getByRole('button'))
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ sortField: 'action', sortDirection: 'desc' }))
  })

  it('click su una riga mostra i dettagli JSON formattati', async () => {
    const { user } = renderWithProviders(<AuditLogPage />, { mocks: [auditMock(() => true, ALL)] })
    await user.click(await screen.findByText('anna@acme.com'))
    expect(screen.getByText('Details — incident.create')).toBeInTheDocument()
    expect(screen.getByText(/"title": "Server down"/)).toBeInTheDocument()
  })

  it('errore → QueryError con il messaggio', async () => {
    const err: GqlMock = { request: { query: GET_AUDIT_LOG, variables: () => true }, error: new Error('audit unavailable') }
    renderWithProviders(<AuditLogPage />, { mocks: [err] })
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('audit unavailable')).toBeInTheDocument()
  })
})
