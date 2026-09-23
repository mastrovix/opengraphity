/**
 * EDITING THE COMPONENTS OF A SERVICE MAP: an emptied weight, and answers without the map.
 *
 * G-MON-11: emptying a component's weight leaves an invalid value; choosing
 * then «never counts» disables the weight field — and the invalid value used
 * to stay, blocking «Save» on a field nobody could correct any more (and the
 * component would have been sent with `weight: NaN`). Choosing «never» puts
 * the saved weight back. And a save or an exclusion whose answer does not
 * carry the map is a FAILURE, said with the way out (reload), never a silent
 * success. `ServiceComponentsTable.test.tsx` and `.more.test.tsx` cover the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { mapDetail, preview } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'
import { ServiceComponentsTable } from './ServiceComponentsTable'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const MAP = mapDetail() as unknown as ServiceMapDetail
const table = () => renderWithProviders(<ServiceComponentsTable map={MAP} canEdit ciTypeLabel={(type) => type} onReload={() => {}} />)

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetServiceImpactPreview'] = { serviceImpactPreview: preview() }
})

describe('ServiceComponentsTable edits', () => {
  it('«never counts» after emptying the weight puts the saved weight back, and the component can be saved (G-MON-11)', async () => {
    const { user } = table()
    const weight = screen.getByLabelText('Weight of db-01')
    await user.clear(weight)
    expect(screen.getByTestId('components-dirty')).toHaveTextContent('Weight out of scale')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('How db-01 counts'), 'never')
    expect(weight).toHaveValue(5)
    expect(weight).toBeDisabled()
    expect(screen.getByTestId('components-dirty')).toHaveTextContent('1 component changed')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateServiceMapNodes')).toEqual({
      id: 'map-1', expectedVersion: 3, nodes: [{ ciId: 'db-01', propagate: 'never', weight: 5, critical: false }],
    })
  })

  it('a save whose answer does not carry the map is said as not saved, with the way out', async () => {
    apolloFinto.esiti['UpdateServiceMapNodes'] = { data: { updateServiceMapNodes: null } }
    const { user } = table()
    const weight = screen.getByLabelText('Weight of db-01')
    await user.clear(weight)
    await user.type(weight, '9')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Components not saved: updateServiceMapNodes did not return the map.')
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('an exclusion whose answer does not carry the map is said as not done', async () => {
    apolloFinto.esiti['ApplyServiceMapProposal'] = { data: { applyServiceMapProposal: null } }
    const { user } = table()
    await user.click(screen.getByRole('button', { name: 'Exclude db-01 from the map' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Exclude db-01 from the map?' })).getByRole('button', { name: 'Exclude' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('db-01 not excluded: applyServiceMapProposal did not return the map.'))
    expect(apolloFinto.chiamata('ApplyServiceMapProposal')).toEqual({ id: 'map-1', expectedVersion: 3, add: [], exclude: ['db-01'], remove: [] })
  })
})
