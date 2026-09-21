/**
 * Cronologia del servizio · giro UI del 15 set 2026, U-3: le voci di
 * configurazione (previousHealth null) non si leggono come un cambio di salute.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { ServiceHistorySection } from './ServiceHistorySection'
import { renderWithProviders } from '@/test/utils'
import type { ServiceHealthEntry } from '@/types/services'

const entry = (over: Partial<ServiceHealthEntry>): ServiceHealthEntry => ({
  id: 'h-1', at: '2026-09-15T12:00:00.000Z', health: 'degraded', previousHealth: null,
  impactScore: 28, trigger: 'map_changed', causes: [], note: null, ...over,
})

/** La SectionCard parte chiusa: la si apre come farebbe chi legge. */
const render = async (entries: ServiceHealthEntry[]) => {
  const { user } = renderWithProviders(<ServiceHistorySection mapId="map-1" entries={entries} total={entries.length} />)
  await user.click(screen.getByRole('button', { name: /History/ }))
}

describe('ServiceHistorySection', () => {
  it('una modifica della mappa dice la salute di quel momento e che il punteggio è di prima della rivalutazione', async () => {
    await render([entry({ note: 'Excluded: db-01' })])
    const row = await screen.findByTestId('service-history-entry')
    expect(row).toHaveTextContent('Map changed. Health at that moment')
    expect(row).toHaveTextContent('score 28, before the re-evaluation')
    expect(row).not.toHaveTextContent('no previous health')
    expect(row).toHaveTextContent('Excluded: db-01')
  })

  it('un cambio di salute vero resta una transizione, con la salute di prima', async () => {
    await render([entry({ trigger: 'map_changed', previousHealth: 'operational', health: 'degraded', impactScore: 22 })])
    expect(await screen.findByTestId('service-history-entry')).toHaveTextContent('Map changed: health')
    expect(await screen.findByTestId('service-history-entry')).toHaveTextContent('Operational')
  })

  it('la prima valutazione senza salute precedente lo dice ancora in chiaro', async () => {
    await render([entry({ trigger: 'ci_health', previousHealth: null })])
    expect(await screen.findByTestId('service-history-entry')).toHaveTextContent('no previous health')
  })
})
