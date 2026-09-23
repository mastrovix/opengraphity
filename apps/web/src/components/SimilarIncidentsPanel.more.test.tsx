/**
 * SIMILAR INCIDENTS: what the agent reads while working an incident.
 *
 * The panel lists past incidents that look like this one and the knowledge
 * articles that may solve it. What matters to the agent: each past incident is
 * a link with its number, title, how similar it is (a percentage that never
 * reads above 100% or below 0%) and whether it is already closed — by the
 * customer's own workflow, not by a fixed list of step names; each article
 * links to itself, or to the knowledge base when it has no address. Around the
 * list, the panel must never pass a wait for a result: loading, a failed
 * search and embeddings switched off by the organization are each said as such.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto, nomeOperazione } from '@/test/apolloFinto'

const polling = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), loading: new Set<string>() }))

vi.mock('@apollo/client/react', async () => {
  const fake = (await import('@/test/apolloFinto')).moduloApollo()
  return {
    ...fake,
    // The panel polls while the embedding is computed: the fake answers by name, and adds the polling handles.
    useQuery: (doc: Parameters<typeof fake.useQuery>[0], opts?: Parameters<typeof fake.useQuery>[1]) => ({
      ...fake.useQuery(doc, opts), loading: polling.loading.has(nomeOperazione(doc)), startPolling: polling.start, stopPolling: polling.stop,
    }),
  }
})
vi.mock('@/hooks/useWorkflowSteps', () => ({
  useWorkflowSteps: () => ({
    // The customer's workflow: «closed» is a terminal step, «fixed» is in the resolved category.
    isTerminal: (s: string) => s === 'closed',
    categoryOf: (s: string) => (s === 'fixed' ? 'resolved' : 'active'),
    // Like the real hook: a step nobody labels comes back with its name made readable.
    labelFor: (s: string) => ({ closed: 'Closed', fixed: 'Fixed', escalated: 'Sent to L2_desk' } as Record<string, string>)[s] ?? s.replace(/_/g, ' '),
  }),
}))

const { SimilarIncidentsPanel } = await import('./SimilarIncidentsPanel')

const incident = (over: Record<string, unknown>) => ({
  id: 'inc-x', number: 'INC-1', title: 'Title', status: 'new', severity: 'high', createdAt: null, resolvedAt: null, score: 0.5, ...over,
})
const answer = (over: { items?: unknown[]; articles?: unknown[]; disabled?: boolean } = {}) => ({
  similarIncidents: { ready: true, disabled: over.disabled ?? false, failure: null, items: over.items ?? [] },
  suggestedArticles: { ready: true, disabled: false, failure: null, items: over.articles ?? [] },
})

beforeEach(() => {
  apolloFinto.reset()
  polling.start.mockReset()
  polling.stop.mockReset()
  polling.loading.clear()
  apolloFinto.risposte['GetMe'] = { me: null }
})

describe('SimilarIncidentsPanel — around the list', () => {
  it('while the first answer is on its way it says it is loading, not «nothing similar»', () => {
    polling.loading.add('SimilarIncidents')
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No past incident is similar to this one.')).toBeNull()
  })

  it('a failed search says so, with the reason', () => {
    apolloFinto.erroriQuery['SimilarIncidents'] = new Error('vector index unavailable')
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.getByText('Semantic search error: vector index unavailable')).toBeInTheDocument()
    expect(polling.start).not.toHaveBeenCalled()
  })

  it('embeddings switched off by the organization: it says the feature is off, and does not wait for it', () => {
    apolloFinto.risposte['SimilarIncidents'] = answer({ disabled: true })
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.getByTestId('ai-disabled-embeddings')).toBeInTheDocument()
    expect(screen.queryByText(/Analysis under way/)).toBeNull()
    expect(polling.start).not.toHaveBeenCalled()
    expect(polling.stop).toHaveBeenCalled()
  })

  it('asks for this incident\'s five closest', () => {
    apolloFinto.risposte['SimilarIncidents'] = answer()
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-9" />)
    expect(apolloFinto.chiamata('SimilarIncidents')).toEqual({ incidentId: 'inc-9', limit: 5 })
  })
})

describe('SimilarIncidentsPanel — the similar incidents', () => {
  it('each one links to the incident and reads its number, title, similarity and step', () => {
    apolloFinto.risposte['SimilarIncidents'] = answer({ items: [
      incident({ id: 'inc-42', number: 'INC-0042', title: 'Database unreachable', status: 'new', score: 0.873 }),
      // No number yet: the start of the id stands in for it.
      incident({ id: 'abcdef1234567890', number: null, title: 'Disk full on web-01', status: 'waiting_vendor', score: 1.4 }),
      incident({ id: 'inc-7', number: 'INC-0007', title: 'Printer offline', status: 'new', score: -0.2 }),
    ] })
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    const db = screen.getByRole('link', { name: /Database unreachable/ })
    expect(db).toHaveAttribute('href', '/incidents/inc-42')
    expect(db).toHaveTextContent('INC-0042')
    expect(db).toHaveTextContent('87%')
    const disk = screen.getByRole('link', { name: /Disk full on web-01/ })
    expect(disk).toHaveTextContent('abcdef12')
    expect(disk).not.toHaveTextContent('abcdef1234567890')
    // A score outside [0, 1] is clamped, never «140%» or «-20%».
    expect(disk).toHaveTextContent('100%')
    expect(screen.getByRole('link', { name: /Printer offline/ })).toHaveTextContent('0%')
    // The step label, readable: the underscores of a raw step name become spaces.
    expect(within(disk).getByText('waiting vendor')).toBeInTheDocument()
    expect(screen.queryByText('No past incident is similar to this one.')).toBeNull()
  })

  it('a step label is shown as the customer wrote it, underscores included', () => {
    // Tour of 23 Sep 2026: the panel stripped the underscores from every label, real ones too.
    apolloFinto.risposte['SimilarIncidents'] = answer({ items: [incident({ title: 'Escalated one', status: 'escalated' })] })
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(within(screen.getByRole('link', { name: /Escalated one/ })).getByText('Sent to L2_desk')).toBeInTheDocument()
  })

  it('an incident at a terminal step, or in the resolved category, is marked closed; the others are not', () => {
    apolloFinto.risposte['SimilarIncidents'] = answer({ items: [
      incident({ id: 'a', title: 'Closed one', status: 'closed' }),
      incident({ id: 'b', title: 'Fixed one', status: 'fixed' }),
      incident({ id: 'c', title: 'Open one', status: 'new' }),
    ] })
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    const chip = (title: string, label: string) => within(screen.getByRole('link', { name: new RegExp(title) })).getByText(label)
    expect(chip('Closed one', 'Closed')).toHaveStyle({ background: 'var(--color-success-tint)', color: 'var(--color-success-text)' })
    expect(chip('Fixed one', 'Fixed')).toHaveStyle({ background: 'var(--color-success-tint)' })
    expect(chip('Open one', 'new')).toHaveStyle({ background: 'var(--color-slate-bg)', color: 'var(--color-slate)' })
  })
})

describe('SimilarIncidentsPanel — the suggested articles', () => {
  it('each article links to itself, or to the knowledge base when it has no address', () => {
    apolloFinto.risposte['SimilarIncidents'] = answer({ articles: [
      { id: 'kb1', title: 'Restart the replica', slug: 'restart-replica', category: 'db', score: 0.91 },
      { id: 'kb2', title: 'Draft without address', slug: null, category: null, score: 0.4 },
    ] })
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.getByText('Suggested articles')).toBeInTheDocument()
    const first = screen.getByRole('link', { name: /Restart the replica/ })
    expect(first).toHaveAttribute('href', '/knowledge-base/restart-replica')
    expect(first).toHaveTextContent('91%')
    expect(screen.getByRole('link', { name: /Draft without address/ })).toHaveAttribute('href', '/knowledge-base')
  })

  it('without articles there is no articles heading', () => {
    apolloFinto.risposte['SimilarIncidents'] = answer({ items: [incident({})] })
    renderWithProviders(<SimilarIncidentsPanel incidentId="inc-1" />)
    expect(screen.queryByText('Suggested articles')).toBeNull()
  })
})
