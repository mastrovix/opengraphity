/**
 * THE CHANGE CALENDAR.
 *
 * It answers "what goes to production this week, and where do two changes
 * collide": every planned window as a bar across the days it covers, by week
 * or by month. The arithmetic (ranges, days, overlaps) lives in
 * `changeCalendarModel` with its own tests; these tests pin what the page
 * does with it:
 *  - it asks the server for exactly the period on screen, and moves by week or
 *    month; today is marked;
 *  - each bar carries the time, the change code and the CI, and its tooltip
 *    the type, step, task, dates and the collision;
 *  - the summary counts ALL the windows of the period, so a view filter can
 *    never hide a clash; the type and state filters change only what is drawn
 *    (the state by the CATEGORY of the step, so a renamed step still counts);
 *  - plans with unusable dates are announced, an empty period says so;
 *  - a click on a bar opens a preview (why, what, CIs, the plan in date order,
 *    plans without dates) without leaving the calendar, and from there the
 *    change itself.
 * "Today" is fixed at Wednesday 23 September 2026, 10:00 (Europe/Rome).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'
import type { VoceCalendario } from './changeCalendarModel'

const loading = vi.hoisted(() => new Set<string>())

vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const fake = moduloApollo()
  return {
    ...fake,
    // The first read of a query can be made to be still in flight.
    useQuery: (doc: Parameters<typeof nomeOperazione>[0], opts?: Parameters<typeof fake.useQuery>[1]) => {
      const r = fake.useQuery(doc, opts)
      return loading.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
  }
})

const { ChangeCalendarPage } = await import('./ChangeCalendarPage')

/** A local instant in September 2026 (the tests run in Europe/Rome). */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString()

const entry = (n: number, over: Partial<VoceCalendario>): VoceCalendario => ({
  changeId: `chg-${n}`, code: `CHG0000000${n}`, title: `Change ${n}`, changeType: 'normal', priority: 'high',
  currentStep: 'scheduled', kind: 'release', start: at(22, 22), end: at(22, 23), stepTitle: 'Deploy',
  taskCode: `TASK0000000${n}`, ciId: `ci-${n}`, ciName: `ci-${n}`, ...over,
})

// Two releases on the same CI (a clash), two on different CIs (an overlap),
// a validation, and a release of a change already closed.
const ENTRIES: VoceCalendario[] = [
  entry(1, { title: 'Upgrade DB', start: at(22, 22), end: at(23, 1), stepTitle: 'Deploy 16', ciId: 'ci-db', ciName: 'db-prod' }),
  entry(2, { title: 'Patch DB', start: at(22, 23), end: at(23, 0, 30), stepTitle: 'Patch', taskCode: null, ciId: 'ci-db', ciName: 'db-prod' }),
  entry(3, { title: 'Web release', start: at(24, 21), end: at(24, 22), ciName: 'web-01' }),
  entry(4, { title: 'Queue upgrade', start: at(24, 21, 30), end: at(24, 23), ciName: 'mq-01' }),
  entry(5, { title: 'Cache test', kind: 'validation', start: at(25, 10), end: at(25, 12), stepTitle: 'Smoke test', ciName: 'cache-01' }),
  entry(6, { title: 'Old rotation', start: at(26, 20), end: at(26, 21), ciName: 'cert-01', currentStep: 'closed' }),
]

let entries: VoceCalendario[] = ENTRIES

const step = (name: string, category: string, order: number) => ({
  id: `s-${name}`, name, label: name, labels: [], type: 'standard', isInitial: order === 1, isTerminal: category === 'closed',
  isOpen: category !== 'closed', category, purpose: null, order,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 23, 10, 0))
  apolloFinto.reset()
  loading.clear()
  entries = ENTRIES
  // Like the server: only the windows that touch the period asked for.
  apolloFinto.risposte['GetChangeCalendar'] = (v?: Record<string, unknown>) => ({ changeCalendar: {
    entries: entries.filter((e) => e.end > String(v?.['from']) && e.start < String(v?.['to'])),
    unreadablePlans: 1,
  } })
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [
    step('scheduled', 'active', 1), step('closed', 'closed', 2),
  ] } }
})

afterEach(() => { vi.useRealTimers() })

const mount = () => renderWithProviders(withVocabularyLabels(<ChangeCalendarPage />), { route: '/changes/calendar', path: '/changes/calendar' })

