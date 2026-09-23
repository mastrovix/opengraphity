/**
 * THE WHOLE CHANGE, NEXT TO ONE OF ITS TASKS.
 *
 * Whoever works a single task (an assessment, a plan, a validation) needs to
 * see where the whole change stands: its phase as the workflow names it, why
 * and what, who asked for it, and — for every CI it touches — how far each of
 * the six phases has come. The six dots are the only place where that is
 * readable at a glance, so their colours must say the truth: a failed
 * validation or a rejected review is «failed», not «completed», and the
 * legend explains the colours for whoever cannot hover (iPad). Once both
 * assessments of the current CI are done, their scores and the CI risk are
 * shown.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import type { AffectedCI, AssessmentTaskData, ChangeData } from '@/types/change'
import { ChangeOverviewSidebar } from './ChangeOverviewSidebar'

const change = (over: Partial<ChangeData> = {}): ChangeData => ({
  id: 'ch-1', code: 'CHG00000012', title: 'Upgrade the mail relay', why: 'End of support', what: 'Relay v3 to v4',
  aggregateRiskScore: 12, approvalRoute: null, approvalStatus: null, approvalAt: null,
  createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-20T08:00:00Z',
  requester: { id: 'u-rita', name: 'Rita Requester' }, changeOwner: { id: 'u-carl', name: 'Carl Owner' }, approvalBy: null,
  workflowInstance: { id: 'wi-9', currentStep: 'assessment', status: 'running' }, availableTransitions: [],
  ...over,
})

const assessment = (role: string, status: string, over: Partial<AssessmentTaskData> = {}): AssessmentTaskData => ({
  id: `at-${role}`, code: `TASK-${role}`, responderRole: role, status, score: null, completedBy: null, completedAt: null,
  assignedTeam: null, assignee: null, responses: [], ...over,
})
const answered = [{ question: { id: 'q1', text: 'Q', category: 'functional' }, selectedOption: { id: 'o1', label: 'A', score: 1 } }]

const ci = (id: string, name: string, over: Partial<AffectedCI> = {}): AffectedCI => ({
  ciPhase: 'assessment', riskScore: null,
  ci: { id, name, type: 'server', environment: 'production', ownerGroup: null, supportGroup: null },
  assessmentOwner: null, assessmentSupport: null, deployPlan: null, validation: null, deployment: null, review: null,
  ...over,
})
const plan = (status: string, steps: number) => ({
  id: 'dp', code: 'TASK-P', status, completedBy: null, completedAt: null, assignedTeam: null, assignee: null,
  steps: Array.from({ length: steps }, () => ({ title: 's', validationWindow: { start: '', end: '' }, releaseWindow: { start: '', end: '' } })),
})
const simple = (status: string, result: string | null = null) => ({
  id: 'x', code: 'TASK-X', status, result, testedAt: null, testedBy: null, deployedAt: null, deployedBy: null, reviewedAt: null, reviewedBy: null,
})

const WEB = ci('ci-web', 'web-01', {
  riskScore: 7,
  assessmentOwner: assessment('owner', 'completed'),
  assessmentSupport: assessment('support', 'in-progress'),
  deployPlan: plan('planning', 2),
  validation: simple('completed', 'fail'),
  deployment: simple('pending'),
})
const DB = ci('ci-db', 'db-01', {
  assessmentOwner: assessment('owner', 'pending', { responses: answered }),
  deployPlan: plan('completed', 1),
  validation: simple('completed', 'pass'),
  deployment: simple('in-progress'),
  review: simple('completed', 'rejected'),
})
const QUEUE = ci('ci-mq', 'queue-01', {
  assessmentOwner: assessment('owner', 'pending'),
  deployPlan: plan('planning', 0),
  review: simple('completed', 'confirmed'),
})

function setup(props: Partial<Parameters<typeof ChangeOverviewSidebar>[0]> = {}) {
  const onRowClick = vi.fn()
  const utils = renderWithProviders(
    <ChangeOverviewSidebar
      change={change()} allAffected={[WEB, DB, QUEUE]} ciAffected={WEB} currentCIId="ci-web" currentCIName="web-01"
      changeId="ch-1" stepLabel="Assessment" stepCategory="active" onRowClick={onRowClick} {...props}
    />,
  )
  return { ...utils, onRowClick }
}

/** What each of the six dots of a CI says, read through the legend's colours. */
function dotsOf(ciName: string): string[] {
  const legend = screen.getByText(/^Dots \(in order\)/).parentElement!
  const meaning = new Map(['not started', 'in progress', 'completed', 'failed'].map((label) => [
    (within(legend).getByText(label).firstElementChild as HTMLElement).style.backgroundColor, label,
  ]))
  const row = screen.getByRole('button', { name: new RegExp(ciName) })
  return ['Functional', 'Technical', 'Plan', 'Validation', 'Deploy', 'Review']
    .map((phase) => meaning.get(within(row).getByTitle(phase).style.backgroundColor) ?? '?')
}

