/**
 * THE DEPLOYMENT PLAN OF A CI: WHEN IT IS VALIDATED, WHEN IT IS RELEASED.
 *
 * The support team writes one step per release, each with a validation window
 * and a release window. Those windows are what the change board approves and
 * what silences the monitoring alarms during the release, so:
 *  - the hours are written and shown in the ORGANIZATION's time zone, and the
 *    labels say which zone that is (F-13);
 *  - every edit reaches the page (which owns the steps) and marks the plan as
 *    changed, so it is saved before it is completed;
 *  - the plan can be completed only when every step is filled in and saved,
 *    and only by the team it belongs to — and the button says which of these
 *    is missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { DeployPlanTaskData, DeployStep } from '@/types/change'
import { PlanTaskForm } from './PlanTaskForm'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const STEP: DeployStep = {
  title: 'Database first',
  validationWindow: { start: '2026-10-01T08:00:00Z', end: '2026-10-01T10:00:00Z' },
  releaseWindow: { start: '2026-10-02T20:00:00Z', end: '2026-10-02T22:00:00Z' },
}
const plan = (status = 'in-progress'): DeployPlanTaskData => ({
  id: 'dp-1', code: 'TASK-9', status, steps: [], completedBy: null, completedAt: null, assignedTeam: null, assignee: null,
})

interface Props { steps?: DeployStep[]; dirty?: boolean; canEdit?: boolean; status?: string; busyLabel?: string | null }

function setup({ steps = [STEP], dirty = false, canEdit = true, status, busyLabel = null }: Props = {}) {
  const reported = { steps: vi.fn(), dirty: vi.fn() }
  const onSave = vi.fn()
  const onComplete = vi.fn()
  /** The page owns the steps: the harness keeps them as the page does. */
  function Page() {
    const [current, setCurrent] = useState(steps)
    const [changed, setChanged] = useState(dirty)
    return (
      <PlanTaskForm
        task={plan(status)} steps={current} dirty={changed} canEdit={canEdit} busyLabel={busyLabel}
        setSteps={(s) => { reported.steps(s); setCurrent(s) }}
        setDirty={(d) => { reported.dirty(d); setChanged(d) }}
        onSave={onSave} onComplete={onComplete}
      />
    )
  }
  const utils = renderWithProviders(<Page />)
  const lastSteps = () => reported.steps.mock.calls.at(-1)?.[0] as DeployStep[]
  return { ...utils, reported, lastSteps, onSave, onComplete }
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetTenantTimezoneSettings'] = { tenantTimezoneSettings: { timezone: 'America/New_York', available: [] } }
})

const complete = () => screen.getByRole('button', { name: 'Complete the plan' })

describe('PlanTaskForm: the windows, in the organization\'s time zone', () => {
  it('shows each step with its windows in that zone, and says which zone it is', () => {
    setup()
    expect(screen.getByText('Step 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Title *')).toHaveValue('Database first')
    expect(screen.getByLabelText(/^Validation \*/)).toHaveValue('2026-10-01T04:00')
    expect(screen.getByLabelText('End of validation')).toHaveValue('2026-10-01T06:00')
    expect(screen.getByLabelText(/^Deploy \*/)).toHaveValue('2026-10-02T16:00')
    expect(screen.getByLabelText('End of the release')).toHaveValue('2026-10-02T18:00')
    expect(screen.getAllByText('(America/New_York)')).toHaveLength(2)
  })

  it('until the organization\'s zone is known, the browser\'s is used and named', () => {
    delete apolloFinto.risposte['GetTenantTimezoneSettings']
    setup()
    expect(screen.getByLabelText(/^Validation \*/)).toHaveValue('2026-10-01T10:00')
    expect(screen.getAllByText(`(${Intl.DateTimeFormat().resolvedOptions().timeZone})`)).toHaveLength(2)
  })

  it('an hour typed is saved as that hour of the organization', () => {
    const { lastSteps, reported } = setup()
    fireEvent.change(screen.getByLabelText(/^Validation \*/), { target: { value: '2026-10-01T22:00' } })
    expect(lastSteps()[0]!.validationWindow).toEqual({ start: '2026-10-02T02:00:00.000Z', end: '2026-10-01T10:00:00Z' })
    fireEvent.change(screen.getByLabelText('End of validation'), { target: { value: '2026-10-01T23:00' } })
    expect(lastSteps()[0]!.validationWindow.end).toBe('2026-10-02T03:00:00.000Z')
    fireEvent.change(screen.getByLabelText(/^Deploy \*/), { target: { value: '2026-10-03T21:00' } })
    fireEvent.change(screen.getByLabelText('End of the release'), { target: { value: '2026-10-03T23:30' } })
    expect(lastSteps()[0]!.releaseWindow).toEqual({ start: '2026-10-04T01:00:00.000Z', end: '2026-10-04T03:30:00.000Z' })
    expect(reported.dirty).toHaveBeenLastCalledWith(true)
  })
})

