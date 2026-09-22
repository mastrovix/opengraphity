/**
 * Page-level wiring of the alarm detail that EventDetailPage.test.tsx does
 * not reach: a failed load offers a retry that actually reloads the alarm,
 * "Back" on a missing alarm returns to the console, and after an action the
 * page re-reads the alarm so the new state and history entry show at once
 * (otherwise the operator acknowledges, sees nothing change, and clicks again).
 *
 * EventActions is replaced by a stub: its own mutations are tested in
 * EventActions*.test.tsx; here only its `onChanged` contract with the page
 * matters.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { EventDetailPage } from './EventDetailPage'
import { GET_EVENT, GET_EVENT_POLICY } from '@/graphql/queries'
import { renderWithProviders, attendiURL, type GqlMock } from '@/test/utils'
import { withVocabularyLabels } from '@/test/vocabularies'
import { meMock } from '@/test/mocks/gql'

vi.mock('./EventActions', () => ({
  EventActions: ({ onChanged, only }: { onChanged: () => void; only?: string[] }) => (
    <button type="button" onClick={onChanged}>{only ? 'stub-action-correlation' : 'stub-action-header'}</button>
  ),
}))

const EVENT = {
  __typename: 'Event', id: 'e1', fingerprint: 'fp', externalId: null, resourceExternalId: null, status: 'firing', severity: 'warning', maxSeverity: 'warning',
  title: 'Disk almost full', description: null, resource: 'db-01', resourceKind: 'hostname', matchReason: 'name', labels: null,
  count: 1, firstSeenAt: '2026-09-09T08:00:00Z', lastSeenAt: '2026-09-09T08:00:00Z', resolvedAt: null,
  acknowledgedAt: null, acknowledgedBy: null, source: null, ci: null, incident: null,
  suppressedBy: null, correlation: 'skipped_orphan', correlationAt: null, flappingSince: null, transitions24h: 0,
  history: [], historyCount: 0,
}

const eventResult = (over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_EVENT, variables: { id: 'e1' } },
  result: { data: { event: { ...EVENT, ...over } } },
})
const policyError = (): GqlMock => ({ request: { query: GET_EVENT_POLICY }, error: new Error('no policy'), maxUsageCount: Number.POSITIVE_INFINITY })

const render = (mocks: GqlMock[], role = 'admin') =>
  renderWithProviders(withVocabularyLabels(<EventDetailPage />), { route: '/events/e1', path: '/events/:id', mocks: [meMock(role), policyError(), ...mocks] })

describe('EventDetailPage (more)', () => {
  it('a failed load shows the error; Retry reloads the alarm', async () => {
    const { user } = render([
      { request: { query: GET_EVENT, variables: { id: 'e1' } }, error: new Error('graph unreachable') },
      eventResult(),
    ])
    expect(await screen.findByText(/graph unreachable/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Disk almost full' })).toBeInTheDocument()
  })

  it('"Back" on a missing alarm returns to the alarms console', async () => {
    const { user } = render([{ request: { query: GET_EVENT, variables: { id: 'e1' } }, result: { data: { event: null } } }])
    await user.click(await screen.findByRole('button', { name: 'Back to alarms' }))
    await attendiURL('/events')
  })

  it.each(['stub-action-header', 'stub-action-correlation'])('after an action (%s) the page re-reads the alarm', async (button) => {
    const { user } = render([eventResult(), eventResult({ title: 'Disk almost full (acknowledged)' })])
    await screen.findByRole('heading', { level: 1, name: 'Disk almost full' })
    await user.click(screen.getByRole('button', { name: button }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Disk almost full (acknowledged)' })).toBeInTheDocument()
  })

  it('a resolved alarm shows when it was resolved', async () => {
    render([eventResult({ status: 'resolved', resolvedAt: '2026-09-09T09:00:00Z' })])
    await screen.findByRole('heading', { level: 1, name: 'Disk almost full' })
    expect(screen.getByText('Resolved at')).toBeInTheDocument()
  })
})
