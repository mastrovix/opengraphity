/**
 * /cis/:id → /ci/:type/:id: redirect, "non trovato" con ritorno alla CMDB,
 * errore di rete nel layout con Riprova (non lo schermo intero di RouteError).
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { CIByIdRedirect } from './CIByIdRedirect'
import { GET_CI_BY_ID_REF } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'

function renderRedirect(mocks: GqlMock[]) {
  return renderWithProviders(<CIByIdRedirect />, { route: '/cis/srv-1', path: '/cis/:id', mocks })
}
const location = () => screen.getByTestId('location').textContent

describe('CIByIdRedirect', () => {
  it('CI trovato → redirect alla rotta tipizzata', async () => {
    renderRedirect([{ request: { query: GET_CI_BY_ID_REF, variables: { id: 'srv-1' } }, result: { data: { ciById: { __typename: 'ConfigurationItem', id: 'srv-1', type: 'server' } } } }])
    await waitFor(() => expect(location()).toBe('/ci/server/srv-1'))
  })

  it('CI inesistente → stato vuoto con "Torna alla CMDB"', async () => {
    const { user } = renderRedirect([{ request: { query: GET_CI_BY_ID_REF, variables: { id: 'srv-1' } }, result: { data: { ciById: null } } }])
    expect(await screen.findByText('CI not found')).toBeInTheDocument()
    expect(screen.getByText('No CI with id srv-1: it may have been deleted.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to the CMDB' }))
    expect(location()).toBe('/cmdb')
  })

  it('errore di rete → QueryError con Riprova, poi redirect quando la query riesce', async () => {
    const { user } = renderRedirect([
      { request: { query: GET_CI_BY_ID_REF, variables: { id: 'srv-1' } }, error: new Error('network down') },
      { request: { query: GET_CI_BY_ID_REF, variables: { id: 'srv-1' } }, result: { data: { ciById: { __typename: 'ConfigurationItem', id: 'srv-1', type: 'server' } } } },
    ])
    expect(await screen.findByText('network down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(location()).toBe('/ci/server/srv-1'))
  })
})
