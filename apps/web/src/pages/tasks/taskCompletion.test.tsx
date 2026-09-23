/**
 * A TASK IS COMPLETED ONCE (D24, tour of 23 Sep 2026).
 *
 * «Complete (5/5)» stayed enabled while the completion was on its way — it can
 * take seconds — and a second click came back as the red toast «This task is
 * already completed». Pinned here:
 *  - the hook knows when a completion, an answer or a plan save is in flight;
 *  - every completion button waits while one is, and says what it waits for.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MockedProvider } from '@apollo/client/testing/react'
import { COMPLETE_ASSESSMENT_TASK, SUBMIT_ASSESSMENT_RESPONSE, COMPLETE_VALIDATION_TEST } from '@/graphql/mutations'
import type { GqlMock } from '@/test/utils'
import { useTaskMutations } from './useTaskMutations'
import { StickyAction } from './components/shared'
import { ValidationTaskForm } from './components/ValidationTaskForm'
import { ReviewTaskForm } from './components/ReviewTaskForm'
import { DeploymentTaskForm } from './components/DeploymentTaskForm'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }))

const task = { __typename: 'AssessmentTask', id: 'tk-1', status: 'completed', score: 3, completedAt: '2026-09-23T10:00:00Z' }
const mocks: GqlMock[] = [
  { request: { query: COMPLETE_ASSESSMENT_TASK, variables: { taskId: 'tk-1' } }, result: { data: { completeAssessmentTask: task } }, delay: 30 },
  { request: { query: SUBMIT_ASSESSMENT_RESPONSE, variables: { taskId: 'tk-1', questionId: 'q1', optionId: 'o1' } }, result: { data: { submitAssessmentResponse: { ...task, status: 'in-progress' } } }, delay: 30 },
  {
    request: { query: COMPLETE_VALIDATION_TEST, variables: { changeId: 'c1', ciId: 'ci1', result: 'pass' } },
    result: { data: { completeValidationTest: { __typename: 'ValidationTest', id: 'v1', status: 'completed', result: 'pass', testedAt: '2026-09-23T10:00:00Z' } } },
    delay: 30,
  },
]
const wrapper = ({ children }: { children: ReactNode }) => <MockedProvider mocks={mocks}>{children}</MockedProvider>

describe('useTaskMutations — what is in flight', () => {
  it('a completion sets `completing` until the server answers, then the page moves on', async () => {
    const goToChange = vi.fn()
    const { result } = renderHook(() => useTaskMutations({ refetchAll: vi.fn(async () => {}), goToChange }), { wrapper })
    expect(result.current.completing).toBe(false)
    act(() => { void result.current.completeAssess({ variables: { taskId: 'tk-1' } }) })
    await waitFor(() => expect(result.current.completing).toBe(true))
    await waitFor(() => expect(result.current.completing).toBe(false))
    expect(goToChange).toHaveBeenCalledTimes(1)
  })

  it('a validation result is a completion too', async () => {
    const { result } = renderHook(() => useTaskMutations({ refetchAll: vi.fn(async () => {}), goToChange: vi.fn() }), { wrapper })
    act(() => { void result.current.completeVal({ variables: { changeId: 'c1', ciId: 'ci1', result: 'pass' } }) })
    await waitFor(() => expect(result.current.completing).toBe(true))
    await waitFor(() => expect(result.current.completing).toBe(false))
  })

  it('an answer being saved sets `saving`, and the page re-reads the task after it', async () => {
    const refetchAll = vi.fn(async () => {})
    const { result } = renderHook(() => useTaskMutations({ refetchAll, goToChange: vi.fn() }), { wrapper })
    act(() => { void result.current.submitAnswer({ variables: { taskId: 'tk-1', questionId: 'q1', optionId: 'o1' } }) })
    await waitFor(() => expect(result.current.saving).toBe(true))
    expect(result.current.completing).toBe(false)
    await waitFor(() => expect(result.current.saving).toBe(false))
    expect(refetchAll).toHaveBeenCalled()
  })
})

describe('the completion buttons wait', () => {
  it('StickyAction: disabled, busy, and saying what it waits for', () => {
    const onClick = vi.fn()
    const { rerender } = render(<StickyAction label="Complete (5/5)" disabled={false} onClick={onClick} />)
    expect(screen.getByRole('button', { name: 'Complete (5/5)' })).toBeEnabled()
    rerender(<StickyAction label="Complete (5/5)" disabled={false} onClick={onClick} busyLabel="Completing…" />)
    const button = screen.getByRole('button', { name: 'Completing…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('validation: the pressed result says it is completing, the other waits too', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    const { rerender } = render(<ValidationTaskForm canEdit onComplete={onComplete} />)
    await user.click(screen.getByRole('button', { name: 'Pass' }))
    expect(onComplete).toHaveBeenCalledWith('pass')
    rerender(<ValidationTaskForm canEdit onComplete={onComplete} busyLabel="Completing…" />)
    expect(screen.getByRole('button', { name: 'Completing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Fail' })).toBeDisabled()
    // Back to normal when the completion failed: the buttons are usable again.
    rerender(<ValidationTaskForm canEdit onComplete={onComplete} busyLabel={null} />)
    expect(screen.getByRole('button', { name: 'Pass' })).toBeEnabled()
  })

  it('review: the same, for confirmed / rejected', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    const { rerender } = render(<ReviewTaskForm canEdit onComplete={onComplete} />)
    await user.click(screen.getByRole('button', { name: 'Rejected' }))
    expect(onComplete).toHaveBeenCalledWith('rejected')
    rerender(<ReviewTaskForm canEdit onComplete={onComplete} busyLabel="Completing…" />)
    expect(screen.getByRole('button', { name: 'Completing…' })).toBeDisabled()
    expect(screen.getAllByRole('button').every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('deployment: one button, waiting while the completion is in flight', () => {
    const { rerender } = render(<DeploymentTaskForm canEdit onComplete={vi.fn()} />)
    expect(screen.getAllByRole('button')[0]).toBeEnabled()
    rerender(<DeploymentTaskForm canEdit onComplete={vi.fn()} busyLabel="Completing…" />)
    expect(screen.getByRole('button', { name: 'Completing…' })).toBeDisabled()
  })

  it('a team that may not act still cannot, busy or not', () => {
    render(<ValidationTaskForm canEdit={false} onComplete={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Pass' })).toBeDisabled()
  })
})