/** The codes of the bars drawn, in the order they are drawn. */
const bars = () => screen.queryAllByTitle(/^CHG\d+ · /).map((b) => b.getAttribute('title')!.slice(0, 11))
const bar = (code: string) => screen.getByTitle(new RegExp(`^${code} · `))
const segment = (name: string) => screen.getByRole('button', { name })

describe('ChangeCalendarPage — the period on screen', () => {
  it('opens on this week, asks the server for exactly that week, and marks today', () => {
    mount()
    expect(apolloFinto.chiamata('GetChangeCalendar')).toEqual({ from: at(21, 0), to: at(28, 0) })
    expect(screen.getByText('21 Sept 2026 – 27 Sept 2026')).toBeInTheDocument()
    expect(segment('Week')).toHaveAttribute('aria-pressed', 'true')
    for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) expect(screen.getByText(name)).toBeInTheDocument()
    expect(screen.getByText('23').style.background).toBe('var(--color-brand)')
    expect(screen.getByText('22').style.background).toBe('var(--color-surface-2)')
  })

  it('moves a week at a time, and "Today" comes back', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Next period' }))
    expect(screen.getByText('28 Sept 2026 – 04 Oct 2026')).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetChangeCalendar')).toEqual({ from: at(28, 0), to: new Date(2026, 9, 5).toISOString() })
    await user.click(screen.getByRole('button', { name: 'Today' }))
    expect(screen.getByText('21 Sept 2026 – 27 Sept 2026')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Previous period' }))
    expect(screen.getByText('14 Sept 2026 – 20 Sept 2026')).toBeInTheDocument()
  })

  it('the month runs from the Monday before the 1st to the Sunday after the 30th, and dims the days of other months', async () => {
    const { user } = mount()
    await user.click(segment('Month'))
    expect(screen.getByText('September 2026')).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetChangeCalendar')).toEqual({ from: new Date(2026, 7, 31).toISOString(), to: new Date(2026, 9, 5).toISOString() })
    // 31 August and 1–4 October are drawn, dimmed; the days of September are not.
    expect(screen.getByText('31').style.background).toBe('var(--color-surface-1)')
    expect(screen.getAllByText('4').map((d) => d.style.background)).toContain('var(--color-surface-1)')
    expect(screen.getByText('15').style.background).toBe('var(--color-surface-2)')
    // The whole month is one request, so the releases of this week are there too.
    expect(bars()).toEqual(expect.arrayContaining(['CHG00000001', 'CHG00000006']))
    await user.click(screen.getByRole('button', { name: 'Next period' }))
    expect(screen.getByText('October 2026')).toBeInTheDocument()
  })

  it('"Go to the list" leads to the list of changes', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Go to the list' }))
    await attendiURL('/changes')
  })
})

describe('ChangeCalendarPage — the bars', () => {
  it('releases only by default: one bar per window, with code, time and CI', () => {
    mount()
    expect(bars().sort()).toEqual(['CHG00000001', 'CHG00000002', 'CHG00000003', 'CHG00000004', 'CHG00000006'])
    // Across two days the bar shows start and end; on one day, only the start.
    expect(bar('CHG00000001')).toHaveTextContent('CHG0000000122:00 → 01:00db-prod')
    expect(bar('CHG00000006')).toHaveTextContent(/^CHG0000000620:00cert-01$/)
  })

  it('the tooltip says what the bar is: change, type and step, CI and task, dates, and whom it collides with', () => {
    mount()
    expect(bar('CHG00000001')).toHaveAttribute('title',
      'CHG00000001 · Upgrade DB\nDeploy · Deploy 16\ndb-prod · TASK00000001\n22 Sept 2026, 22:00 → 23 Sept 2026, 01:00\nSame CI as: CHG00000002')
    // Without a task code, no dangling separator.
    expect(bar('CHG00000002').getAttribute('title')).toContain('\ndb-prod\n')
    expect(bar('CHG00000003').getAttribute('title')).toMatch(/\nOverlaps with: CHG00000004$/)
    expect(bar('CHG00000006').getAttribute('title')).not.toMatch(/Same CI|Overlaps/)
  })

  it('a clash is always drawn; an overlap on other CIs only when asked for (tour of 24 Sep 2026, G26)', async () => {
    const { user } = mount()
    expect(bar('CHG00000001')).toHaveStyle({ background: 'var(--color-danger-tint)' })
    // By default an overlap on another CI is a quiet release: 198 yellow windows out of 237 hid the clashes.
    expect(bar('CHG00000003')).toHaveStyle({ background: 'var(--color-purple-tint)' })
    expect(bar('CHG00000006')).toHaveStyle({ background: 'var(--color-purple-tint)' })
    expect(screen.queryByText('Overlapping deploys, different CIs')).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: '2 overlapping deploys' }))
    expect(bar('CHG00000003')).toHaveStyle({ background: 'var(--color-warning-tint)' })
    expect(bar('CHG00000006')).toHaveStyle({ background: 'var(--color-purple-tint)' })
    expect(screen.getByText('Overlapping deploys, different CIs')).toBeInTheDocument()
  })

  it('a window that starts before the week, or ends after it, is drawn open on that side', () => {
    entries = [
      entry(7, { start: at(20, 22), end: at(21, 2), ciName: 'early-01' }),
      entry(8, { start: at(27, 23), end: at(28, 1), ciName: 'late-01' }),
    ]
    mount()
    expect(bar('CHG00000007')).toHaveTextContent(/^←CHG00000007/)
    expect(bar('CHG00000008')).toHaveTextContent(/→$/)
  })
})

