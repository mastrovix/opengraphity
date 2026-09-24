/**
 * ONE TASK OF A CHANGE: ASSESS, PLAN, VALIDATE, DEPLOY, REVIEW.
 *
 * A change touches several CIs, and every CI goes through six tasks owned by
 * two teams: the owner team assesses the function, validates and reviews; the
 * support team assesses the technique, plans and deploys. This page is where
 * one of those tasks is done, so what it decides is what the change's
 * approval and release rest on:
 *
 *  - who may act — the team the task belongs to, or whoever acts for any team
 *    — and, for everyone else, who to nudge instead;
 *  - which questionnaire an assessment answers (functional for the owner,
 *    technical for the support team), and what each answer, plan and result
 *    sends to the API;
 *  - that completing before the planned window asks first, and that a
 *    completion in flight cannot be clicked twice (D24);
 *  - that only whoever acts for any team can reopen a completed task, and
 *    that each kind reopens through its own mutation.
 *
 * The task forms, the team gate and the change overview are the real ones;
 * only attachments are left out (they have their own tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { hold, inFlight, release, resetInFlight } from '@/test/apolloInFlight'
import { formatDateTime } from '@/lib/datetime'
import type { AffectedCI, AssessmentTaskData, DeployStep } from '@/types/change'
import { TaskViewPage } from './TaskViewPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloInFlight')).apolloModuleWithInFlight())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast, Toaster: () => null }))
vi.mock('@/components/AttachmentsSection', () => ({ AttachmentsSection: () => null }))

// ── The change and its CI ─────────────────────────────────────────────────────

const OWNER_TEAM = { id: 't-own', name: 'OWN_Web' }
const SUPPORT_TEAM = { id: 't-sup', name: 'SUP_Web' }

const FUTURE = '2099-06-01T08:00:00Z'
const PAST = '2020-06-01T08:00:00Z'
const step = (title: string, validationStart: string, releaseStart: string): DeployStep => ({
  title,
  validationWindow: { start: validationStart, end: '2099-06-01T10:00:00Z' },
  releaseWindow: { start: releaseStart, end: '2099-06-02T10:00:00Z' },
})

const answer = (questionId: string, optionId: string) => ({
  question: { id: questionId, text: questionId, category: 'functional' }, selectedOption: { id: optionId, label: optionId, score: 1 },
})
const assessment = (id: string, role: string, over: Partial<AssessmentTaskData> = {}): AssessmentTaskData => ({
  id, code: id.toUpperCase(), responderRole: role, status: 'in-progress', score: null, completedBy: null, completedAt: null,
  assignedTeam: role === 'owner' ? OWNER_TEAM : SUPPORT_TEAM, assignee: null, responses: [], ...over,
})

type Parts = Partial<Omit<AffectedCI, 'ci'>>
function affected(parts: Parts = {}): AffectedCI {
  return {
    ciPhase: 'assessment', riskScore: null,
    ci: { id: 'ci-web', name: 'web-01', type: 'server', environment: 'production', ownerGroup: OWNER_TEAM, supportGroup: SUPPORT_TEAM },
    assessmentOwner: assessment('at-own', 'owner'),
    assessmentSupport: assessment('at-sup', 'support', { assignee: { id: 'u-sam', name: 'Sam Support' } }),
    deployPlan: {
      id: 'dp-1', code: 'DP-1', status: 'in-progress', steps: [step('Database first', PAST, PAST)],
      completedBy: null, completedAt: null, assignedTeam: SUPPORT_TEAM, assignee: null,
    },
    validation: { id: 'val-1', code: 'VAL-1', status: 'pending', result: null, testedAt: null, testedBy: null },
    deployment: { id: 'dep-1', code: 'DEP-1', status: 'pending', deployedAt: null, deployedBy: null },
    review: { id: 'rev-1', code: 'REV-1', status: 'pending', result: null, reviewedAt: null, reviewedBy: null },
    ...parts,
  }
}

const question = (id: string, text: string) => ({
  weight: 2, sortOrder: 1,
  question: { id, text, category: 'x', isCore: true, isActive: true, createdAt: '2026-09-01T00:00:00Z', options: [
    { id: `${id}-a`, label: 'Low', score: 1, sortOrder: 1 }, { id: `${id}-b`, label: 'High', score: 3, sortOrder: 2 },
  ] },
})
const FUNCTIONAL = [question('q-users', 'How many users depend on it?'), question('q-hours', 'Is it used out of hours?')]
const TECHNICAL = [question('q-rollback', 'Can it be rolled back?')]

const MEMBERS: Record<string, Array<{ id: string; name: string; email: string }>> = {
  't-own': [{ id: 'u-olga', name: 'Olga Owner', email: 'olga@example.com' }, { id: 'u-otto', name: 'Otto Owner', email: 'otto@example.com' }],
  't-sup': [{ id: 'u-sam', name: 'Sam Support', email: 'sam@example.com' }],
}

interface SetUp { affected?: AffectedCI | null; teams?: string[]; permissions?: string[]; ciType?: string | null }

/** The API's answers for this task, this CI and this person. */
function answers(kind: string, taskId: string, opts: SetUp = {}) {
  apolloFinto.risposte['GetTaskById'] = { taskById: {
    id: taskId, code: `TASK-${taskId}`, kind, changeId: 'ch-1', changeCode: 'CHG00000012', changeTitle: 'Upgrade the web tier',
    changePhase: 'assessment', changeDescription: null, ciId: 'ci-web', ciName: 'web-01',
    ciType: opts.ciType === undefined ? 'server' : opts.ciType, ciEnv: 'production',
  } }
  apolloFinto.risposte['GetChangeAffectedCIs'] = { changeAffectedCIs: opts.affected === null ? [] : [opts.affected ?? affected()] }
  apolloFinto.risposte['GetMe'] = { me: {
    id: 'u-me', name: 'Me', email: 'me@example.com', role: 'operator', roleName: null, permissions: opts.permissions ?? ['ticket.work'],
    slackId: null, emailNotifications: true, language: null, teams: (opts.teams ?? []).map((id) => ({ id, name: id })),
  } }
}

