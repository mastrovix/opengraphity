/**
 * THE CONSOLIDATED PLAN ON A CHANGE.
 *
 * Before approving, a Change Manager needs to see in one place what happens
 * that night and in which order: every validation and release window of every
 * CI, in date order, with its task code (the address to chase) and its CI.
 * The arithmetic lives in `releasePlanSummary` and has its own tests; these
 * tests pin what the card SHOWS from it:
 *  - no card while there is nothing to summarise (an empty card reads as a
 *    plan that does not exist);
 *  - the list in date order, a window that crosses midnight with both dates;
 *  - the envelope of the releases, and a warning when they are in separate
 *    blocks (on its own "from the 21st to the 23rd" reads as a long outage);
 *  - the type filter applies to BOTH views and shows its counts before the
 *    click; filtered down to nothing, it says it is a choice;
 *  - the Gantt draws one bar per window with the true dates in the tooltip,
 *    and says when a bar was widened to be visible;
 *  - plans that cannot be put in the timeline are named with their task.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AffectedCI, DeployStep } from '@/types/change'
import { ReleasePlanCard } from './ReleasePlanCard'

const w = (start: string, end: string) => ({ start, end })
const step = (title: string, val: [string, string], rel: [string, string]): DeployStep =>
  ({ title, validationWindow: w(...val), releaseWindow: w(...rel) })

const task = (id: string, status: string) =>
  ({ id, code: id.toUpperCase(), responderRole: 'owner', status, score: 3, completedBy: null, completedAt: null, assignedTeam: null, assignee: null, responses: [] })

/** A CI of the change with its plan; `plan: null` = the plan task does not exist yet. */
const ci = (
  name: string,
  plan: { code: string; status: string; steps: DeployStep[]; team?: string } | null,
  over: { assessments?: [string, string]; supportGroup?: string } = {},
): AffectedCI => {
  const [owner, support] = over.assessments ?? ['completed', 'completed']
  return {
    ciPhase: 'assessment', riskScore: 3,
    ci: { id: `ci-${name}`, name, type: 'server', environment: 'production', ownerGroup: null,
      supportGroup: over.supportGroup ? { id: 'g', name: over.supportGroup } : null },
    assessmentOwner: task(`a1-${name}`, owner),
    assessmentSupport: task(`a2-${name}`, support),
    deployPlan: plan && {
      id: `dp-${name}`, code: plan.code, status: plan.status, steps: plan.steps,
      completedBy: null, completedAt: null, assignedTeam: plan.team ? { id: 't', name: plan.team } : null, assignee: null,
    },
    validation: null, deployment: null, review: null,
  } as unknown as AffectedCI
}

// Times are UTC; the tests run in Europe/Rome (UTC+2 in September).
const DB = ci('db-prod-01', { code: 'TASK00000051', status: 'completed', steps: [
  // A 15-minute validation on a plan of a day and a half: too short to be drawn to scale.
  step('Backup', ['2026-09-21T18:00:00Z', '2026-09-21T18:15:00Z'], ['2026-09-21T20:00:00Z', '2026-09-21T21:30:00Z']),
] })
const APP = ci('srv-app-01', { code: 'TASK00000052', status: 'in-progress', steps: [
  // The release crosses midnight (local time): 22 Sept 23:00 → 23 Sept 01:30.
  step('Deploy 4.2', ['2026-09-22T19:00:00Z', '2026-09-22T20:00:00Z'], ['2026-09-22T21:00:00Z', '2026-09-22T23:30:00Z']),
] })

const mount = (affected: AffectedCI[]) => {
  const user = userEvent.setup()
  const r = render(<ReleasePlanCard affected={affected} />)
  return { ...r, user }
}

/** The cells of each body row of the plan table. */
const tableRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1)
  .map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))

const filter = (name: RegExp) => within(screen.getByRole('group', { name: 'Which windows to show' })).getByRole('button', { name })

