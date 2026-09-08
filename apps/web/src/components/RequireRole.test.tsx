import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { RequireRole } from './RequireRole'
import { renderWithProviders } from '@/test/utils'
import { meMock, meErrorMock } from '@/test/mocks/gql'

const CHILD = <div data-testid="protected">Pagina protetta</div>

describe('RequireRole', () => {
  it('mostra il loader mentre `me` carica (mai i children)', () => {
    renderWithProviders(<RequireRole roles={['admin']}>{CHILD}</RequireRole>, { mocks: [meMock('admin')] })
    expect(screen.getByRole('status')).toHaveTextContent('Loading...')
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
  })

  it('ruolo ammesso → renderizza i children', async () => {
    renderWithProviders(<RequireRole roles={['admin', 'operator']}>{CHILD}</RequireRole>, { mocks: [meMock('operator')] })
    expect(await screen.findByTestId('protected')).toBeInTheDocument()
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument()
  })

  it('ruolo non ammesso → "Accesso negato" con link alla dashboard, senza children', async () => {
    renderWithProviders(<RequireRole roles={['admin']}>{CHILD}</RequireRole>, { mocks: [meMock('viewer')] })
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/dashboard')
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
  })

  it('me null (utente sconosciuto al DB) → accesso negato', async () => {
    renderWithProviders(<RequireRole roles={['admin']}>{CHILD}</RequireRole>, { mocks: [meMock(null)] })
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
  })

  it('errore della query → QueryError con il messaggio e retry, nessun fallback "consentito"', async () => {
    renderWithProviders(<RequireRole roles={['admin']}>{CHILD}</RequireRole>, { mocks: [meErrorMock('me failed')] })
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument()
    expect(screen.getByText('me failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('protected')).not.toBeInTheDocument())
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument()
  })
})