describe('ChangeOverviewSidebar', () => {
  it('before the change is read, only the card is there', () => {
    setup({ change: null })
    expect(screen.getByText('Change overview')).toBeInTheDocument()
    expect(screen.queryByText('CHG00000012')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('says what the change is, in which phase, and who is behind it', () => {
    setup()
    expect(screen.getByText('CHG00000012')).toBeInTheDocument()
    expect(screen.getByText('Assessment')).toBeInTheDocument()
    expect(screen.getByText('Upgrade the mail relay')).toBeInTheDocument()
    expect(screen.getByText('Why: End of support · What: Relay v3 to v4')).toBeInTheDocument()
    expect(screen.getByText('Rita Requester')).toBeInTheDocument()
    expect(screen.getByText('Carl Owner')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See the full change →' })).toHaveAttribute('href', '/changes/ch-1')
  })

  it('without the workflow\'s label the phase shows its name; what is not known is left out', () => {
    setup({ stepLabel: null, change: change({ why: null, what: 'Relay v3 to v4', requester: null, changeOwner: null }) })
    expect(screen.getByText('assessment')).toBeInTheDocument()
    expect(screen.getByText('What: Relay v3 to v4')).toBeInTheDocument()
    expect(screen.queryByText(/Requester/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Change owner/)).not.toBeInTheDocument()
  })

  it('without why and what there is no summary line; without a workflow the phase is blank', () => {
    setup({ stepLabel: null, change: change({ why: null, what: null, workflowInstance: null }) })
    expect(screen.queryByText(/^Why:|^What:/)).not.toBeInTheDocument()
    // The phase badge next to the code has nothing to say, rather than a made-up phase.
    expect(screen.getByText('CHG00000012').nextElementSibling?.textContent).toBe('')
  })

  it('each CI of the change is a row that leads to the change, the current one marked', async () => {
    const { user, onRowClick } = setup()
    const rows = ['web-01', 'db-01', 'queue-01'].map((name) => screen.getByRole('button', { name: new RegExp(name) }))
    expect(rows[0]).toHaveStyle({ background: 'var(--color-brand-light)' })
    expect(rows[1]).not.toHaveStyle({ background: 'var(--color-brand-light)' })
    await user.click(rows[2]!)
    expect(onRowClick).toHaveBeenCalledTimes(1)
    // The risk of a CI, once known, is on its row.
    expect(within(rows[0]!).getByText('7')).toBeInTheDocument()
    expect(within(rows[1]!).queryByTitle(/score/)).not.toBeInTheDocument()
  })

  it('the six dots tell each phase as it is: a failed validation or a rejected review is not "completed"', () => {
    setup()
    expect(dotsOf('web-01')).toEqual(['completed', 'in progress', 'in progress', 'failed', 'not started', 'not started'])
    expect(dotsOf('db-01')).toEqual(['in progress', 'not started', 'completed', 'completed', 'in progress', 'failed'])
    expect(dotsOf('queue-01')).toEqual(['not started', 'not started', 'not started', 'not started', 'not started', 'completed'])
    expect(screen.getByText(/^Dots \(in order\)/)).toHaveTextContent('Dots (in order): 1 Functional · 2 Technical · 3 Plan · 4 Validation · 5 Deploy · 6 Review')
  })

  it('while the assessments of this CI are open, their states are shown', () => {
    setup()
    expect(screen.queryByText(/Assessment answers/)).not.toBeInTheDocument()
    const states = screen.getByText('Completed').parentElement!
    expect(states).toHaveTextContent('Functional: Completed · Technical: In progress')
  })

  it('once both assessments are done, their scores and the CI risk are shown', () => {
    const done = ci('ci-web', 'web-01', {
      riskScore: 12,
      assessmentOwner: assessment('owner', 'completed', { score: 4 }),
      assessmentSupport: assessment('support', 'completed', { score: null }),
    })
    setup({ ciAffected: done, allAffected: [done] })
    expect(screen.getByText('Assessment answers · web-01')).toBeInTheDocument()
    expect(screen.getByText('Functional · Score: 4')).toBeInTheDocument()
    expect(screen.getByText('Technical · Score: —')).toBeInTheDocument()
    expect(screen.getByText(/CI risk/)).toHaveTextContent('CI risk: 12')
  })

  it('a role the product does not know is named as it is, and an unknown risk is left blank', () => {
    const done = ci('ci-web', 'web-01', {
      assessmentOwner: assessment('security', 'completed', { score: 2 }),
      assessmentSupport: assessment('support', 'completed', { score: 3 }),
    })
    setup({ ciAffected: done, allAffected: [done] })
    expect(screen.getByText('security · Score: 2')).toBeInTheDocument()
    expect(screen.getByText(/CI risk/)).toHaveTextContent(/^CI risk:$/)
  })

  it('a task whose CI is not in the change shows no assessment block', () => {
    setup({ ciAffected: null })
    expect(screen.queryByText(/Assessment answers/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Functional:/)).not.toBeInTheDocument()
  })
})
