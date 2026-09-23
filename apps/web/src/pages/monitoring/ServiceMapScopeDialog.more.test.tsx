/**
 * «CHANGE SCOPE»: an answer without the map, and relationships that cannot be read.
 *
 * A save whose answer does not carry the map is a failure said in the dialog
 * — never a «scope saved» toast with nothing saved, which would send the
 * administrator looking at a map that did not change. And when the
 * relationship types cannot be loaded the dialog says so, with the reason,
 * instead of offering an empty list. `ServiceMapScopeDialog.test.tsx` covers the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { mapDetail } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'
import { ServiceMapScopeDialog } from './ServiceMapScopeDialog'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  apolloFinto.risposte['GetServiceRelationshipTypes'] = { serviceRelationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'] }
})

const openDialog = (onClose = vi.fn()) => ({
  onClose,
  ...renderWithProviders(<ServiceMapScopeDialog map={mapDetail({ relationshipTypes: ['DEPENDS_ON'] }) as unknown as ServiceMapDetail} onClose={onClose} onReload={vi.fn()} />),
})

describe('ServiceMapScopeDialog', () => {
  it('a save whose answer does not carry the map is said in the dialog, and the dialog stays', async () => {
    apolloFinto.esiti['UpdateServiceMapScope'] = { data: { updateServiceMapScope: null } }
    const { user, onClose } = openDialog()
    await user.click(screen.getByLabelText('HOSTED_ON'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(apolloFinto.chiamata('UpdateServiceMapScope')).toEqual({ id: 'map-1', expectedVersion: 3, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'], maxDepth: 4 })
    expect(await screen.findByText(/updateServiceMapScope did not return the map/)).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('relationship types that cannot be loaded are said, with the reason', () => {
    apolloFinto.erroriQuery['GetServiceRelationshipTypes'] = new Error('metamodel down')
    openDialog()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load relationship types: metamodel down')
  })
})
