/**
 * The audit trail of a change: what happened, in the viewer's language, and
 * a way to find one entry among hundreds.
 *
 * What a regression costs the reader:
 * - an entry of the stable action `change_step_entered` (or the legacy
 *   `change_transition_<step>`) must read as "moved to <step label>" — the
 *   internal step name, or nothing, would hide WHERE the change went;
 * - an action the web does not know must stay readable, not disappear;
 * - a malformed `detailParams` (older rows) must not break the whole card;
 * - the category filter and the "show all" cap decide whether an entry can be
 *   found at all: a wrong category or a lost 21st entry is an entry nobody sees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { ChangeAuditEntryData } from '@/types/change'
import { AuditTimeline } from './AuditTimeline'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const entry = (action: string, over: Partial<ChangeAuditEntryData> = {}): ChangeAuditEntryData =>
  ({ timestamp: '2026-09-14T10:00:00Z', action, detail: null, detailKey: null, detailParams: null, actor: null, ...over })

const step = (name: string, label: string, order: number) =>
  ({ id: name, name, label, labels: [], type: 'normal', isInitial: false, isTerminal: false, isOpen: true, category: null, purpose: null, order })

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [step('review', 'Peer review', 1)], transitions: [] } }
  apolloFinto.risposte['GetWorkflowStepLabels'] = { workflowStepLabels: [] }
})

async function open(audit: ChangeAuditEntryData[]) {
  const r = renderWithProviders(<AuditTimeline audit={audit} />)
  // The card starts collapsed: the trail is long and secondary to the change itself.
  await r.user.click(screen.getByRole('button', { name: /Audit trail/ }))
  return r
}

describe('AuditTimeline — reading an entry', () => {
  it('step entries read as "moved to <step label>", with or without the step, stable or legacy action', async () => {
    await open([
      entry('change_step_entered', { detailParams: '{"step":"review"}' }),
      entry('change_step_entered', { detailParams: '{"step":""}' }),
      entry('change_transition_review'),
      entry('change_step_entered', { detailParams: 'not json' }),
    ])
    expect(screen.getAllByText('moved to Peer review')).toHaveLength(2)
    // No step in the details (empty, or unreadable): a neutral phrase, not "moved to ".
    expect(screen.getAllByText('step change')).toHaveLength(2)
  })

  it('an unknown action stays readable instead of disappearing; the actor is shown when present', async () => {
    await open([entry('custom_sync_ran', { actor: { id: 'u1', name: 'Ada Lovelace' } as ChangeAuditEntryData['actor'] })])
    expect(screen.getByText('custom sync ran')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
  })

  it('the assessment role is read in the viewer language, and a numeric count picks the right plural', async () => {
    await open([
      entry('assessment_user_assigned', { detail: 'x', detailKey: 'userAssigned', detailParams: JSON.stringify({ role: 'owner', ci: 'db-01', user: 'Bob' }) }),
      entry('deploy_plan_saved', { detail: 'x', detailKey: 'planSaved', detailParams: JSON.stringify({ ci: 'db-01', count: '1', steps: 'stop' }) }),
    ])
    expect(screen.getByText('Functional · db-01: assigned to Bob')).toBeInTheDocument()
    // "1" arrives as a string: without the conversion the plural rule would pick "steps".
    expect(screen.getByText('db-01: 1 step — stop')).toBeInTheDocument()
  })

  it('unreadable detail params do not break the entry: the key is still resolved', async () => {
    await open([entry('ci_added', { detail: 'CI db-01 added', detailKey: 'ciAdded', detailParams: '{broken' })])
    expect(screen.getByText('CI added')).toBeInTheDocument()
    expect(screen.getByText(/added/, { selector: 'div' })).toBeInTheDocument()
  })

  it('a long detail is clamped behind "Show all" and can be collapsed again', async () => {
    const long = 'x'.repeat(130)
    const { user } = await open([entry('ci_added', { detail: long })])
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    await user.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument()
  })
})

describe('AuditTimeline — finding an entry', () => {
  it('offers only the categories that have entries, with their counts, and filters by category', async () => {
    const { user } = await open([
      entry('change_approved'),
      entry('assessment_response_submitted'),
      entry('assessment_team_assigned'),
      entry('ci_team_assigned'),
      entry('comment_added'),
      entry('ci_added'),
    ])
    const filter = screen.getByRole('combobox', { name: 'Show entries' })
    expect(within(filter).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['All (6)', 'Status (1)', 'Assessment (2)', 'Assignments (1)', 'Comments (1)', 'System (1)'])

    await user.selectOptions(filter, 'assignments')
    expect(screen.getByText('ci team assigned')).toBeInTheDocument()
    expect(screen.queryByText('approved')).toBeNull()

    await user.selectOptions(filter, 'comments')
    expect(screen.getByText('comment added')).toBeInTheDocument()
  })

  it('shows 20 entries and a "Show all (n)" button that reveals the rest', async () => {
    const audit = Array.from({ length: 23 }, (_, i) => entry(`event_${i}`))
    const { user } = await open(audit)
    expect(screen.queryByText('event 22')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show all (23)' }))
    expect(screen.getByText('event 22')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show all (23)' })).toBeNull()
  })

  it('an empty trail says so', async () => {
    await open([])
    expect(screen.getByText('No event')).toBeInTheDocument()
  })
})