describe('ChangeCalendarPage — summary and filters', () => {
  it('the summary counts changes, release windows, clashes, overlaps and plans left outside', () => {
    mount()
    expect(screen.getByText('6 changes · 5 deploy windows')).toBeInTheDocument()
    expect(screen.getByText('2 windows on the same CI')).toBeInTheDocument()
    expect(screen.getByText('2 overlapping deploys')).toBeInTheDocument()
    expect(screen.getByText('1 plan with unusable dates, outside the calendar')).toBeInTheDocument()
  })

  // Tour of 23 Sep 2026: the summary was one key with both counts, and read
  // «1 changes · 1 deploy windows». Each count now has its own plural.
  it('one change with one release window is counted in the singular', () => {
    entries = [entry(6, { start: at(26, 20), end: at(26, 21) })]
    mount()
    expect(screen.getByText('1 change · 1 deploy window')).toBeInTheDocument()
  })

  it('a quiet week has no clash, overlap or unreadable line', () => {
    entries = [entry(3, { start: at(24, 21), end: at(24, 22) }), entry(6, { start: at(26, 20), end: at(26, 21) })]
    apolloFinto.risposte['GetChangeCalendar'] = { changeCalendar: { entries, unreadablePlans: 0 } }
    mount()
    expect(screen.getByText('2 changes · 2 deploy windows')).toBeInTheDocument()
    expect(screen.queryByText(/on the same CI|overlapping|unusable dates/)).not.toBeInTheDocument()
  })

  it('the type filter changes what is drawn, never the summary', async () => {
    const { user } = mount()
    expect(segment('Deploy')).toHaveAttribute('aria-pressed', 'true')
    await user.click(segment('Validation'))
    expect(bars()).toEqual(['CHG00000005'])
    // The validation bar: its own tint, and the tooltip says it is a validation.
    expect(bar('CHG00000005')).toHaveStyle({ background: 'var(--color-info-tint)' })
    expect(bar('CHG00000005').getAttribute('title')).toContain('Validation · Smoke test')
    // A filter of the VIEW: the clashes are still announced.
    expect(screen.getByText('2 windows on the same CI')).toBeInTheDocument()
    await user.click(segment('Both'))
    expect(bars()).toHaveLength(6)
  })

  it('the state filter goes by the category of the step: "Finished" is a closed change, "In progress" the rest', async () => {
    const { user } = mount()
    await user.click(segment('Finished'))
    expect(bars()).toEqual(['CHG00000006'])
    await user.click(segment('In progress'))
    expect(bars().sort()).toEqual(['CHG00000001', 'CHG00000002', 'CHG00000003', 'CHG00000004'])
    await user.click(segment('All'))
    expect(bars()).toHaveLength(5)
  })

  it('a period with no window, or none left by the filters, says so instead of a silent grid', async () => {
    const { user } = mount()
    expect(screen.queryByText('No window planned in this period.')).not.toBeInTheDocument()
    await user.click(segment('Validation'))
    await user.click(segment('Finished'))
    expect(screen.getByText('No window planned in this period.')).toBeInTheDocument()
  })

  it('a calendar that cannot be read shows the error', () => {
    apolloFinto.erroriQuery['GetChangeCalendar'] = new Error('calendar unavailable')
    mount()
    expect(screen.getByText('calendar unavailable')).toBeInTheDocument()
  })
})

