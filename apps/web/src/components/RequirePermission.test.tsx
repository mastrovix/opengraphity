import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { RequirePermission } from './RequirePermission'
import { renderWithProviders } from '@/test/utils'
import { meMock, meErrorMock } from '@/test/mocks/gql'

const CHILD = <div data-testid="protected">Pagina protetta</div>

describe('RequirePermission', () => {
  it('mostra il loader mentre `me` carica (mai i children)', () => {
    renderWithProviders(<RequirePermission anyOf={['admin.audit']}>{CHILD}</RequirePermission>, { mocks: [meMock('admin')] })
    expect(screen.getByRole('status')).toHaveTextContent('Loading...')
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
  })

  it('il ruolo ha almeno uno dei permessi → renderizza i children', async () => {
    renderWithProviders(<RequirePermission anyOf={['kb.write', 'admin.audit']}>{CHILD}</RequirePermission>, { mocks: [meMock('operator')] })
    expect(await screen.findByTestId('protected')).toBeInTheDocument()
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument()
  })

  it('il ruolo non ha nessuno dei permessi → "Accesso negato" con link alla dashboard, senza children', async () => {
    renderWithProviders(<RequirePermission anyOf={['admin.audit']}>{CHILD}</RequirePermission>, { mocks: [meMock('viewer')] })
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/dashboard')
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
  })

  it('me null (utente sconosciuto al DB) → accesso negato', async () => {
    renderWithProviders(<RequirePermission anyOf={['admin.audit']}>{CHILD}</RequirePermission>, { mocks: [meMock(null)] })
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
  })

  it('errore della query → QueryError con il messaggio e retry, nessun fallback "consentito"', async () => {
    renderWithProviders(<RequirePermission anyOf={['admin.audit']}>{CHILD}</RequirePermission>, { mocks: [meErrorMock('me failed')] })
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('me failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('protected')).not.toBeInTheDocument())
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument()
  })
})
