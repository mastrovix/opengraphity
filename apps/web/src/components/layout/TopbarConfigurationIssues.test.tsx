/**
 * LA PASTIGLIA della diagnostica (20 set 2026).
 *
 * L'elenco dei rilievi ha lasciato le pagine dell'app per la sua pagina in
 * Configurazione: quello che resta ovunque è questo numero. Il rischio del
 * cambio è che, spostando l'elenco, l'avviso sparisca del tutto — chi
 * amministra non saprebbe più che c'è qualcosa di rotto finché non apre una
 * pagina che nessuno gli ha detto di aprire. Questi test tengono il numero
 * dov'è: presente quando c'è qualcosa, assente quando non c'è, e non per chi
 * non può rimediare.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { TopbarConfigurationIssues, PAGINA_DIAGNOSTICA } from './TopbarConfigurationIssues'
import { renderWithProviders } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { GET_CONFIGURATION_ISSUES } from '@/graphql/queries'

interface Issue { kind: string; severity: string; params: { name: string; value: string }[]; gaps: never[]; where: string | null }

const rilievo = (severity: string): Issue => ({
  kind: 'matrix_stale_keys', severity, gaps: [], where: '/settings/domain-matrices',
  params: [{ name: 'matrix', value: 'priority' }, { name: 'count', value: '1' }],
})

const issuesMock = (configurationIssues: Issue[]) => ({
  request: { query: GET_CONFIGURATION_ISSUES },
  result: { data: { configurationIssues } },
})

describe('TopbarConfigurationIssues', () => {
  it('con dei rilievi mostra il conto e porta alla Diagnostica', async () => {
    renderWithProviders(<TopbarConfigurationIssues />, {
      mocks: [meMock('admin'), issuesMock([rilievo('warning'), rilievo('warning')])],
    })
    const pastiglia = await screen.findByRole('link')
    expect(pastiglia).toHaveTextContent('2')
    expect(pastiglia).toHaveAttribute('href', PAGINA_DIAGNOSTICA)
  })

  it('niente da sistemare → niente pastiglia (un indicatore sempre acceso non si vede più)', async () => {
    renderWithProviders(<TopbarConfigurationIssues />, {
      mocks: [meMock('admin'), issuesMock([])],
    })
    await waitFor(() => { expect(screen.queryByRole('link')).not.toBeInTheDocument() })
  })

  it('chi non è admin non la vede: non è lui che può rimediare', async () => {
    renderWithProviders(<TopbarConfigurationIssues />, {
      mocks: [meMock('operator'), issuesMock([rilievo('error')])],
    })
    await waitFor(() => { expect(screen.queryByRole('link')).not.toBeInTheDocument() })
  })
})
