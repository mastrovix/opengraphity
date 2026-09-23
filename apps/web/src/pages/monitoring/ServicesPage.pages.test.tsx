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

  it('after a failed load, Retry asks for the list again', async () => {
    apolloFinto.erroriQuery['GetServiceMaps'] = new Error('services down')
    const { user } = renderWithProviders(<ServicesPage />, { route: '/monitoring/services' })
    expect(screen.getByText('services down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})
