/**
 * SIMILAR INCIDENTS: waiting is only true while nothing failed (D15, tour of
 * 23 Sep 2026). The API queues the embedding itself when it is missing, so
 * «Analysis under way…» is honest — until the computation fails. Then the
 * panel stops polling and says why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
}))

vi.mock('@apollo/client/react', () => ({
  useQuery: () => ({ data: state.data, loading: false, error: undefined, startPolling: state.startPolling, stopPolling: state.stopPolling }),
}))
vi.mock('@/hooks/useWorkflowSteps', () => ({
  useWorkflowSteps: () => ({ isTerminal: () => false, categoryOf: () => 'active', labelFor: (s: string) => s }),
}))

const { SimilarIncidentsPanel } = await import('./SimilarIncidentsPanel')

const answer = (over: { ready?: boolean; failure?: string | null; items?: unknown[] } = {}) => ({
  similarIncidents: { ready: over.ready ?? true, disabled: false, failure: over.failure ?? null, items: over.items ?? [] },
  suggestedArticles: { ready: over.ready ?? true, disabled: false, failure: null, items: [] },
})

beforeEach(() => { state.startPolling.mockReset(); state.stopPolling.mockReset() })

describe('SimilarIncidentsPanel', () => {
  it('while the embedding is being computed it says so, and polls', () => {
    state.data = answer({ ready: false })
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.getByText(/Analysis under way/)).toBeInTheDocument()
    expect(state.startPolling).toHaveBeenCalledWith(4000)
  })

  it('a failed computation stops the polling and says why, instead of «Analysis under way»', () => {
    state.data = answer({ ready: false, failure: 'embedding service unreachable' })
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.getByRole('alert')).toHaveTextContent('The similarity analysis of this incident failed: embedding service unreachable')
    expect(screen.queryByText(/Analysis under way/)).not.toBeInTheDocument()
    expect(state.startPolling).not.toHaveBeenCalled()
    expect(state.stopPolling).toHaveBeenCalled()
  })

  it('a failure reported on the suggested articles is shown too', () => {
    state.data = { ...answer({ ready: false }), suggestedArticles: { ready: false, disabled: false, failure: 'quota exceeded', items: [] } }
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.getByRole('alert')).toHaveTextContent('quota exceeded')
  })

  it('ready and empty: «no similar incident», no error', () => {
    state.data = answer()
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.getByText('No past incident is similar to this one.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
