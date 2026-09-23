/**
 * THE RISK ASSESSMENT OF A CI, ONE QUESTION AT A TIME.
 *
 * The owner and the support team of every CI a change touches answer a
 * weighted questionnaire; the answers make the CI's risk score, which decides
 * how the change is approved. So the form must show each question with its
 * weight and the answer already given, send an answer as soon as it is
 * chosen (never the "Choose" placeholder), and allow completing only when
 * every question has an answer — and only to the team the task belongs to.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AssessmentTaskData, QuestionData } from '@/types/change'
import { AssessmentTaskForm } from './AssessmentTaskForm'

const question = (id: string, text: string, options: Array<[string, string]>): QuestionData => ({
  id, text, category: 'functional', isCore: true, isActive: true, createdAt: '2026-09-01T00:00:00Z',
  options: options.map(([oid, label], i) => ({ id: oid, label, score: i + 1, sortOrder: i })),
})
const CATALOG = [
  { weight: 3, sortOrder: 1, question: question('q-users', 'How many users are affected?', [['o-few', 'A few'], ['o-all', 'Everyone']]) },
  { weight: 1, sortOrder: 2, question: question('q-rollback', 'Can it be rolled back?', [['o-yes', 'Yes'], ['o-no', 'No']]) },
]

const task = (over: Partial<AssessmentTaskData> = {}): AssessmentTaskData => ({
  id: 'at-1', code: 'TASK-1', responderRole: 'owner', status: 'in-progress', score: null,
  completedBy: null, completedAt: null, assignedTeam: null, assignee: null,
  responses: [{ question: { id: 'q-users', text: 'How many users are affected?', category: 'functional' }, selectedOption: { id: 'o-all', label: 'Everyone', score: 2 } }],
  ...over,
})

function setup(props: Partial<Parameters<typeof AssessmentTaskForm>[0]> = {}) {
  const onSubmitAnswer = vi.fn()
  const onComplete = vi.fn()
  render(<AssessmentTaskForm task={task()} catalog={CATALOG} canEdit onSubmitAnswer={onSubmitAnswer} onComplete={onComplete} {...props} />)
  return { onSubmitAnswer, onComplete, user: userEvent.setup() }
}

describe('AssessmentTaskForm', () => {
  it('shows every question with its weight and the answer already given', () => {
    setup()
    expect(screen.getByText('Weight 3')).toHaveAttribute('title', 'How much this answer counts in the CI risk score')
    expect(screen.getByText('Weight 1')).toBeInTheDocument()
    const users = screen.getByRole('combobox', { name: 'How many users are affected?' })
    expect(users).toHaveValue('o-all')
    expect(within(users).getAllByRole('option').map((o) => o.textContent)).toEqual(['— Choose —', 'A few', 'Everyone'])
    expect(screen.getByRole('combobox', { name: 'Can it be rolled back?' })).toHaveValue('')
  })

  it('an answer is sent as soon as it is chosen; the placeholder is never sent', async () => {
    const { onSubmitAnswer, user } = setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Can it be rolled back?' }), 'o-no')
    expect(onSubmitAnswer).toHaveBeenCalledWith('q-rollback', 'o-no')
    await user.selectOptions(screen.getByRole('combobox', { name: 'How many users are affected?' }), '')
    expect(onSubmitAnswer).toHaveBeenCalledTimes(1)
  })

  it('completing waits for every answer, and counts them', async () => {
    const { onComplete, user } = setup()
    expect(screen.getByRole('button', { name: 'Complete (1/2)' })).toBeDisabled()
    expect(screen.queryByText('You are not in the right team to complete this task')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Complete (1/2)' }))
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('with every answer given, the task can be completed', async () => {
    const { onComplete, user } = setup({
      task: task({ responses: [
        ...task().responses,
        { question: { id: 'q-rollback', text: 'Can it be rolled back?', category: 'functional' }, selectedOption: { id: 'o-yes', label: 'Yes', score: 1 } },
      ] }),
    })
    await user.click(screen.getByRole('button', { name: 'Complete (2/2)' }))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('another team can read but not answer or complete, and is told why', () => {
    setup({ canEdit: false })
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Complete (1/2)' })).toBeDisabled()
    expect(screen.getByText('You are not in the right team to complete this task')).toBeInTheDocument()
  })

  it('a completed assessment is read-only and has nothing left to complete', () => {
    setup({ task: task({ status: 'completed' }) })
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('while an answer is being saved, "Complete" waits and says what for', () => {
    setup({ busyLabel: 'Saving...' })
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
  })
})
