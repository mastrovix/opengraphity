/**
 * Interruttore «Aggiorna automaticamente i componenti» (ondata 5): stato
 * acceso/spento letto dalla mappa, aiuto in due righe con la garanzia sulle
 * esclusioni, spegnimento e riaccensione con `expectedVersion` = la versione
 * letta, e conflitto di versione che nomina la sincronizzazione automatica e
 * offre «Ricarica».
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { ServiceAutoSyncToggle } from './ServiceAutoSyncToggle'
import { SET_SERVICE_MAP_AUTO_SYNC } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { mapDetail } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'

const detail = (over: Record<string, unknown> = {}) => mapDetail(over) as unknown as ServiceMapDetail

function renderToggle(opts: { map?: ServiceMapDetail; extra?: GqlMock[]; onReload?: () => void } = {}) {
  return renderWithProviders(
    <ServiceAutoSyncToggle map={opts.map ?? detail()} onReload={opts.onReload ?? (() => {})} />,
    { mocks: opts.extra ?? [] },
  )
}

const switchOf = () => screen.getByRole('switch', { name: 'Update components automatically' })

describe('ServiceAutoSyncToggle', () => {
  it('mappa viva: interruttore acceso, aiuto sulle due modalità e garanzia su esclusioni e componenti a mano', async () => {
    renderToggle()
    expect(switchOf()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/On: the map follows the graph on its own/)).toBeInTheDocument()
    expect(screen.getByText('Either way, exclusions and components added by hand stay exactly as you left them.')).toBeInTheDocument()
  })

  it('mappa congelata: interruttore spento', () => {
    renderToggle({ map: detail({ autoSync: false }) })
    expect(switchOf()).toHaveAttribute('aria-checked', 'false')
  })

  it('spegnere l\'interruttore manda expectedVersion = la versione letta; riaccenderlo manda autoSync: true', async () => {
    const seen: unknown[] = []
    const off: GqlMock = {
      request: { query: SET_SERVICE_MAP_AUTO_SYNC, variables: (v) => { seen.push(v); return true } },
      result: { data: { setServiceMapAutoSync: mapDetail({ autoSync: false, version: 4 }) } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    const { user, rerender } = renderToggle({ extra: [off] })
    await user.click(switchOf())
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, autoSync: false }]))

    rerender(<ServiceAutoSyncToggle map={detail({ autoSync: false, version: 4 })} onReload={() => {}} />)
    expect(switchOf()).toHaveAttribute('aria-checked', 'false')
    await user.click(switchOf())
    await waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toEqual({ id: 'map-1', expectedVersion: 4, autoSync: true })
  })

  it('conflitto di versione → riga d\'errore che nomina la sincronizzazione automatica, con «Ricarica»', async () => {
    const onReload = vi.fn()
    const failing: GqlMock = {
      request: { query: SET_SERVICE_MAP_AUTO_SYNC, variables: () => true },
      error: new Error('the map has been changed by someone else (version 5)'),
    }
    const { user } = renderToggle({ extra: [failing], onReload })
    await user.click(switchOf())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Mode not changed: the map has been changed by someone else (version 5). If another admin — or the automatic sync — changed the map, reload and try again.')
    await user.click(within(alert).getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
    // l'interruttore non finge: resta com'era finché la mappa non cambia davvero
    expect(switchOf()).toHaveAttribute('aria-checked', 'true')
  })
})
