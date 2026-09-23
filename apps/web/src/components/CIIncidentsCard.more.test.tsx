/**
 * The tickets of a CI on its detail page (incidents, problems, requests).
 *
 * What a user relies on: the card says how many tickets touch the CI before
 * it is opened; open tickets come first, closed ones are grouped apart and
 * dimmed (they are history, not work); each row opens its ticket; and a CI
 * with no ticket says so instead of showing an empty box.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { CIIncidentsCard } = await import('./CIIncidentsCard')

const step = (name: string, label: string, isTerminal: boolean, order: number) => ({
  id: name, name, label, labels: [], type: 'state', isInitial: order === 0, isTerminal, isOpen: !isTerminal,
  category: null, purpose: null, order,
})

/** The tenant's severity vocabulary, loaded (the badges read their labels from it). */
const withSeverities = (ui: React.ReactElement) => withVocabularyLabels(ui, { severity: { critical: 'Critical', high: 'High' } })

const ticket = (id: string, number: string, status: string, over: Record<string, unknown> = {}) => ({
  id, number, title: `Title of ${number}`, severity: null, priority: null, status,
  createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-02T08:00:00Z', ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { transitions: [], steps: [
    step('new', 'New', false, 0), step('resolved', 'Resolved', false, 1), step('closed', 'Closed', true, 2),
  ] } }
})

describe('CIIncidentsCard (more)', () => {
  it('counts the tickets while closed, and asks for the tickets of this CI', () => {
    apolloFinto.risposte['GetCIIncidents'] = { ciIncidents: [ticket('i1', 'INC001', 'new'), ticket('i2', 'INC002', 'closed')] }
    renderWithProviders(<CIIncidentsCard ciId="ci-7" />)
    const header = screen.getByRole('button', { name: /Incident/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(header).toHaveTextContent('2')
    expect(apolloFinto.chiamata('GetCIIncidents')).toEqual({ ciId: 'ci-7' })
    expect(screen.queryByText('INC001')).not.toBeInTheDocument()
  })

  it('open tickets come first; closed ones are grouped apart and dimmed', async () => {
    apolloFinto.risposte['GetCIIncidents'] = { ciIncidents: [
      ticket('i2', 'INC002', 'closed', { severity: 'high' }),
      ticket('i1', 'INC001', 'new', { severity: 'critical' }),
    ] }
    const { user } = renderWithProviders(withSeverities(<CIIncidentsCard ciId="ci-7" />))
    await user.click(screen.getByRole('button', { name: /Incident/ }))
    const inProgress = screen.getByText('In progress').parentElement as HTMLElement
    const closed = screen.getByText('Closed', { selector: 'div' }).parentElement as HTMLElement
    expect(within(inProgress).getByText('INC001')).toBeInTheDocument()
    expect(within(inProgress).queryByText('INC002')).not.toBeInTheDocument()
    expect(within(closed).getByText('INC002')).toBeInTheDocument()
    const openRow = within(inProgress).getByRole('button', { name: /INC001/ })
    const closedRow = within(closed).getByRole('button', { name: /INC002/ })
    expect(openRow).toHaveStyle({ opacity: '1' })
    expect(closedRow).toHaveStyle({ opacity: '0.5' })
    // Each row carries the ticket title and its step label.
    expect(openRow).toHaveTextContent('Title of INC001')
    expect(openRow).toHaveTextContent('New')
  })

  it('a row opens its ticket', async () => {
    apolloFinto.risposte['GetCIIncidents'] = { ciIncidents: [ticket('i1', 'INC001', 'new')] }
    const { user } = renderWithProviders(<CIIncidentsCard ciId="ci-7" />)
    await user.click(screen.getByRole('button', { name: /Incident/ }))
    await user.click(screen.getByRole('button', { name: /INC001/ }))
    await attendiURL('/incidents/i1')
  })

  it('a service request row opens the request page', async () => {
    apolloFinto.risposte['GetCIServiceRequests'] = { ciServiceRequests: [ticket('r1', 'REQ001', 'new')] }
    const { user } = renderWithProviders(<CIIncidentsCard ciId="ci-7" kind="service_request" />)
    await user.click(screen.getByRole('button', { name: /Service Request/ }))
    await user.click(screen.getByRole('button', { name: /REQ001/ }))
    await attendiURL('/requests/r1')
  })

  it('a ticket with neither severity nor priority shows no severity badge', async () => {
    apolloFinto.risposte['GetCIProblems'] = { ciProblems: [
      ticket('p1', 'PRB001', 'new', { priority: 'high' }),
      ticket('p2', 'PRB002', 'new'),
    ] }
    const { user } = renderWithProviders(withSeverities(<CIIncidentsCard ciId="ci-7" kind="problem" />))
    await user.click(screen.getByRole('button', { name: /Problem/ }))
    // The problem's priority stands in for the incident's severity.
    expect(within(screen.getByRole('button', { name: /PRB001/ })).getByTitle('high')).toHaveTextContent('High')
    // No badge at all (not even a dash): number, title and step, nothing else.
    expect(screen.getByRole('button', { name: /PRB002/ }).textContent).toBe('PRB002Title of PRB002New')
  })

  it('a CI with no ticket says so, per kind', async () => {
    apolloFinto.risposte['GetCIIncidents'] = { ciIncidents: [] }
    const { user, unmount } = renderWithProviders(<CIIncidentsCard ciId="ci-7" />)
    await user.click(screen.getByRole('button', { name: /Incident/ }))
    expect(screen.getByText('No incident on this CI.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Incident/ }))
    expect(screen.queryByText('No incident on this CI.')).not.toBeInTheDocument()
    unmount()
    const again = renderWithProviders(<CIIncidentsCard ciId="ci-7" kind="service_request" />)
    await again.user.click(screen.getByRole('button', { name: /Service Request/ }))
    expect(screen.getByText('No service request concerns this CI.')).toBeInTheDocument()
  })
})
