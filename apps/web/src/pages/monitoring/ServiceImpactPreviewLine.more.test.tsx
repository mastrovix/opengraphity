/**
 * THE LIVE PREVIEW FOLLOWS THE MAP'S EVALUATION (revision 2 · C-8).
 *
 * The preview answers «with these settings, right now». When the map is
 * evaluated again, «right now» has changed and the preview is read again;
 * before C-8 it stayed at the moment it was mounted, and ten minutes later it
 * could contradict the header without a word. It must not re-read when
 * nothing was evaluated (the query has just run), and a re-read keeps showing
 * the last preview, dimmed, instead of blanking the line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { preview } from '@/test/mocks/services'
import { ServiceImpactPreviewLine } from './ServiceImpactPreviewLine'

// The shared fake answers at once: named in `held`, the query is in flight
// again with its previous answer still there, as Apollo keeps it.
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useQuery>[0]
  type Opts = Parameters<typeof m.useQuery>[1]
  return {
    ...m,
    useQuery: (doc: Doc, opts?: Opts) => {
      const r = m.useQuery(doc, opts)
      return held.has(nomeOperazione(doc)) ? { ...r, previousData: r.data, data: undefined, loading: true } : r
    },
  }
})

beforeEach(() => {
  apolloFinto.reset()
  held.clear()
  apolloFinto.risposte['GetServiceImpactPreview'] = { serviceImpactPreview: preview({ health: 'degraded', impactScore: 41, contributingCount: 3, nodeCount: 9 }) }
})

describe('ServiceImpactPreviewLine and the map\'s evaluation', () => {
  it('is read again when the map is evaluated again, and not before', () => {
    const { rerender } = renderWithProviders(<ServiceImpactPreviewLine mapId="map-1" evaluatedAt="2026-09-23T10:00:00Z" testId="p" />)
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
    rerender(<ServiceImpactPreviewLine mapId="map-1" evaluatedAt="2026-09-23T10:00:00Z" testId="p" />)
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
    rerender(<ServiceImpactPreviewLine mapId="map-1" evaluatedAt="2026-09-23T10:10:00Z" testId="p" />)
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('while it is read again, the last preview stays on screen, dimmed', () => {
    held.add('GetServiceImpactPreview')
    renderWithProviders(<ServiceImpactPreviewLine mapId="map-1" testId="p" />)
    const line = screen.getByTestId('p')
    expect(line).toHaveTextContent('score 41')
    expect(line.style.opacity).toBe('0.6')
  })

  it('with nothing to show yet it says the preview is coming', () => {
    delete apolloFinto.risposte['GetServiceImpactPreview']
    renderWithProviders(<ServiceImpactPreviewLine mapId="map-1" testId="p" />)
    expect(screen.queryByTestId('p')).toBeNull()
    expect(screen.getByText('Computing the preview…')).toBeInTheDocument()
  })
})
