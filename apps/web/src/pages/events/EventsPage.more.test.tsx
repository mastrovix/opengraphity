/**
 * THE ALARM CONSOLE: filters that live in the address, and the ways out of them.
 *
 * The base file drives the console through MockedProvider; this one answers by
 * operation name (fake Apollo) so it can reach the corners cheaply. What an
 * operator loses if these regress:
 *  - a counter tile that sets the wrong filter (the list disagrees with the
 *    number just clicked);
 *  - a context chip (this incident / this change / a deleted source) that can
 *    no longer be removed, leaving an invisible filter and an empty list;
 *  - a page number beyond the last page after alarms resolve ("3 / 2", empty
 *    table), or pagination that does not move;
 *  - a shared link whose advanced filter changes under an open panel that
 *    keeps showing the old rules;
 *  - a failing query shown as "no alarms" instead of an error with a retry;
 *  - the "Resolved 24h" window freezing at the moment of the first click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, within, waitFor } from '@testing-library/react'
import { useNavigate } from 'react-router-dom'
import { apolloFinto } from '@/test/apolloFinto'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { meFixture } from '@/test/mocks/gql'
import { FILTER_GROUP_PARAM, encodeFilterGroup } from '@/lib/filterGroupUrl'
import type { EventRow, EventStats } from '@/types/events'
import { EventsPage } from './EventsPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const STATS: EventStats = { firing: 4, critical: 2, warning: 1, orphan: 1, suppressed: 0, flapping: 1, resolved24h: 7, stormSources: [] }

function ev(over: Partial<EventRow> & { id: string }): EventRow {
  return {
    status: 'firing', severity: 'critical', title: `Alert ${over.id}`, resource: 'web-01', resourceKind: 'hostname',
    count: 3, lastSeenAt: new Date().toISOString(), acknowledgedAt: null,
    source: { id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
    ci: { id: 'ci1', name: 'web-01', type: 'server', status: 'active', health: null },
    incident: null, suppressedBy: null, correlation: 'none', correlationAt: null,
    flappingSince: null, transitions24h: 0, matchReason: null,
    ...over,
  } as EventRow
}

type Vars = { filter: Record<string, unknown> | null; limit: number; offset: number }

/** One stable answer per offset: a fresh object per render would re-run every effect on it. */
function pagedEvents(total: number, items: EventRow[]) {
  const cache = new Map<number, unknown>()
  return (v?: Record<string, unknown>) => {
    const offset = Number((v as Vars | undefined)?.offset ?? 0)
    if (!cache.has(offset)) cache.set(offset, { events: { total, items } })
    return cache.get(offset)
  }
}

const lastFilter = () => (apolloFinto.chiamata('GetEvents') as Vars | undefined)?.filter ?? null

/** Stands in for "back" or a pasted link: changes the URL from outside the page. */
function ExternalNav({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate(to)}>external-nav</button>
}

