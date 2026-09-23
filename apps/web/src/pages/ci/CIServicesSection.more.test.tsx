/**
 * «SERVICES DEPENDING ON THIS CI»: what the base test does not walk.
 *
 * A service in a change window shows «maintenance», which alone hides how the
 * service would be without the window (R1): the row says it next to the
 * badge. And a failed load keeps a Retry that really reloads, so that an
 * error never turns into a silent «no service».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { mapRow } from '@/test/mocks/services'
import { CIServicesSection } from './CIServicesSection'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

beforeEach(() => { apolloFinto.reset() })

describe('CIServicesSection', () => {
  it('asks for the services of THIS CI', () => {
    apolloFinto.risposte['GetServicesImpactedByCI'] = { servicesImpactedByCI: [] }
    renderWithProviders(<CIServicesSection ciId="db-01" />)
    expect(apolloFinto.chiamata('GetServicesImpactedByCI')).toEqual({ ciId: 'db-01' })
  })

  it('a service in a change window says how it would be without it; one that is not, says nothing more', () => {
    apolloFinto.risposte['GetServicesImpactedByCI'] = { servicesImpactedByCI: [
      mapRow({ id: 'map-1', name: 'Enterprise Billing', health: 'maintenance', healthIfActive: 'down' }),
      mapRow({ id: 'map-2', name: 'Payroll', health: 'degraded', healthIfActive: null }),
    ] }
    renderWithProviders(<CIServicesSection ciId="db-01" />)
    const [billing, payroll] = screen.getAllByTestId('ci-service-row')
    expect(within(billing!).getByTestId('health-if-active')).toHaveTextContent('in maintenance, would be: Down')
    expect(within(payroll!).queryByTestId('health-if-active')).toBeNull()
  })

  it('Retry after a failed load really reloads the services', async () => {
    apolloFinto.erroriQuery['GetServicesImpactedByCI'] = new Error('services down')
    const { user } = renderWithProviders(<CIServicesSection ciId="db-01" />)
    expect(screen.getByText('services down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })
})
