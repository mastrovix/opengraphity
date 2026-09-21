/**
 * Anteprima dal vivo: una sola query per una raffica di modifiche (debounce
 * 400 ms) con l'ultimo valore, frase con badge/punteggio/componenti che
 * pesano, e l'errore detto in chiaro invece di un'anteprima vecchia.
 */
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { ServiceImpactPreviewLine, PREVIEW_DEBOUNCE_MS } from './ServiceImpactPreviewLine'
import { GET_SERVICE_IMPACT_PREVIEW } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { preview } from '@/test/mocks/services'
import type { ServiceImpactRulesInput } from '@/types/services'

const rules = (downSharePct: number): ServiceImpactRulesInput =>
  ({ downSharePct, degradedSharePct: 1, minNodes: 1, unknownNodes: 'ignore', openIncidentFrom: 'down', duringStorm: 'hold' })

describe('ServiceImpactPreviewLine', () => {
  it('la frase dice salute, punteggio e quanti componenti pesano', async () => {
    const mock: GqlMock = {
      request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: () => true },
      result: { data: { serviceImpactPreview: preview({ health: 'down', impactScore: 100, contributingCount: 1, nodeCount: 4 }) } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    renderWithProviders(<ServiceImpactPreviewLine mapId="map-1" rules={rules(50)} testId="p" />, { mocks: [mock] })
    const line = await screen.findByTestId('p')
    expect(line).toHaveTextContent('With these settings right now:')
    expect(line).toHaveTextContent('Down')
    expect(line).toHaveTextContent('score 100')
    expect(line).toHaveTextContent('1 of 4 components weighs')
  })

  it('debounce: una raffica di modifiche vale una sola query, con l\'ultimo valore', async () => {
    const seen: Record<string, unknown>[] = []
    const mock: GqlMock = {
      request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: (v) => { seen.push(v as Record<string, unknown>); return true } },
      result: { data: { serviceImpactPreview: preview() } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    const { rerender } = renderWithProviders(<ServiceImpactPreviewLine mapId="map-1" rules={rules(50)} testId="p" />, { mocks: [mock] })
    await waitFor(() => expect(seen).toHaveLength(1))

    rerender(<ServiceImpactPreviewLine mapId="map-1" rules={rules(60)} testId="p" />)
    rerender(<ServiceImpactPreviewLine mapId="map-1" rules={rules(70)} testId="p" />)
    rerender(<ServiceImpactPreviewLine mapId="map-1" rules={rules(80)} testId="p" />)
    // prima della scadenza del debounce non è partito nulla di nuovo
    expect(seen).toHaveLength(1)

    await new Promise((r) => setTimeout(r, PREVIEW_DEBOUNCE_MS + 150))
    await waitFor(() => expect(seen).toHaveLength(2))
    expect((seen[1]?.rules as ServiceImpactRulesInput).downSharePct).toBe(80)
  })

  it('errore della query → riga visibile, mai un\'anteprima silenziosa', async () => {
    const failing: GqlMock = { request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: () => true }, error: new Error('engine busy') }
    renderWithProviders(<ServiceImpactPreviewLine mapId="map-1" rules={rules(50)} testId="p" />, { mocks: [failing] })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Preview unavailable: engine busy')
    expect(screen.queryByTestId('p')).not.toBeInTheDocument()
  })
})
