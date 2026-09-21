/**
 * Giro nel browser della verifica «Cosa resta cablato», ondata 1: salvare le
 * fasce di rischio falliva sempre con «Field "__typename" is not defined by type
 * RiskBandThresholdInput». La card rimandava le righe lette dalla cache di
 * Apollo, che portano il campo tecnico `__typename`, e l'input non lo accetta.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { GET_RISK_BAND_THRESHOLDS } from '@/graphql/queries'
import { UPDATE_RISK_BAND_THRESHOLDS } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { DomainMatricesPage } from './DomainMatricesPage'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const row = (band: string, upTo: number) => ({ __typename: 'RiskBandThreshold', band, upTo })
const bands = (thresholds: ReturnType<typeof row>[]) => ({
  riskBandThresholds: { __typename: 'RiskBandThresholds', thresholds, vocabulary: ['low', 'medium', 'high'], isDefault: false },
})

describe('DomainMatricesPage — fasce di rischio', () => {
  it('salva solo banda e soglia, senza i campi tecnici della cache', async () => {
    const seen: unknown[] = []
    const read: GqlMock = { request: { query: GET_RISK_BAND_THRESHOLDS }, result: { data: bands([row('low', 30), row('medium', 60), row('high', 100)]) }, maxUsageCount: Number.POSITIVE_INFINITY }
    const save: GqlMock = {
      request: { query: UPDATE_RISK_BAND_THRESHOLDS, variables: (v) => { seen.push(v); return true } },
      result: { data: { updateRiskBandThresholds: bands([row('low', 30), row('medium', 90), row('high', 100)]).riskBandThresholds } },
    }
    const { user } = renderWithProviders(<DomainMatricesPage />, { route: '/settings/domain-matrices', mocks: [read, save], showWarnings: false })

    // U-20: ogni soglia ha il nome della sua fascia (erano tre «Up to» indistinguibili).
    const medium = await screen.findByRole('spinbutton', { name: 'Up to — medium band' })
    expect(screen.getAllByRole('spinbutton').map((i) => i.getAttribute('aria-label'))).toEqual(['Up to — low band', 'Up to — medium band', 'Up to — high band'])
    await user.clear(medium)
    await user.type(medium, '90')
    // Il pulsante «Save» della card delle fasce: l'ultimo dei «Save» della pagina, quello dopo i campi soglia.
    const saveButtons = screen.getAllByRole('button', { name: 'Save' })
    await user.click(saveButtons[saveButtons.length - 1]!)

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Risk bands saved.'))
    expect(seen).toEqual([{ entries: [{ band: 'low', upTo: 30 }, { band: 'medium', upTo: 90 }, { band: 'high', upTo: 100 }] }])
  })
})
