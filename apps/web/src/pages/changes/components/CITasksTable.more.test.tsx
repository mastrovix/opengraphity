/**
 * The "Active tasks" table on a change: one row per affected CI, expandable
 * into its task list.
 *
 * Why these behaviours matter:
 * - the count and the COMPLETED / NOT YET COMPLETED status tell the change
 *   manager whether the change can move on: a CI whose validation FAILED or
 *   whose review was REJECTED is not done, even though its tasks are closed;
 * - the "Open: <task>" shortcut must point at the next task the viewer can
 *   actually work (their team, in workflow order) and say which one it is —
 *   it used to open the deploy plan while the change was still in assessment;
 * - inside a CI, a closed task offers "View" (the answers / the plan), an
 *   open one offers "Open"; validation and deployment are not offered before
 *   their scheduled window, so nobody tests or deploys ahead of time.
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/utils'
import { CITasksTable } from './CITasksTable'
import type {
  AffectedCI, AssessmentTaskData, DeployPlanTaskData, DeploymentTaskData, ReviewTaskData, ValidationTestData,
} from '@/types/change'

const PAST = '2020-01-01T10:00:00Z'
const FUTURE = '2099-01-01T10:00:00Z'
const user1 = { id: 'u1', name: 'Anna' } as AssessmentTaskData['completedBy']

function assessment(id: string, status: string, extra: Partial<AssessmentTaskData> = {}): AssessmentTaskData {
  return {
    id, code: id.toUpperCase(), responderRole: 'owner', status, score: null,
    completedBy: null, completedAt: null, assignedTeam: null, assignee: null, responses: [], ...extra,
  }
}
function plan(id: string, status: string, start = PAST, extra: Partial<DeployPlanTaskData> = {}): DeployPlanTaskData {
  return {
    id, code: id.toUpperCase(), status, completedBy: null, completedAt: null, assignedTeam: null, assignee: null,
    steps: [{ title: 'Roll out', validationWindow: { start, end: start }, releaseWindow: { start, end: start } }],
    ...extra,
  }
}
const validation = (id: string, status: string, result: string | null = null): ValidationTestData =>
  ({ id, code: id.toUpperCase(), status, result, testedAt: null, testedBy: null })
const deployment = (id: string, status: string): DeploymentTaskData =>
  ({ id, code: id.toUpperCase(), status, deployedAt: null, deployedBy: null })
const review = (id: string, status: string, result: string | null = null): ReviewTaskData =>
  ({ id, code: id.toUpperCase(), status, result, reviewedAt: null, reviewedBy: null })

function ci(id: string, extra: Partial<AffectedCI> = {}, groups: { owner?: string; support?: string } = {}): AffectedCI {
  return {
    ciPhase: 'assessment', riskScore: null,
    ci: {
      id, name: `CI ${id}`, type: null, environment: null,
      ownerGroup: groups.owner ? { id: groups.owner, name: groups.owner } as AffectedCI['ci']['ownerGroup'] : null,
      supportGroup: groups.support ? { id: groups.support, name: groups.support } as AffectedCI['ci']['supportGroup'] : null,
    },
    assessmentOwner: null, assessmentSupport: null, deployPlan: null, validation: null, deployment: null, review: null,
    ...extra,
  }
}

/** The whole row of a CI (the one holding its expand button). */
const ciRow = (name: string) => screen.getByRole('button', { name }).parentElement!
/** A task row inside an expanded CI, found by its label. */
const taskRow = (label: string) => screen.getByText(label, { selector: 'span' }).parentElement!

