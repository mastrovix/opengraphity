/**
 * THE FIRST SUSPECTS OF AN INCIDENT, on their own card (owner, 25 Sep 2026).
 *
 * What these pin:
 *  - a change being released at the opening says so, as the first suspect; the
 *    others say when their release ended;
 *  - each says its step as the workflow names it and the incident's CIs it
 *    affects, and leads to the change;
 *  - shown, never linked: no button;
 *  - nothing released says so; a failed read says why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { formatDateTime } from '@/lib/datetime'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('@/hooks/useWorkflowSteps', () => ({
  useWorkflowSteps: () => ({ labelFor: (s: string) => ({ rilascio: 'Deployment', chiusa: 'Closed' } as Record<string, string>)[s] ?? s }),
}))

const { ChangeSuspectsCard } = await import('./ChangeSuspectsCard')

const SUSPECTS = [
  { id: 'c1', code: 'CHG0000231', title: 'Patch del kernel', status: 'rilascio', runningAtOpening: true, releasedAt: null, cis: [{ id: 's2', name: 'SRV-020' }] },
  { id: 'c2', code: 'CHG0000219', title: 'Nuovo indice', status: 'chiusa', runningAtOpening: false, releasedAt: '2026-09-18T22:00:00.000Z',
    cis: [{ id: 'a1', name: 'CRM' }, { id: 'd1', name: 'DB-CRM' }] },
]
const mount = () => renderWithProviders(<ChangeSuspectsCard incidentId="inc-1" />)

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['IncidentChangeSuspects'] = { incidentChangeSuspects: SUSPECTS }
})

describe('ChangeSuspectsCard', () => {
  it('the change being released at the opening says so; another says when its release ended', () => {
    mount()
    const [first, second] = screen.getAllByRole('listitem')
    expect(first).toHaveTextContent('CHG0000231')
    expect(first).toHaveTextContent('Being released at the opening')
    expect(first).toHaveTextContent('Deployment')
    expect(first).toHaveTextContent('On SRV-020')
    expect(second).not.toHaveTextContent('Being released at the opening')
    expect(second).toHaveTextContent(`Release ended ${formatDateTime('2026-09-18T22:00:00.000Z')}`)
    expect(second).toHaveTextContent('Closed')
    expect(second).toHaveTextContent('On CRM, DB-CRM')
    expect(screen.getByRole('link', { name: 'Patch del kernel' })).toHaveAttribute('href', '/changes/c1')
    expect(apolloFinto.chiamata('IncidentChangeSuspects')).toEqual({ incidentId: 'inc-1' })
  })

  it('shown, never linked: no button', () => {
    mount()
    expect(screen.queryByRole('button', { name: /link/i })).toBeNull()
  })

  it('nothing released says so; a failed read says why', () => {
    apolloFinto.risposte['IncidentChangeSuspects'] = { incidentChangeSuspects: [] }
    const first = mount()
    expect(screen.getByText('No change was being released on this incident\'s CIs, at the opening or in the days before.')).toBeInTheDocument()
    first.unmount()
    apolloFinto.erroriQuery['IncidentChangeSuspects'] = new Error('neo4j down')
    mount()
    expect(screen.getByRole('alert')).toHaveTextContent('The changes on this incident\'s CIs could not be read: neo4j down')
  })
})