describe('PlanTaskForm: editing the steps', () => {
  it('a new step starts empty; a step can be renamed and removed', async () => {
    const { user, lastSteps } = setup()
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    expect(lastSteps()).toEqual([STEP, { title: '', validationWindow: { start: '', end: '' }, releaseWindow: { start: '', end: '' } }])
    expect(screen.getByText('Step 2')).toBeInTheDocument()
    const titles = screen.getAllByLabelText('Title *')
    await user.type(titles[1]!, 'Web tier')
    expect(lastSteps()[1]!.title).toBe('Web tier')
    // An empty window shows an empty field, not a wrong date.
    expect(screen.getAllByLabelText('End of the release')[1]).toHaveValue('')
    // The remove button of the FIRST step removes the first step only.
    await user.click(screen.getByRole('button', { name: 'Remove step 1' }))
    expect(lastSteps().map((s) => s.title)).toEqual(['Web tier'])
  })

  // Found in the tour of 23 Sep 2026, fixed: the remove button held only an
  // icon, so a screen reader announced a nameless «button» on every step.
  it('each remove button is named after the step it removes', () => {
    setup({ steps: [STEP, { ...STEP, title: 'Web tier' }] })
    expect(screen.getAllByRole('button', { name: /^Remove step/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Remove step 1', 'Remove step 2'])
  })

  it('a changed plan that is complete can be saved; saving is the page\'s job', async () => {
    const { user, onSave } = setup({ dirty: true })
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('an unchanged plan, or an incomplete one, offers no save', () => {
    const { unmount } = setup()
    expect(screen.queryByRole('button', { name: 'Save plan' })).not.toBeInTheDocument()
    unmount()
    setup({ dirty: true, steps: [{ ...STEP, title: '   ' }] })
    expect(screen.queryByRole('button', { name: 'Save plan' })).not.toBeInTheDocument()
  })
})

describe('PlanTaskForm: completing the plan', () => {
  it('a saved, complete plan can be completed', async () => {
    const { user, onComplete } = setup()
    expect(complete()).toBeEnabled()
    await user.click(complete())
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('an unsaved change must be saved first, and the button says so', () => {
    setup({ dirty: true })
    expect(complete()).toBeDisabled()
    expect(screen.getByText('Save your changes before completing')).toBeInTheDocument()
  })

  it('every window of every step is needed, and a plan with no step is not a plan', () => {
    const { unmount } = setup({ steps: [{ ...STEP, releaseWindow: { start: STEP.releaseWindow.start, end: '' } }] })
    expect(complete()).toBeDisabled()
    expect(screen.getByText('Fill in every step before completing')).toBeInTheDocument()
    unmount()
    setup({ steps: [] })
    expect(complete()).toBeDisabled()
    expect(screen.getByText('Fill in every step before completing')).toBeInTheDocument()
  })

  it('another team can read the plan but not change or complete it', () => {
    setup({ canEdit: false })
    expect(screen.getByLabelText('Title *')).toBeDisabled()
    expect(screen.getByLabelText(/^Validation \*/)).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Add step' })).not.toBeInTheDocument()
    expect(complete()).toBeDisabled()
    expect(screen.getByText('You are not in the right team')).toBeInTheDocument()
  })

  it('a completed plan is read-only and has nothing left to do', () => {
    setup({ status: 'completed', dirty: true })
    expect(screen.getByLabelText('Title *')).toBeDisabled()
    expect(screen.getByLabelText('End of the release')).toBeDisabled()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('while the plan is saved or completed, "Complete" waits and says what for', () => {
    setup({ busyLabel: 'Completing…' })
    expect(screen.getByRole('button', { name: 'Completing…' })).toBeDisabled()
  })
})