describe('CITasksTable · status and count', () => {
  it('a CI is done only when every task is closed AND validation passed AND review confirmed', () => {
    const affected = [
      ci('ok', {
        assessmentOwner: assessment('a1', 'completed'), validation: validation('v1', 'completed', 'pass'),
        review: review('r1', 'completed', 'confirmed'), deployment: deployment('d1', 'completed'),
      }),
      ci('failed', { validation: validation('v2', 'completed', 'fail') }),
      ci('rejected', { review: review('r2', 'completed', 'rejected') }),
      ci('open', { deployPlan: plan('p1', 'in-progress') }),
      ci('empty'),
    ]
    renderWithProviders(<CITasksTable affected={affected} actsForAnyTeam={false} userTeamIds={new Set()} />)
    expect(within(ciRow('CI ok')).getByText('COMPLETED')).toBeInTheDocument()
    // A CI with no task at all has nothing left to do.
    expect(within(ciRow('CI empty')).getByText('COMPLETED')).toBeInTheDocument()
    for (const name of ['CI failed', 'CI rejected', 'CI open']) {
      expect(within(ciRow(name)).getByText('NOT YET COMPLETED')).toBeInTheDocument()
    }
    // The badge counts the CIs still active, not all of them.
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})

describe('CITasksTable · the next task to open', () => {
  it('follows the workflow order, restricted to the viewer\'s teams', () => {
    const affected = [
      // Owner team only: the functional assessment.
      ci('own', { assessmentOwner: assessment('ao', 'pending'), assessmentSupport: assessment('as', 'pending') }, { owner: 'T1', support: 'T9' }),
      // Support team only: the owner assessment is not theirs, the technical one is.
      ci('sup', { assessmentOwner: assessment('ao2', 'pending'), assessmentSupport: assessment('as2', 'pending') }, { owner: 'T9', support: 'T2' }),
      // Support team, assessments done: the plan.
      ci('plan', { assessmentSupport: assessment('as3', 'completed'), deployPlan: plan('p3', 'pending') }, { support: 'T2' }),
      // Owner team, plan done: validation (owner's task).
      ci('val', { deployPlan: plan('p4', 'completed'), validation: validation('v4', 'pending') }, { owner: 'T1', support: 'T2' }),
      // Support team, validation done: the deployment.
      ci('dep', { validation: validation('v5', 'completed', 'pass'), deployment: deployment('d5', 'pending') }, { support: 'T2' }),
      // Owner team: the review.
      ci('rev', { deployment: deployment('d6', 'completed'), review: review('r6', 'pending') }, { owner: 'T1' }),
      // Nobody's team: no shortcut.
      ci('none', { assessmentOwner: assessment('ao7', 'pending') }, { owner: 'T9' }),
      // No groups at all: no shortcut either (a missing group is not "everyone").
      ci('nogroup', { review: review('r8', 'pending') }),
    ]
    renderWithProviders(<CITasksTable affected={affected} actsForAnyTeam={false} userTeamIds={new Set(['T1', 'T2'])} />)
    const expect_ = (name: string, text: string, href: string) => {
      const link = within(ciRow(name)).getByRole('link')
      expect(link).toHaveTextContent(text)
      expect(link).toHaveAttribute('href', href)
    }
    expect_('CI own', 'Open: Functional', '/tasks/ao')
    expect_('CI sup', 'Open: Technical', '/tasks/as2')
    expect_('CI plan', 'Open: Planning', '/tasks/p3')
    expect_('CI val', 'Open: Validation', '/tasks/v4')
    expect_('CI dep', 'Open: Deploy', '/tasks/d5')
    expect_('CI rev', 'Open: Review', '/tasks/r6')
    expect(within(ciRow('CI none')).queryByRole('link')).toBeNull()
    expect(within(ciRow('CI nogroup')).queryByRole('link')).toBeNull()
  })

  it('with approval.override the viewer acts for any team', () => {
    const affected = [ci('x', { review: review('r1', 'pending') })]
    renderWithProviders(<CITasksTable affected={affected} actsForAnyTeam userTeamIds={new Set()} defaultOpen />)
    expect(within(ciRow('CI x')).getByRole('link', { name: 'Open: Review' })).toHaveAttribute('href', '/tasks/r1')
  })
})

describe('CITasksTable · expanded CI', () => {
  it('expands and collapses from the row button', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CITasksTable affected={[ci('a', { review: review('r', 'pending') })]} actsForAnyTeam userTeamIds={new Set()} />)
    const toggle = screen.getByRole('button', { name: 'CI a' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Tasks')).toBeNull()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Tasks')).toBeInTheDocument()
    await user.click(toggle)
    expect(screen.queryByText('Tasks')).toBeNull()
  })

  it('closed assessments and plan offer View; the answers show once both assessments are done', async () => {
    const user = userEvent.setup()
    const responses = [{ question: { id: 'q', text: 'Is it reversible?', category: 'functional' }, selectedOption: { id: 'o', label: 'Yes', score: 2 } }]
    const affected = [ci('a', {
      riskScore: 40,
      assessmentOwner: assessment('ao', 'completed', { score: 7, responses, completedBy: user1, completedAt: PAST }),
      assessmentSupport: assessment('as', 'completed', { score: null }),
      deployPlan: plan('p', 'completed'),
    })]
    renderWithProviders(<CITasksTable affected={affected} actsForAnyTeam userTeamIds={new Set()} />)
    await user.click(screen.getByRole('button', { name: 'CI a' }))

    // Both done: the score line with the missing technical score as a dash.
    expect(screen.getByText('Functional score', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()

    await user.click(within(taskRow('Functional')).getByRole('button', { name: 'View' }))
    const functional = screen.getByRole('dialog', { name: 'Functional answers — CI a' })
    expect(within(functional).getByText('Is it reversible?')).toBeInTheDocument()
    await user.click(within(functional).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(within(taskRow('Technical')).getByRole('button', { name: 'View' }))
    expect(screen.getByRole('dialog', { name: 'Technical answers — CI a' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))

    await user.click(within(taskRow('Planning')).getByRole('button', { name: 'View' }))
    const planDialog = screen.getByRole('dialog', { name: 'Deploy plan — CI a' })
    expect(within(planDialog).getByText('Step 1: Roll out')).toBeInTheDocument()
    await user.click(within(planDialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('an assessment closed on one side only keeps the other side\'s answers hidden', async () => {
    const user = userEvent.setup()
    const affected = [ci('a', {
      assessmentOwner: assessment('ao', 'completed'),
      assessmentSupport: assessment('as', 'in-progress', { assignedTeam: { id: 't', name: 'Ops' } as AssessmentTaskData['assignedTeam'] }),
      deployPlan: plan('p', 'pending'),
    })]
    renderWithProviders(<CITasksTable affected={affected} actsForAnyTeam userTeamIds={new Set()} />)
    await user.click(screen.getByRole('button', { name: 'CI a' }))
    expect(screen.queryByText('Functional score', { exact: false })).toBeNull()
    // Open tasks offer "Open" to their task page, not "View".
    expect(within(taskRow('Technical')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/tasks/as')
    expect(within(taskRow('Planning')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/tasks/p')
    expect(within(taskRow('Planning')).queryByRole('button', { name: 'View' })).toBeNull()

    await user.click(within(taskRow('Functional')).getByRole('button', { name: 'View' }))
    expect(screen.getByText('The answers become visible when both assessments are complete.')).toBeInTheDocument()
  })

  it('validation and deployment are offered only once their window has started', async () => {
    const user = userEvent.setup()
    const early = ci('early', {
      deployPlan: plan('p1', 'completed', FUTURE),
      validation: validation('v1', 'pending'), deployment: deployment('d1', 'pending'),
    })
    const due = ci('due', {
      deployPlan: plan('p2', 'completed', PAST),
      validation: validation('v2', 'in-progress'), deployment: deployment('d2', 'in-progress'), review: review('r2', 'pending'),
    })
    renderWithProviders(<CITasksTable affected={[early, due]} actsForAnyTeam userTeamIds={new Set()} />)

    await user.click(screen.getByRole('button', { name: 'CI early' }))
    expect(within(taskRow('Validation')).queryByRole('link')).toBeNull()
    expect(within(taskRow('Deploy')).queryByRole('link')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'CI early' }))

    await user.click(screen.getByRole('button', { name: 'CI due' }))
    expect(within(taskRow('Validation')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/tasks/v2')
    expect(within(taskRow('Deploy')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/tasks/d2')
    expect(within(taskRow('Review')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/tasks/r2')
  })

  it('a deployment still in planning is not listed, and closed tasks offer nothing', async () => {
    const user = userEvent.setup()
    const planning = ci('planning', { deployment: deployment('d', 'planning') })
    const closed = ci('closed', {
      validation: validation('v', 'completed', 'pass'), deployment: deployment('d2', 'completed'),
      review: review('r', 'completed', 'confirmed'),
    })
    // No plan at all: validation has no window, so it is not held back.
    const noPlan = ci('noplan', { validation: validation('v3', 'pending') })
    renderWithProviders(<CITasksTable affected={[planning, closed, noPlan]} actsForAnyTeam userTeamIds={new Set()} />)

    await user.click(screen.getByRole('button', { name: 'CI planning' }))
    expect(screen.queryByText('Deploy', { selector: 'span' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'CI planning' }))

    await user.click(screen.getByRole('button', { name: 'CI closed' }))
    for (const label of ['Validation', 'Deploy', 'Review']) {
      expect(within(taskRow(label)).queryByRole('link')).toBeNull()
    }
    await user.click(screen.getByRole('button', { name: 'CI closed' }))

    await user.click(screen.getByRole('button', { name: 'CI noplan' }))
    expect(within(taskRow('Validation')).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/tasks/v3')
  })
})
