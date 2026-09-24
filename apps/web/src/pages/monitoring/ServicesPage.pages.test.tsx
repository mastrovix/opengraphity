/**
 * THE MONITORED SERVICES LIST: a page that no longer exists, and a Retry.
 *
 * The list polls. When the total shrinks under the page on screen (services
 * deleted meanwhile, or a shared link to page 3 of a list that now has one),
 * the list moves to the last page that exists instead of showing an empty
 * table that reads as «no services». And after a failed load, Retry really
 * asks again. `ServicesPage.test.tsx` and `.more.test.tsx` cover the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { mapRow, COUNTS } from '@/test/mocks/services'
import { ServicesPage } from './ServicesPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetServiceMaps'] = { serviceMaps: { items: [mapRow()], total: 60, counts: COUNTS } }
})

describe('ServicesPage pages', () => {
  it('a page beyond the last one moves to the last page that exists', async () => {
    renderWithProviders(<ServicesPage />, { route: '/monitoring/services?page=4' })
    // 60 services, 50 a page: the last page is the second.
    await attendiURL('/monitoring/services', { page: '2' })
    expect(apolloFinto.chiamata('GetServiceMaps')).toMatchObject({ offset: 50, limit: 50 })
  })

  it('a page that exists is kept', async () => {
    renderWithProviders(<ServicesPage />, { route: '/monitoring/services?page=2' })
    await attendiURL('/monitoring/services', { page: '2' })
  })

  /*
   * Review of 23 Sep 2026: after a failure for NEW variables Apollo gives
   * `data: undefined` and the old filter's result as `previousData`; the page
   * showed those rows as the answer, with the new tile pressed.
   */
  it('a new filter that fails shows the error, not the previous filter\'s rows', () => {
    apolloFinto.precedenti['GetServiceMaps'] = { serviceMaps: { items: [mapRow({ name: 'Old filter row' })], total: 60, counts: COUNTS } }
    apolloFinto.erroriQuery['GetServiceMaps'] = new Error('services down')
    renderWithProviders(<ServicesPage />, { route: '/monitoring/services?health=down' })
    expect(screen.queryByText('Old filter row')).toBeNull()
    expect(screen.getByText('services down')).toBeInTheDocument()
  })

  it('while the new filter is on its way the previous rows stay, marked as updating', () => {
    apolloFinto.precedenti['GetServiceMaps'] = { serviceMaps: { items: [mapRow({ name: 'Old filter row' })], total: 60, counts: COUNTS } }
    apolloFinto.statiDiRete['GetServiceMaps'] = 2
    delete apolloFinto.risposte['GetServiceMaps']
    renderWithProviders(<ServicesPage />, { route: '/monitoring/services?health=down' })
    expect(screen.getByText('Old filter row')).toBeInTheDocument()
  })

  it('a poll that fails keeps the rows and says they are not current', () => {
    apolloFinto.erroriDiPolling['GetServiceMaps'] = new Error('gateway timeout')
    renderWithProviders(<ServicesPage />, { route: '/monitoring/services' })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh: gateway timeout')
  })

  it('after a failed load, Retry asks for the list again', async () => {
    apolloFinto.erroriQuery['GetServiceMaps'] = new Error('services down')
    const { user } = renderWithProviders(<ServicesPage />, { route: '/monitoring/services' })
    expect(screen.getByText('services down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
