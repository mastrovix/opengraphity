/**
 * «Modifica ambito» (revisione del 15 set 2026 · SV-6): tipi di relazione e
 * profondità di una mappa esistente. Prima si fissavano alla creazione e
 * nessuna schermata li cambiava.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { ServiceMapScopeDialog } from './ServiceMapScopeDialog'
import { GET_SERVICE_RELATIONSHIP_TYPES } from '@/graphql/queries'
import { UPDATE_SERVICE_MAP_SCOPE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear() })

const typesMock = (types: string[]): GqlMock => ({
  request: { query: GET_SERVICE_RELATIONSHIP_TYPES },
  result: { data: { serviceRelationshipTypes: types } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function renderDialog(map: Record<string, unknown>, mocks: GqlMock[], onClose = vi.fn(), onReload = vi.fn()) {
  return { onClose, onReload, ...renderWithProviders(<ServiceMapScopeDialog map={map as unknown as ServiceMapDetail} onClose={onClose} onReload={onReload} />, { mocks }) }
}

describe('ServiceMapScopeDialog', () => {
  it('parte dall\'ambito della mappa, offre le relazioni del cliente e salva tipi e profondità con la versione letta', async () => {
    const seen: unknown[] = []
    const update: GqlMock = {
      request: { query: UPDATE_SERVICE_MAP_SCOPE, variables: (v) => { seen.push(v); return true } },
      result: { data: { updateServiceMapScope: mapDetail({ version: 4, maxDepth: 6, relationshipTypes: ['DEPENDS_ON', 'PROTECTS'] }) } },
    }
    const { user, onClose } = renderDialog(mapDetail({ relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'] }), [typesMock(['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'PROTECTS']), update])
    const protects = await screen.findByLabelText('PROTECTS')
    expect(screen.getByLabelText('DEPENDS_ON')).toBeChecked()
    expect(protects).not.toBeChecked()
    // niente cambiato → il salvataggio non parte
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(protects)
    await user.click(screen.getByLabelText('HOSTED_ON'))
    const depth = screen.getByLabelText('Maximum depth')
    await user.clear(depth)
    await user.type(depth, '6')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, relationshipTypes: ['DEPENDS_ON', 'PROTECTS'], maxDepth: 6 }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Scope saved (version 4)'))
    expect(onClose).toHaveBeenCalled()
  })

  it('un tipo seguito che il metamodello non dichiara più si vede, non spuntato: salvando si toglie', async () => {
    const seen: unknown[] = []
    const update: GqlMock = {
      request: { query: UPDATE_SERVICE_MAP_SCOPE, variables: (v) => { seen.push(v); return true } },
      result: { data: { updateServiceMapScope: mapDetail({ version: 4 }) } },
    }
    const { user } = renderDialog(mapDetail({ relationshipTypes: ['DEPENDS_ON', 'BALANCES'] }), [typesMock(['DEPENDS_ON', 'HOSTED_ON']), update])
    expect(await screen.findByTestId('scope-not-declared')).toHaveTextContent('BALANCES — no longer declared in the metamodel: saving removes it')
    // il solo tipo vecchio da togliere basta a rendere il salvataggio possibile
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, relationshipTypes: ['DEPENDS_ON'], maxDepth: 4 }]))
  })

  it('nessuna relazione scelta → detto, e il salvataggio non parte; il rifiuto dell\'API è una riga con «Ricarica»', async () => {
    const update: GqlMock = { request: { query: UPDATE_SERVICE_MAP_SCOPE, variables: () => true }, error: new Error('ServiceMap map-1 was modified by someone else') }
    const { user, onReload } = renderDialog(mapDetail({ relationshipTypes: ['DEPENDS_ON'] }), [typesMock(['DEPENDS_ON', 'HOSTED_ON']), update])
    await user.click(await screen.findByLabelText('DEPENDS_ON'))
    expect(screen.getByText('Choose at least one relationship.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.click(screen.getByLabelText('HOSTED_ON'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/was modified by someone else/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalled()
  })
})