function renderPage(route = '/events', extra?: React.ReactNode) {
  return renderWithProviders(<><EventsPage />{extra}</>, { route })
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetMe'] = { me: meFixture('viewer') }
  apolloFinto.risposte['GetEventStats'] = { eventStats: STATS }
  apolloFinto.risposte['GetMonitoringSourceRefs'] = { monitoringSourceRefs: [{ id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager', enabled: true }] }
  apolloFinto.risposte['GetEvents'] = pagedEvents(3, [ev({ id: 'e1', title: 'CPU high' }), ev({ id: 'e2', title: 'Disk full' }), ev({ id: 'e3', title: 'Old alert', status: 'resolved' })])
})

describe('EventsPage — counters', () => {
  it.each([
    ['Active', 'firing', { status: ['firing'] }],
    ['Critical', 'critical', { status: ['firing'], severity: ['critical'] }],
    ['Warnings', 'warning', { status: ['firing'], severity: ['warning'] }],
    ['Suppressed', 'suppressed', { status: ['suppressed'] }],
    ['Flapping', 'flapping', { status: ['flapping'] }],
    ['No CI', 'orphan', { orphan: true }],
  ])('the %s tile filters on what it counts', async (label, key, filter) => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: new RegExp(`^${label}\\s*\\d`) }))
    await attendiURL('/events', { stat: key })
    await waitFor(() => expect(lastFilter()).toEqual(filter))
  })

  it('an unreadable counter query shows an error with a retry, the list still works', async () => {
    delete apolloFinto.risposte['GetEventStats']
    apolloFinto.erroriQuery['GetEventStats'] = new Error('stats down')
    const { user } = renderPage()
    expect(screen.getByText('stats down')).toBeInTheDocument()
    expect(screen.getByText('CPU high')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('EventsPage — "Resolved 24h" is a sliding window', () => {
  afterEach(() => { vi.useRealTimers() })

  it('the window moves forward on every poll tick and on Refresh', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'))
    renderPage('/events?stat=resolved24h')
    expect(lastFilter()).toEqual({ status: ['resolved'], resolvedSince: '2026-09-21T12:00:00.000Z' })

    // 15 s later the poll tick recomputes "24 hours ago".
    // Advancing the faked timers also advances the faked clock by the same 15 s.
    act(() => { vi.advanceTimersByTime(15_000) })
    // Asserted right after act(): waitFor polls with setInterval, which is faked here.
    expect(lastFilter()).toEqual({ status: ['resolved'], resolvedSince: '2026-09-21T12:00:15.000Z' })

    // Refresh does the same, without waiting for the tick.
    act(() => { vi.setSystemTime(new Date('2026-09-22T12:00:20Z')) })
    act(() => { screen.getByRole('button', { name: 'Refresh' }).click() })
    expect(lastFilter()).toEqual({ status: ['resolved'], resolvedSince: '2026-09-21T12:00:20.000Z' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('clicking the tile recomputes the window from now', async () => {
    const { user } = renderPage()
    const before = Date.now()
    await user.click(screen.getByRole('button', { name: /^Resolved 24h\s*\d/ }))
    await waitFor(() => expect(lastFilter()?.resolvedSince).toBeTruthy())
    const since = Date.parse(String(lastFilter()!.resolvedSince))
    expect(since).toBeGreaterThanOrEqual(before - 24 * 3_600_000)
  })
})

describe('EventsPage — chips', () => {
  it('a severity chip adds and removes its value', async () => {
    const { user } = renderPage()
    const warning = within(screen.getByRole('group', { name: 'Severity' })).getByRole('button', { name: 'Warning' })
    await user.click(warning)
    await attendiURL('/events', { severity: 'warning' })
    await user.click(warning)
    await attendiURL('/events')
  })

  it('the incident and change context chips can be removed', async () => {
    const { user } = renderPage('/events?incidentId=inc1&changeId=chg1')
    expect(lastFilter()).toEqual({ incidentId: 'inc1', suppressedByChangeId: 'chg1' })
    await user.click(screen.getByRole('button', { name: 'This incident only' }))
    await attendiURL('/events', { changeId: 'chg1' })
    await user.click(screen.getByRole('button', { name: 'This change only' }))
    await attendiURL('/events')
    await waitFor(() => expect(lastFilter()).toBeNull())
  })

  it('a filter on a source that no longer exists says so and can be cleared', async () => {
    const { user } = renderPage('/events?sourceId=gone')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    const chip = screen.getByRole('button', { name: 'Source not found' })
    await user.click(chip)
    await attendiURL('/events')
    expect(screen.queryByRole('button', { name: 'Source not found' })).not.toBeInTheDocument()
  })
})

describe('EventsPage — pages and rows', () => {
  it('moves between pages, and page 1 is not written in the address', async () => {
    apolloFinto.risposte['GetEvents'] = pagedEvents(120, [ev({ id: 'e1', title: 'CPU high' })])
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: /Next/ }))
    await attendiURL('/events', { page: '2' })
    await waitFor(() => expect((apolloFinto.chiamata('GetEvents') as Vars).offset).toBe(50))
    await user.click(screen.getByRole('button', { name: /Prev/ }))
    await attendiURL('/events')
  })

  it('a page beyond the last one is brought back to the last page', async () => {
    apolloFinto.risposte['GetEvents'] = pagedEvents(60, [ev({ id: 'e1', title: 'CPU high' })])
    renderPage('/events?page=5')
    // 60 alarms = 2 pages: page 5 would be an empty table.
    await attendiURL('/events', { page: '2' })
  })

  it('an empty result after the filter goes back to the first page', async () => {
    apolloFinto.risposte['GetEvents'] = pagedEvents(0, [])
    renderPage('/events?page=3')
    await attendiURL('/events')
  })

  it('clicking a row opens the alarm, and the CI link does not also open the row', async () => {
    const { user } = renderPage('/events?severity=critical')
    await user.click(screen.getByText('Disk full').closest('tr')!.querySelector('td')!)
    await attendiURL('/events/e2')
  })

  it('the CI link goes to the CI, not to the alarm', async () => {
    const { user } = renderPage()
    const row = screen.getByText('CPU high').closest('tr')!
    await user.click(within(row).getByRole('link', { name: 'web-01' }))
    await attendiURL('/ci/server/ci1')
  })

  it('a failing alarm query shows an error with a retry, not "no alarms"', async () => {
    delete apolloFinto.risposte['GetEvents']
    apolloFinto.erroriQuery['GetEvents'] = new Error('events down')
    const { user } = renderPage()
    expect(screen.getByText('events down')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('EventsPage — advanced filter in the address', () => {
  const group = (value: string) => encodeFilterGroup({ rules: [{ id: 'r1', field: 'title', operator: 'contains', value, logic: 'AND' }] })

  it('a new ?f= from outside re-seeds the open panel with the new rules', async () => {
    apolloFinto.risposte['EntityFilterFields'] = { entityFilterFields: [{ name: 'title', kind: 'SCALAR', scalarName: 'String', enumValues: null, label: null, choices: [], formFieldType: null, vocabulary: null, multi: false, rowFilter: false, settableByAutomation: false }] }
    const { user } = renderPage(`/events?${FILTER_GROUP_PARAM}=${group('Disk')}`, <ExternalNav to={`/events?${FILTER_GROUP_PARAM}=${group('CPU')}`} />)
    expect(screen.getByDisplayValue('Disk')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'external-nav' }))
    // The panel shows the rules of the link, not the ones it had before.
    await waitFor(() => expect(screen.getByDisplayValue('CPU')).toBeInTheDocument())
    expect(screen.queryByDisplayValue('Disk')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 3 on this page matches the advanced filter')).toBeInTheDocument()

    // Reset clears the group from the address and shows the global count again.
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await attendiURL('/events')
    expect(screen.getByText('3 alarms')).toBeInTheDocument()
  })
})