describe('ReleasePlanCard — when there is something to show', () => {
  it('no window and no task closed yet: no card at all', () => {
    mount([ci('db-prod-01', null, { assessments: ['pending', 'pending'] })])
    expect(screen.queryByText('Consolidated plan')).not.toBeInTheDocument()
  })

  it('no window yet but some task closed: the card shows the progress and says there is no window yet', () => {
    mount([ci('db-prod-01', null, { assessments: ['completed', 'pending'] })])
    expect(screen.getByRole('button', { name: /Consolidated plan/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Deploy, end to end').nextElementSibling).toHaveTextContent('no window yet')
    expect(screen.getByText('Tasks closed').nextElementSibling).toHaveTextContent('1 of 3')
    // Nothing to look at yet: no views, no filter.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('ReleasePlanCard — the timeline', () => {
  it('lists every window of every CI in date order, with type, step, task and CI', () => {
    mount([APP, DB])
    expect(tableRows()).toEqual([
      ['21 Sept 2026, 20:00 → 20:15', 'Validation', 'Backup', 'TASK00000051', 'db-prod-01'],
      ['21 Sept 2026, 22:00 → 23:30', 'Deploy', 'Backup', 'TASK00000051', 'db-prod-01'],
      ['22 Sept 2026, 21:00 → 22:00', 'Validation', 'Deploy 4.2', 'TASK00000052', 'srv-app-01'],
      // Across midnight both dates are written: "23:00 → 01:30" alone would read backwards.
      ['22 Sept 2026, 23:00 → 23 Sept 2026, 01:30', 'Deploy', 'Deploy 4.2', 'TASK00000052', 'srv-app-01'],
    ])
  })

  it('sums it up: the releases end to end, how many blocks they are, tasks and plans closed', () => {
    mount([APP, DB])
    const box = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement
    expect(box('Deploy, end to end')).toHaveTextContent('21 Sept 2026, 22:00 → 23 Sept 2026, 01:30')
    expect(box('Deploy, end to end')).toHaveTextContent('2 separate windows, not contiguous')
    expect(box('Tasks closed')).toHaveTextContent('5 of 6')
    // One plan of two still open: the count is drawn as a warning.
    expect(box('Plans completed')).toHaveTextContent('1 of 2')
    expect(box('Plans completed')).toHaveStyle({ color: 'var(--color-danger-text)' })
  })

  it('a single block of release is not announced as separate windows, and all plans closed is not a warning', () => {
    mount([DB])
    const box = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement
    expect(box('Deploy, end to end')).toHaveTextContent('21 Sept 2026, 22:00 → 23:30')
    expect(box('Deploy, end to end')).not.toHaveTextContent(/separate/)
    expect(box('Plans completed')).toHaveTextContent('1 of 1')
    expect(box('Plans completed')).not.toHaveStyle({ color: 'var(--color-danger-text)' })
  })
})

describe('ReleasePlanCard — the type filter', () => {
  it('starts on both kinds and tells the count of each before the click', () => {
    mount([APP, DB])
    expect(filter(/^Both/)).toHaveAttribute('aria-pressed', 'true')
    expect(filter(/^Both/)).toHaveTextContent(/4$/)
    expect(filter(/^Deploy/)).toHaveTextContent(/2$/)
    expect(filter(/^Validation/)).toHaveTextContent(/2$/)
  })

  it('keeps only the kind chosen, in the same order', async () => {
    const { user } = mount([APP, DB])
    await user.click(filter(/^Deploy/))
    expect(filter(/^Deploy/)).toHaveAttribute('aria-pressed', 'true')
    expect(filter(/^Both/)).toHaveAttribute('aria-pressed', 'false')
    expect(tableRows().map((r) => r[1] + ' ' + r[4])).toEqual(['Deploy db-prod-01', 'Deploy srv-app-01'])
    await user.click(filter(/^Validation/))
    expect(tableRows().map((r) => r[1] + ' ' + r[4])).toEqual(['Validation db-prod-01', 'Validation srv-app-01'])
    await user.click(filter(/^Both/))
    expect(tableRows()).toHaveLength(4)
  })

  it('filtered down to nothing it says it is a choice, not a missing plan', async () => {
    // A plan whose only step has no usable validation window.
    const releaseOnly = ci('db-prod-01', { code: 'TASK00000051', status: 'completed', steps: [
      step('Backup', ['', ''], ['2026-09-21T20:00:00Z', '2026-09-21T21:30:00Z']),
    ] })
    const { user } = mount([releaseOnly])
    expect(filter(/^Validation/)).toHaveTextContent(/0$/)
    await user.click(filter(/^Validation/))
    expect(screen.getByText('No window of this kind in the plan.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('ReleasePlanCard — the Gantt', () => {
  it('opens on the list; the Gantt draws one bar per window with its true dates', async () => {
    const { user } = mount([APP, DB])
    expect(screen.getByRole('tab', { name: 'List' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: 'Gantt' }))
    expect(screen.getByRole('tab', { name: 'Gantt' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // One labelled row per window, in the order of the list.
    expect(screen.getAllByTitle(/ · (Backup|Deploy 4\.2)$/).map((e) => e.textContent)).toEqual(['db-prod-01', 'db-prod-01', 'srv-app-01', 'srv-app-01'])
    expect(screen.getByTitle('21 Sept 2026, 22:00 → 23:30')).toBeInTheDocument()
    expect(screen.getByTitle('22 Sept 2026, 23:00 → 23 Sept 2026, 01:30')).toBeInTheDocument()
  })

  it('a window too short to be seen is widened, and its tooltip says so', async () => {
    const { user } = mount([APP, DB])
    await user.click(screen.getByRole('tab', { name: 'Gantt' }))
    expect(screen.getByTitle('21 Sept 2026, 20:00 → 20:15 — too short to draw to scale: the bar is widened to be visible.')).toBeInTheDocument()
    expect(screen.queryByTitle('21 Sept 2026, 20:00 → 20:15')).not.toBeInTheDocument()
  })

  it('the axis is dated from its start, midnight by midnight, and the last date stays inside the drawing', async () => {
    const { user } = mount([APP, DB])
    await user.click(screen.getByRole('tab', { name: 'Gantt' }))
    expect(screen.getByText('21 Sept 2026')).toHaveStyle({ left: '0%', transform: 'none' })
    expect(screen.getByText('22 Sept 2026')).toHaveStyle({ transform: 'none' })
    // The midnight near the right edge is anchored by its end, or it would spill out.
    expect(screen.getByText('23 Sept 2026')).toHaveStyle({ transform: 'translateX(-100%)' })
  })

  it('the filter applies to the Gantt too', async () => {
    const { user } = mount([APP, DB])
    await user.click(screen.getByRole('tab', { name: 'Gantt' }))
    await user.click(filter(/^Validation/))
    expect(screen.getAllByTitle(/ · (Backup|Deploy 4\.2)$/)).toHaveLength(2)
    expect(screen.queryByTitle('21 Sept 2026, 22:00 → 23:30')).not.toBeInTheDocument()
  })

  it('a plan whose windows last no time at all has nothing to draw', async () => {
    const instant = ci('db-prod-01', { code: 'TASK00000051', status: 'completed', steps: [
      step('Switch', ['2026-09-21T20:00:00Z', '2026-09-21T20:00:00Z'], ['2026-09-21T20:00:00Z', '2026-09-21T20:00:00Z']),
    ] })
    const { user } = mount([instant])
    expect(tableRows()).toHaveLength(2)
    await user.click(screen.getByRole('tab', { name: 'Gantt' }))
    expect(screen.queryByText('db-prod-01')).not.toBeInTheDocument()
    expect(screen.queryByTitle(/2026/)).not.toBeInTheDocument()
  })
})

describe('ReleasePlanCard — plans that cannot be put in the timeline', () => {
  it('are named with their task, the team that owes them and why, next to the timeline', () => {
    mount([
      DB,
      ci('mq-01', { code: 'TASK00000053', status: 'pending', steps: [], team: 'Middleware' }),
      ci('cache-01', { code: 'TASK00000054', status: 'in-progress', steps: [step('Flush', ['soon', 'later'], ['', ''])] }),
    ])
    const box = screen.getByText('2 plans with no date').parentElement as HTMLElement
    // Sorted by CI name, whatever the order of the CIs.
    const lines = within(box).getAllByText(/^(cache-01|mq-01)$/).map((n) => n.parentElement!.textContent)
    expect(lines).toEqual([
      'cache-01TASK00000054In progressdates cannot be used',
      'mq-01TASK00000053MiddlewareTO BE COMPLETEDno step filled in',
    ])
    expect(tableRows()).toHaveLength(2)
  })

  it('with nothing else in the plan, the list of missing plans is all there is', () => {
    mount([ci('mq-01', { code: 'TASK00000053', status: 'pending', steps: [] }, { supportGroup: 'Messaging' })])
    expect(screen.getByText('One plan with no date')).toBeInTheDocument()
    // Without an assignment, the support group of the CI is the one that will fill it in.
    expect(screen.getByText('Messaging')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