const openTask = (taskId: string) => renderWithProviders(<TaskViewPage />, { route: `/tasks/${taskId}`, path: '/tasks/:taskId' })

function setUp(kind: string, taskId: string, opts: SetUp = {}) {
  answers(kind, taskId, opts)
  return openTask(taskId)
}

beforeEach(() => {
  apolloFinto.reset()
  resetInFlight()
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetChange'] = { change: {
    id: 'ch-1', code: 'CHG00000012', title: 'Upgrade the web tier', why: null, what: null, aggregateRiskScore: null,
    approvalRoute: null, approvalStatus: null, approvalAt: null, createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-20T08:00:00Z',
    requester: null, changeOwner: null, approvalBy: null, availableTransitions: [],
    workflowInstance: { id: 'wi-9', currentStep: 'assessment', status: 'running' },
  } }
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { transitions: [], steps: [
    { id: 's1', name: 'assessment', label: 'Risk assessment', labels: [], type: 'state', isInitial: true, isTerminal: false, isOpen: true, category: 'active', purpose: null, order: 0 },
  ] } }
  apolloFinto.risposte['GetWorkflowStepLabels'] = { workflowStepLabels: [] }
  apolloFinto.risposte['GetQuestionCatalog'] = (v?: Record<string, unknown>) => ({
    assessmentQuestionCatalog: v?.['category'] === 'functional' ? FUNCTIONAL : v?.['category'] === 'technical' ? TECHNICAL : [],
  })
  apolloFinto.risposte['GetTeamDetail'] = (v?: Record<string, unknown>) => {
    const id = String(v?.['id'])
    return { team: MEMBERS[id] ? { id, name: id === 't-own' ? OWNER_TEAM.name : SUPPORT_TEAM.name, members: MEMBERS[id] } : null }
  }
  apolloFinto.risposte['GetTenantTimezoneSettings'] = { tenantTimezoneSettings: { timezone: 'Europe/Rome', available: [] } }
  apolloFinto.esiti['CompleteAssessmentTask'] = { data: { completeAssessmentTask: { id: 'at-own' } } }
  apolloFinto.esiti['CompleteDeployPlanTask'] = { data: { completeDeployPlanTask: { id: 'dp-1' } } }
  apolloFinto.esiti['CompleteValidationTest'] = { data: { completeValidationTest: { id: 'val-1' } } }
  apolloFinto.esiti['CompleteDeployment'] = { data: { completeDeployment: { id: 'dep-1' } } }
  apolloFinto.esiti['CompleteReview'] = { data: { completeReview: { id: 'rev-1' } } }
})