describe('ChangeCalendarPage — the preview of a change', () => {
  const PREVIEW = {
    change: { id: 'chg-1', code: 'CHG00000001', title: 'Upgrade DB', why: 'End of support of version 14', what: '  ', changeType: 'normal', priority: 'high' },
    changeAffectedCIs: [
      { ci: { id: 'ci-db', name: 'db-prod', type: 'database', environment: 'production', supportGroup: { id: 'g', name: 'DBA' } },
        deployPlan: { code: 'TASK00000001', status: 'completed', assignedTeam: null, steps: [
          { title: 'Deploy 16', validationWindow: { start: at(22, 20), end: at(22, 21) }, releaseWindow: { start: at(22, 22), end: at(22, 23, 30) } },
        ] } },
      { ci: { id: 'ci-cache', name: 'cache-01', type: 'server', environment: null, supportGroup: null },
        deployPlan: { code: 'TASK00000019', status: 'pending', assignedTeam: null, steps: [] } },
      { ci: { id: 'ci-mq', name: 'mq-01', type: 'server', environment: 'staging', supportGroup: null }, deployPlan: null },
    ],
  }

  it('opens on a click, without leaving the calendar, and reads why, what, CIs and the plan', async () => {
    apolloFinto.risposte['GetChangePreview'] = PREVIEW
    const { user } = mount()
    await user.click(bar('CHG00000001'))
    expect(apolloFinto.chiamata('GetChangePreview')).toEqual({ id: 'chg-1' })
    const dialog = screen.getByRole('dialog', { name: 'CHG00000001 · Upgrade DB' })
    expect(within(dialog).getByText('Why').nextElementSibling).toHaveTextContent('End of support of version 14')
    // A blank "what" is not given, not an empty line.
    expect(within(dialog).getByText('What').nextElementSibling).toHaveTextContent('not given')
    expect(within(dialog).getByText('Affected CIs (3)')).toBeInTheDocument()
    // Each environment with its Dictionary label, not the internal value.
    expect(within(dialog).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['db-prod · Production', 'cache-01', 'mq-01 · Staging'])
    expect(within(dialog).getAllByRole('row').map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['22 Sept 2026, 20:00 → 21:00', 'Validation', 'Deploy 16', 'db-prod'],
      ['22 Sept 2026, 22:00 → 23:30', 'Deploy', 'Deploy 16', 'db-prod'],
    ])
    // The plans that cannot be put in order are named: by task, or by CI when there is no task yet.
    expect(within(dialog).getByText('2 plans with no dates: TASK00000019, mq-01')).toBeInTheDocument()
    await attendiURL('/changes/calendar')
  })

  it('"Open the change" leads to the change', async () => {
    apolloFinto.risposte['GetChangePreview'] = PREVIEW
    const { user } = mount()
    await user.click(bar('CHG00000001'))
    await user.click(screen.getByRole('button', { name: 'Open the change' }))
    await attendiURL('/changes/chg-1')
  })

  it('closes with its button, and with Escape', async () => {
    apolloFinto.risposte['GetChangePreview'] = PREVIEW
    const { user } = mount()
    await user.click(bar('CHG00000001'))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(bar('CHG00000003'))
    expect(apolloFinto.chiamata('GetChangePreview')).toEqual({ id: 'chg-3' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a change without CIs or plan says so', async () => {
    apolloFinto.risposte['GetChangePreview'] = { change: { ...PREVIEW.change, what: 'Move to 16' }, changeAffectedCIs: [] }
    const { user } = mount()
    await user.click(bar('CHG00000001'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('What').nextElementSibling).toHaveTextContent('Move to 16')
    expect(within(dialog).getByText('Affected CIs (0)')).toBeInTheDocument()
    expect(within(dialog).getByText('No CI affected.')).toBeInTheDocument()
    expect(within(dialog).getByText('No window planned.')).toBeInTheDocument()
    expect(within(dialog).queryByText(/with no dates/)).not.toBeInTheDocument()
  })

  it('while the preview loads it says so, under a generic title', async () => {
    loading.add('GetChangePreview')
    const { user } = mount()
    await user.click(bar('CHG00000001'))
    expect(within(screen.getByRole('dialog', { name: 'Change preview' })).getByText('Loading...')).toBeInTheDocument()
  })

  it('while the calendar loads it does not claim the period is empty', () => {
    loading.add('GetChangeCalendar')
    mount()
    expect(screen.queryByText('No window planned in this period.')).not.toBeInTheDocument()
    expect(apolloFinto.chiamata('GetChangeCalendar')).toEqual({ from: at(21, 0), to: at(28, 0) })
  })

  it('a change that no longer exists opens a preview with nothing to show; a failed read shows the error', async () => {
    apolloFinto.risposte['GetChangePreview'] = { change: null, changeAffectedCIs: [] }
    const { user } = mount()
    await user.click(bar('CHG00000001'))
    const dialog = screen.getByRole('dialog', { name: 'Change preview' })
    expect(within(dialog).queryByRole('button', { name: 'Open the change' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    apolloFinto.erroriQuery['GetChangePreview'] = new Error('preview unavailable')
    await user.click(bar('CHG00000001'))
    expect(within(screen.getByRole('dialog')).getByText('preview unavailable')).toBeInTheDocument()
  })
})

describe('ChangeCalendarPage — defects found while writing these tests', () => {
  // Found by this test (tour of 23 Sep 2026), fixed: a window that clashed on
  // its CI and also overlapped a change on another CI listed both under "Same
  // CI as:" — the model kept one level per window, not one per change met.
  it('a window that clashes with one change and overlaps another names only the first as "same CI"', () => {
    entries = [
      entry(1, { start: at(22, 22), end: at(23, 1), ciId: 'ci-db', ciName: 'db-prod' }),
      entry(2, { start: at(22, 23), end: at(23, 0, 30), ciId: 'ci-db', ciName: 'db-prod' }),
      entry(3, { start: at(22, 23, 30), end: at(23, 0, 15), ciId: 'ci-web', ciName: 'web-01' }),
    ]
    mount()
    expect(bar('CHG00000001').getAttribute('title')).toMatch(/Same CI as: CHG00000002$/)
    // The other change is still named, as what it is.
    expect(bar('CHG00000001').getAttribute('title')).toContain('\nOverlaps with: CHG00000003\n')
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the plan in the preview
  // wrote a window that crosses midnight as "22 Sept 2026, 22:00 → 01:00", a
  // window running backwards; it now shares `readableWindow` with the
  // consolidated plan of the change page, which avoided that form.
  it('in the preview, a window across midnight is written with both dates', async () => {
    apolloFinto.risposte['GetChangePreview'] = {
      change: { id: 'chg-1', code: 'CHG00000001', title: 'Upgrade DB', why: null, what: null, changeType: 'normal', priority: 'high' },
      changeAffectedCIs: [{ ci: { id: 'ci-db', name: 'db-prod', type: 'database', environment: null, supportGroup: null },
        deployPlan: { code: 'TASK1', status: 'pending', assignedTeam: null, steps: [
          { title: 'Deploy', validationWindow: { start: '', end: '' }, releaseWindow: { start: at(22, 22), end: at(23, 1) } },
        ] } }],
    }
    const { user } = mount()
    await user.click(bar('CHG00000001'))
    expect(within(screen.getByRole('dialog')).getByText('22 Sept 2026, 22:00 → 23 Sept 2026, 01:00')).toBeInTheDocument()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the affected CIs of the
  // preview showed the raw environment value ("production") instead of the
  // Dictionary label; they now read it through `useCILabels`, as the other CI
  // lists do since U-9/U-11.
  it('in the preview, the environment of a CI reads with the Dictionary label', async () => {
    apolloFinto.risposte['GetChangePreview'] = {
      change: { id: 'chg-1', code: 'CHG00000001', title: 'Upgrade DB', why: null, what: null, changeType: 'normal', priority: 'high' },
      changeAffectedCIs: [{ ci: { id: 'ci-db', name: 'db-prod', type: 'database', environment: 'production', supportGroup: null }, deployPlan: null }],
    }
    const { user } = mount()
    await user.click(bar('CHG00000001'))
    expect(within(screen.getByRole('dialog')).getByRole('listitem')).toHaveTextContent('db-prod · Production')
  })
})
