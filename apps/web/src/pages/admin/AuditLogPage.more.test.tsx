/**
 * Audit log: the filter choices that come from the register, paging, retry.
 *
 * Why these behaviours matter to an auditor: the action and entity-type
 * filters must offer what the register really contains (with counts), under
 * the names the tenant uses for its ITIL types, otherwise entries exist that
 * nobody can isolate; a register of thousands of entries must be pageable in
 * both directions; and when loading fails, "Retry" must really ask again
 * instead of leaving a dead error box.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { AuditLogPage } from './AuditLogPage'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const entry = (id: string) => ({
  id, userId: 'u1', userEmail: `${id}@acme.com`, action: 'login', entityType: 'User', entityId: '0123456789abcdef',
  details: null, ipAddress: '10.0.0.1', createdAt: '2026-09-08T10:00:00Z',
})

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetITILTypes'] = { itilTypes: [{ name: 'incident', label: 'Ticket' }] }
  apolloFinto.risposte['GetAuditLog'] = { auditLog: { items: [entry('a1')], total: 1 } }
})

async function openFilterOn(user: ReturnType<typeof renderWithProviders>['user'], field: string) {
  await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
  await user.click(screen.getByRole('button', { name: 'Add filter' }))
  await user.selectOptions(screen.getAllByRole('combobox')[0]!, field)
  return screen.getByRole('combobox', { name: 'Value of condition 1' })
}

describe('AuditLogPage — filters from the register', () => {
  it('offers the actions found in the register, readable and with their counts', async () => {
    apolloFinto.risposte['GetAuditActions'] = {
      auditActions: [{ action: 'incident.step_entered', count: 3 }, { action: 'mutation.createThing', count: 2 }],
      auditEntityTypes: [],
    }
    const { user } = renderWithProviders(<AuditLogPage />)
    const values = await openFilterOn(user, 'action')
    const labels = within(values).getAllByRole('option').slice(1).map((o) => o.textContent)
    // The step action reads with the tenant's own name for the type; mutation.* keeps the technical name.
    expect(labels).toEqual(['Ticket: entered a step (3)', 'mutation.createThing (2)'])
  })

  it('offers the entity types found in the register, ITIL ones under the tenant label', async () => {
    apolloFinto.risposte['GetAuditActions'] = {
      auditActions: [],
      auditEntityTypes: [{ entityType: 'Incident', count: 4 }, { entityType: 'EnumTypeDefinition', count: 1 }],
    }
    const { user } = renderWithProviders(<AuditLogPage />)
    const values = await openFilterOn(user, 'entityType')
    const labels = within(values).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)
    expect(labels).toEqual(['', 'Incident', 'EnumTypeDefinition'])
    expect(within(values).getByRole('option', { name: 'Ticket (4)' })).toBeInTheDocument()
    // A non-ITIL type has no tenant label: its technical name is the information.
    expect(within(values).getByRole('option', { name: 'EnumTypeDefinition (1)' })).toBeInTheDocument()
  })
})

describe('AuditLogPage — paging and retry', () => {
  it('Next and Prev move through the register pages', async () => {
    apolloFinto.risposte['GetAuditLog'] = { auditLog: { items: [entry('a1')], total: 120 } }
    const { user } = renderWithProviders(<AuditLogPage />)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    // The API is 1-based: the second page is page 2.
    await waitFor(() => expect(apolloFinto.chiamata('GetAuditLog')).toMatchObject({ page: 2 }))
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Prev' }))
    await waitFor(() => expect(apolloFinto.chiamata('GetAuditLog')).toMatchObject({ page: 1 }))
  })

  it('shows the IP address, and a dash when there is none', () => {
    apolloFinto.risposte['GetAuditLog'] = { auditLog: { items: [entry('a1'), { ...entry('a2'), ipAddress: null }], total: 2 } }
    renderWithProviders(<AuditLogPage />)
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument()
    expect(within(screen.getByText('a2@acme.com').closest('tr')!).getByText('—')).toBeInTheDocument()
  })

  it('an entry without details opens nothing, and one with plain-text details shows them as they are', async () => {
    apolloFinto.risposte['GetAuditLog'] = { auditLog: { items: [entry('a1'), { ...entry('a2'), details: 'not json' }], total: 2 } }
    const { user } = renderWithProviders(<AuditLogPage />)
    await user.click(screen.getByText('a1@acme.com'))
    expect(screen.queryByText(/^Details —/)).not.toBeInTheDocument()
    await user.click(screen.getByText('a2@acme.com'))
    expect(screen.getByText('"not json"')).toBeInTheDocument()
    // A second click on the same row closes the detail.
    await user.click(screen.getByText('a2@acme.com'))
    expect(screen.queryByText('"not json"')).not.toBeInTheDocument()
  })

  it('"Retry" after a failed load asks the server again', async () => {
    apolloFinto.erroriQuery['GetAuditLog'] = new Error('audit unavailable')
    const { user } = renderWithProviders(<AuditLogPage />)
    expect(screen.getByText('audit unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })
})