const confirmDialog = () => screen.getByRole('dialog', { name: 'Before the planned window' })

// ── States ────────────────────────────────────────────────────────────────────

describe('TaskViewPage: before there is a task to show', () => {
  it('while the task loads, it says so', () => {
    inFlight.add('GetTaskById')
    setUp('validation', 'val-1')
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('a failed load shows the error with a retry', async () => {
    apolloFinto.erroriQuery['GetTaskById'] = new Error('task service down')
    const { user } = setUp('validation', 'val-1')
    expect(screen.getByText('task service down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a task that does not exist says so', () => {
    answers('validation', 'val-1')
    apolloFinto.risposte['GetTaskById'] = { taskById: null }
    openTask('nope')
    expect(screen.getByText('Task not found')).toBeInTheDocument()
    // Without a task there is no change to read.
    expect(apolloFinto.chiamate['GetChange']).toBeUndefined()
  })
})

describe('TaskViewPage: where the task stands', () => {
  it('the path leads back to the change; the title is the task code; the CI is named with its labels', () => {
    setUp('validation', 'val-1', { teams: ['t-own'] })
    const path = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(path).getByRole('link', { name: 'CHG00000012' })).toHaveAttribute('href', '/changes/ch-1')
    expect(within(path).getByText('web-01')).toBeInTheDocument()
    expect(within(path).getByText('Validation')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { level: 1, name: 'TASK-val-1' })).toBeInTheDocument()
    expect(screen.getByText('web-01 · Server · production')).toBeInTheDocument()
    expect(apolloFinto.chiamata('GetTaskById')).toEqual({ id: 'val-1' })
  })

  it('a CI without a type is named alone', () => {
    setUp('validation', 'val-1', { teams: ['t-own'], ciType: null })
    expect(screen.getByText('web-01', { selector: 'p' })).toBeInTheDocument()
  })

  it('the change overview names the phase as the workflow does, and a CI row leads to the change', async () => {
    const { user } = setUp('validation', 'val-1', { teams: ['t-own'] })
    expect(screen.getByText('Risk assessment')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /web-01/ }))
    await attendiURL('/changes/ch-1')
  })

  it('while the change is being read, the overview is empty and the task can still be worked', async () => {
    delete apolloFinto.risposte['GetChange']
    const { user } = setUp('validation', 'val-1', { teams: ['t-own'] })
    expect(screen.getByText('Change overview')).toBeInTheDocument()
    expect(screen.queryByText('Risk assessment')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'See the full change →' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pass' }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteValidationTest')).toEqual({ changeId: 'ch-1', ciId: 'ci-web', result: 'pass' }))
  })

  it('while the person is unknown, nothing can be done in anyone\'s name', () => {
    answers('validation', 'val-1', { teams: ['t-own'] })
    apolloFinto.risposte['GetMe'] = { me: null }
    openTask('val-1')
    expect(screen.getByRole('button', { name: 'Pass' })).toBeDisabled()
    expect(screen.getByText(/You are not in the team responsible for this task/)).toBeInTheDocument()
  })

  it('a kind of task this page does not know is named as it is, with nothing to fill in', () => {
    setUp('security-scan', 'sec-1', { teams: ['t-own', 't-sup'] })
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('security-scan')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pass|Confirm|Complete/ })).not.toBeInTheDocument()
    // Nobody can act on it here: the page names who could.
    expect(screen.getByText(/You are not in the team responsible for this task/)).toBeInTheDocument()
  })
})

// ── Assessment ────────────────────────────────────────────────────────────────

describe('TaskViewPage: an assessment', () => {
  it('the owner team answers the functional questions; each answer is sent, then the CIs are read again', async () => {
    const { user } = setUp('assessment', 'at-own', { teams: ['t-own'] })
    expect(screen.getByRole('combobox', { name: 'How many users depend on it?' })).toBeEnabled()
    expect(screen.queryByRole('combobox', { name: 'Can it be rolled back?' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'How many users depend on it?' }), 'q-users-b')
    await waitFor(() => expect(apolloFinto.chiamata('SubmitAssessmentResponse')).toEqual({ taskId: 'at-own', questionId: 'q-users', optionId: 'q-users-b' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Complete (0/2)' })).toBeDisabled()
    expect(screen.queryByText(/not in the team responsible/)).not.toBeInTheDocument()
  })

  it('with every answer given, completing sends it and goes back to the change', async () => {
    const { user } = setUp('assessment', 'at-own', { teams: ['t-own'], affected: affected({
      assessmentOwner: assessment('at-own', 'owner', { responses: [answer('q-users', 'q-users-a'), answer('q-hours', 'q-hours-b')] }),
    }) })
    await user.click(screen.getByRole('button', { name: 'Complete (2/2)' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Task completed'))
    expect(apolloFinto.chiamata('CompleteAssessmentTask')).toEqual({ taskId: 'at-own' })
    await attendiURL('/changes/ch-1')
  })

  it('the support team answers the technical questions', () => {
    setUp('assessment', 'at-sup', { teams: ['t-sup'] })
    expect(screen.getByRole('combobox', { name: 'Can it be rolled back?' })).toBeEnabled()
    expect(screen.queryByRole('combobox', { name: 'How many users depend on it?' })).not.toBeInTheDocument()
  })

  it('outside the responsible team the answers are read-only, and its members can be nudged', () => {
    setUp('assessment', 'at-sup', { teams: ['t-own'] })
    expect(screen.getByRole('combobox', { name: 'Can it be rolled back?' })).toBeDisabled()
    expect(screen.getByText('You are not in the right team to complete this task')).toBeInTheDocument()
    expect(screen.getByText(/You are not in the team responsible for this task/)).toBeInTheDocument()
    expect(apolloFinto.chiamate['GetTeamDetail']).toContainEqual({ id: 't-sup' })
    // The person the task is assigned to is marked among them.
    expect(screen.getByText('Sam Support', { selector: 'span' }).parentElement).toHaveTextContent('Assigned')
  })

  it('whoever acts for any team may answer for them', () => {
    setUp('assessment', 'at-sup', { teams: [], permissions: ['ticket.work', 'approval.override'] })
    expect(screen.getByRole('combobox', { name: 'Can it be rolled back?' })).toBeEnabled()
    expect(screen.queryByText(/not in the team responsible/)).not.toBeInTheDocument()
  })

  it('a task whose CI is no longer in the change has no form, and no one to name', () => {
    setUp('assessment', 'at-own', { teams: ['t-own'], affected: null })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Complete/ })).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['GetTeamDetail']).toBeUndefined()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: the error of the question
  // catalog was ignored and a catalog not read was taken for an empty one — no
  // question, and an ENABLED «Complete (0/0)» that the API always refuses.
  it.each(['at-own', 'at-sup'])('%s: a questionnaire that cannot be read is said, and nothing is offered to complete', async (taskId) => {
    apolloFinto.erroriQuery['GetQuestionCatalog'] = new Error('catalog down')
    const { user } = setUp('assessment', taskId, { teams: ['t-own', 't-sup'] })
    const complete = screen.queryByRole('button', { name: /^Complete/ })
    expect(complete === null || complete.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/catalog down/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('while the questionnaire is being read, nothing is offered to complete', () => {
    inFlight.add('GetQuestionCatalog')
    setUp('assessment', 'at-own', { teams: ['t-own'] })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Complete/ })).not.toBeInTheDocument()
  })

  it('while an answer is saved or the completion runs, "Complete" waits and says what for', () => {
    inFlight.add('SubmitAssessmentResponse')
    const { unmount } = setUp('assessment', 'at-own', { teams: ['t-own'] })
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    unmount()
    resetInFlight()
    inFlight.add('CompleteAssessmentTask')
    setUp('assessment', 'at-own', { teams: ['t-own'] })
    expect(screen.getByRole('button', { name: 'Completing…' })).toBeDisabled()
  })

  it('a completion that fails says why and stays on the task', async () => {
    apolloFinto.esiti['CompleteAssessmentTask'] = { error: new Error('This task is already completed') }
    const { user } = setUp('assessment', 'at-own', { teams: ['t-own'], affected: affected({
      assessmentOwner: assessment('at-own', 'owner', { responses: [answer('q-users', 'q-users-a'), answer('q-hours', 'q-hours-b')] }),
    }) })
    await user.click(screen.getByRole('button', { name: 'Complete (2/2)' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This task is already completed'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/at-own')
  })
})

describe('TaskViewPage: who the task is assigned to', () => {
  it('the members of the task\'s team are offered, and the choice is sent', async () => {
    const { user } = setUp('assessment', 'at-own', { teams: ['t-own'] })
    expect(screen.getByText('Teams: OWN_Web')).toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: 'Assigned to' })
    await waitFor(() => expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Unassigned —', 'Olga Owner', 'Otto Owner']))
    await user.selectOptions(select, 'u-otto')
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Assignment updated'))
    expect(apolloFinto.chiamata('AssignAssessmentTaskToUser')).toEqual({ taskId: 'at-own', userId: 'u-otto' })
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('"Unassigned" removes the assignee', async () => {
    const { user } = setUp('assessment', 'at-sup', { teams: ['t-sup'] })
    const select = screen.getByRole('combobox', { name: 'Assigned to' })
    expect(select).toHaveValue('u-sam')
    await user.selectOptions(select, '')
    await waitFor(() => expect(apolloFinto.chiamata('AssignAssessmentTaskToUser')).toEqual({ taskId: 'at-sup', userId: null }))
  })

  it('the plan is assigned through its own mutation', async () => {
    const { user } = setUp('deploy-plan', 'dp-1', { teams: ['t-sup'] })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'u-sam')
    await waitFor(() => expect(apolloFinto.chiamata('AssignDeployPlanTaskToUser')).toEqual({ taskId: 'dp-1', userId: 'u-sam' }))
    expect(apolloFinto.chiamate['AssignAssessmentTaskToUser']).toBeUndefined()
  })

  it('outside the team, or once the task is completed, the assignee cannot be changed', () => {
    const { unmount } = setUp('assessment', 'at-own', { teams: ['t-sup'] })
    expect(screen.getByRole('combobox', { name: 'Assigned to' })).toBeDisabled()
    unmount()
    setUp('assessment', 'at-own', { teams: ['t-own'], affected: affected({ assessmentOwner: assessment('at-own', 'owner', { status: 'completed' }) }) })
    expect(screen.getByRole('combobox', { name: 'Assigned to' })).toBeDisabled()
  })

  it('a task without a team has nobody to offer, and asks for nobody\'s list', () => {
    setUp('assessment', 'at-own', { teams: ['t-own'], affected: affected({ assessmentOwner: assessment('at-own', 'owner', { assignedTeam: null }) }) })
    expect(screen.getByText('Teams: —')).toBeInTheDocument()
    expect(within(screen.getByRole('combobox', { name: 'Assigned to' })).getAllByRole('option')).toHaveLength(1)
    expect(apolloFinto.chiamate['GetTeamDetail']).toBeUndefined()
  })

  it('a team that no longer exists offers nobody', () => {
    setUp('assessment', 'at-own', { teams: ['t-own'], affected: affected({ assessmentOwner: assessment('at-own', 'owner', { assignedTeam: { id: 't-gone', name: 'OWN_Old' } }) }) })
    expect(screen.getByText('Teams: OWN_Old')).toBeInTheDocument()
    expect(apolloFinto.chiamate['GetTeamDetail']).toContainEqual({ id: 't-gone' })
    expect(within(screen.getByRole('combobox', { name: 'Assigned to' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Unassigned —'])
  })

  it('validation, deployment and review have no assignee row', () => {
    setUp('review', 'rev-1', { teams: ['t-own'] })
    expect(screen.queryByRole('combobox', { name: 'Assigned to' })).not.toBeInTheDocument()
  })

  it('a refused assignment says why', async () => {
    apolloFinto.esiti['AssignAssessmentTaskToUser'] = { error: new Error('not a member of the team') }
    const { user } = setUp('assessment', 'at-own', { teams: ['t-own'] })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'u-olga')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not a member of the team'))
  })
})

// ── Deployment plan ───────────────────────────────────────────────────────────

describe('TaskViewPage: the deployment plan', () => {
  it('the support team edits the plan, saves it, and then completes it', async () => {
    const { user } = setUp('deploy-plan', 'dp-1', { teams: ['t-sup'] })
    const title = screen.getByLabelText('Title *')
    expect(title).toHaveValue('Database first')
    await user.type(title, ' and cache')
    // An unsaved plan cannot be completed.
    expect(screen.getByRole('button', { name: 'Complete the plan' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Plan saved'))
    expect(apolloFinto.chiamata('SaveDeployPlan')).toEqual({ taskId: 'dp-1', steps: [{ ...step('Database first', PAST, PAST), title: 'Database first and cache' }] })
    await user.click(screen.getByRole('button', { name: 'Complete the plan' }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteDeployPlanTask')).toEqual({ taskId: 'dp-1' }))
    await attendiURL('/changes/ch-1')
  })

  // Review of 23 Sep 2026: a refused save cleared the flag anyway, and «Complete» locked the old plan.
  it('a refused save keeps the plan unsaved: «Save plan» stays, «Complete» stays disabled', async () => {
    apolloFinto.esiti['SaveDeployPlan'] = { error: new Error('a step ends before it starts') }
    const { user } = setUp('deploy-plan', 'dp-1', { teams: ['t-sup'] })
    await user.type(screen.getByLabelText('Title *'), ' and cache')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('a step ends before it starts'))
    expect(screen.getByRole('button', { name: 'Save plan' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Complete the plan' })).toBeDisabled()
  })

  it('the owner team reads the plan and nudges the support team instead', () => {
    setUp('deploy-plan', 'dp-1', { teams: ['t-own'] })
    expect(screen.getByLabelText('Title *')).toBeDisabled()
    expect(screen.getByText('You are not in the right team')).toBeInTheDocument()
    expect(apolloFinto.chiamate['GetTeamDetail']).toContainEqual({ id: 't-sup' })
  })

  it('a CI without a plan shows no plan form', () => {
    setUp('deploy-plan', 'dp-1', { teams: ['t-sup'], affected: affected({ deployPlan: null }) })
    expect(screen.queryByRole('button', { name: 'Complete the plan' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Assigned to' })).not.toBeInTheDocument()
  })
})

// ── Validation, deployment, review ────────────────────────────────────────────

describe('TaskViewPage: validation, deployment and review', () => {
  it('a validation after its window is recorded at once, with its result', async () => {
    const { user } = setUp('validation', 'val-1', { teams: ['t-own'] })
    await user.click(screen.getByRole('button', { name: 'Fail' }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteValidationTest')).toEqual({ changeId: 'ch-1', ciId: 'ci-web', result: 'fail' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await attendiURL('/changes/ch-1')
  })

  it('a validation before its planned window asks first, naming when the window starts', async () => {
    const early = affected({ deployPlan: { ...affected().deployPlan!, steps: [step('Later', '2099-07-01T08:00:00Z', FUTURE), step('Sooner', FUTURE, FUTURE)] } })
    const { user } = setUp('validation', 'val-1', { teams: ['t-own'], affected: early })
    await user.click(screen.getByRole('button', { name: 'Pass' }))
    expect(confirmDialog()).toHaveTextContent(`The planned validation window starts on ${formatDateTime(FUTURE)}. Record the outcome now?`)
    await user.click(within(confirmDialog()).getByRole('button', { name: 'Cancel' }))
    expect(apolloFinto.chiamate['CompleteValidationTest']).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Pass' }))
    await user.click(within(confirmDialog()).getByRole('button', { name: 'Yes, complete now' }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteValidationTest')).toEqual({ changeId: 'ch-1', ciId: 'ci-web', result: 'pass' }))
  })

  it('a deployment before its release window asks first; confirmed, it is recorded', async () => {
    const early = affected({ deployPlan: { ...affected().deployPlan!, steps: [step('Now', PAST, FUTURE)] } })
    const { user } = setUp('deployment', 'dep-1', { teams: ['t-sup'], affected: early })
    await user.click(screen.getByRole('button', { name: 'Confirm deployment' }))
    expect(confirmDialog()).toHaveTextContent(`The planned release window starts on ${formatDateTime(FUTURE)}. Confirm the deployment now?`)
    await user.click(within(confirmDialog()).getByRole('button', { name: 'Cancel' }))
    expect(apolloFinto.chiamate['CompleteDeployment']).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Confirm deployment' }))
    await user.click(within(confirmDialog()).getByRole('button', { name: 'Yes, complete now' }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteDeployment')).toEqual({ changeId: 'ch-1', ciId: 'ci-web' }))
  })

  it('a deployment without a plan window, or after it, is recorded at once', async () => {
    const { user } = setUp('deployment', 'dep-1', { teams: ['t-sup'], affected: affected({ deployPlan: null }) })
    await user.click(screen.getByRole('button', { name: 'Confirm deployment' }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteDeployment')).toEqual({ changeId: 'ch-1', ciId: 'ci-web' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('the review is confirmed or rejected by the owner team, with no window to wait for', async () => {
    const { user, unmount } = setUp('review', 'rev-1', { teams: ['t-own'] })
    await user.click(screen.getByRole('button', { name: 'Confirmed' }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteReview')).toEqual({ changeId: 'ch-1', ciId: 'ci-web', result: 'confirmed' }))
    unmount()
    const again = setUp('review', 'rev-1', { teams: ['t-own'] })
    await again.user.click(screen.getByRole('button', { name: 'Rejected' }))
    await waitFor(() => expect(apolloFinto.chiamata('CompleteReview')).toEqual({ changeId: 'ch-1', ciId: 'ci-web', result: 'rejected' }))
  })

  it('while a result is being recorded both results wait, and the pressed one says so (D24)', async () => {
    hold('CompleteValidationTest')
    const { user, rerender } = setUp('validation', 'val-1', { teams: ['t-own'] })
    await user.click(screen.getByRole('button', { name: 'Pass' }))
    // The server has not answered yet.
    inFlight.add('CompleteValidationTest')
    rerender(<TaskViewPage />)
    expect(screen.getByRole('button', { name: 'Completing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Fail' })).toBeDisabled()
    release('CompleteValidationTest')
    await waitFor(() => expect(apolloFinto.chiamata('CompleteValidationTest')).toEqual({ changeId: 'ch-1', ciId: 'ci-web', result: 'pass' }))
    expect(apolloFinto.chiamate['CompleteValidationTest']).toHaveLength(1)
  })

  it('the support team cannot validate or review, the owner team cannot deploy', () => {
    const { unmount } = setUp('validation', 'val-1', { teams: ['t-sup'] })
    expect(screen.getByRole('button', { name: 'Pass' })).toBeDisabled()
    unmount()
    const again = setUp('review', 'rev-1', { teams: ['t-sup'] })
    expect(screen.getByRole('button', { name: 'Rejected' })).toBeDisabled()
    again.unmount()
    setUp('deployment', 'dep-1', { teams: ['t-own'] })
    expect(screen.getByRole('button', { name: 'Confirm deployment' })).toBeDisabled()
  })
})

// ── Reopening ─────────────────────────────────────────────────────────────────

describe('TaskViewPage: reopening a completed task', () => {
  const OVERRIDE = ['ticket.work', 'approval.override']
  const completed = affected({
    assessmentOwner: assessment('at-own', 'owner', { status: 'completed' }),
    deployPlan: { ...affected().deployPlan!, status: 'completed' },
    validation: { id: 'val-1', code: 'VAL-1', status: 'completed', result: 'pass', testedAt: null, testedBy: null },
    deployment: { id: 'dep-1', code: 'DEP-1', status: 'completed', deployedAt: null, deployedBy: null },
    review: { id: 'rev-1', code: 'REV-1', status: 'completed', result: 'confirmed', reviewedAt: null, reviewedBy: null },
  })

  it.each([
    ['assessment', 'at-own', 'ReopenAssessmentTask', { taskId: 'at-own' }],
    ['deploy-plan', 'dp-1', 'ReopenDeployPlanTask', { taskId: 'dp-1' }],
    ['validation', 'val-1', 'ReopenValidationTest', { id: 'val-1' }],
    ['deployment', 'dep-1', 'ReopenDeploymentTask', { id: 'dep-1' }],
    ['review', 'rev-1', 'ReopenReviewTask', { id: 'rev-1' }],
  ])('a completed %s reopens through its own mutation, with the reason', async (kind, taskId, mutation, ids) => {
    const { user } = setUp(kind, taskId, { permissions: OVERRIDE, affected: completed })
    await user.click(screen.getByRole('button', { name: 'Reopen task' }))
    await user.type(screen.getByRole('textbox', { name: 'Reason for reopening...' }), 'Assessed the wrong CI')
    await user.click(screen.getByRole('button', { name: 'Confirm reopen' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Task reopened'))
    expect(apolloFinto.chiamata(mutation)).toEqual({ ...ids, reason: 'Assessed the wrong CI' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('cancelling reopens nothing', async () => {
    const { user } = setUp('review', 'rev-1', { permissions: OVERRIDE, affected: completed })
    await user.click(screen.getByRole('button', { name: 'Reopen task' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['ReopenReviewTask']).toBeUndefined()
  })

  it('only whoever acts for any team may reopen, and only a completed task', () => {
    const { unmount } = setUp('review', 'rev-1', { teams: ['t-own'], affected: completed })
    expect(screen.queryByRole('button', { name: 'Reopen task' })).not.toBeInTheDocument()
    unmount()
    setUp('review', 'rev-1', { permissions: OVERRIDE })
    expect(screen.queryByRole('button', { name: 'Reopen task' })).not.toBeInTheDocument()
  })

  it('a task of an unknown kind is never "completed", so never reopened', () => {
    setUp('security-scan', 'sec-1', { permissions: OVERRIDE, affected: completed })
    expect(screen.queryByRole('button', { name: 'Reopen task' })).not.toBeInTheDocument()
  })

  it('a refused reopening says why', async () => {
    apolloFinto.esiti['ReopenValidationTest'] = { error: new Error('the change is already closed') }
    const { user } = setUp('validation', 'val-1', { permissions: OVERRIDE, affected: completed })
    await user.click(screen.getByRole('button', { name: 'Reopen task' }))
    await user.type(screen.getByRole('textbox', { name: 'Reason for reopening...' }), 'Retest after the fix')
    await user.click(screen.getByRole('button', { name: 'Confirm reopen' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('the change is already closed'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
