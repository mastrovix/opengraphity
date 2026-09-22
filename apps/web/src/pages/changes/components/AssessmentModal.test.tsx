/**
 * The two assessments (functional / technical) of a CI must stay blind to each
 * other: while either is still open, the answers are hidden, otherwise the
 * second assessor would just copy the first. Once both are done, every answer
 * and the total score must be readable, with a dash while the score is not
 * computed yet (never "null").
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssessmentModal } from './AssessmentModal'
import type { AssessmentTaskData } from '@/types/change'

const task = (over: Partial<AssessmentTaskData> = {}): AssessmentTaskData => ({
  id: 't1', code: 'ASM-1', responderRole: 'functional', status: 'completed', score: 7,
  completedBy: null, completedAt: null, assignedTeam: null, assignee: null,
  responses: [
    { question: { id: 'q1', text: 'Is there downtime?', category: 'impact' }, selectedOption: { id: 'o1', label: 'Yes, short', score: 3 } },
    { question: { id: 'q2', text: 'Is rollback tested?', category: 'risk' }, selectedOption: { id: 'o2', label: 'No', score: 4 } },
  ],
  ...over,
})

describe('AssessmentModal', () => {
  it('hides the answers until both assessments are done', () => {
    render(<AssessmentModal task={task()} ciName="web-01" roleLabel="Functional" bothAssessDone={false} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Functional answers — web-01' })).toBeInTheDocument()
    expect(screen.getByText('The answers become visible when both assessments are complete.')).toBeInTheDocument()
    expect(screen.queryByText('Is there downtime?')).not.toBeInTheDocument()
  })

  it('shows every answer with its weight and the total score', () => {
    render(<AssessmentModal task={task()} ciName="web-01" roleLabel="Functional" bothAssessDone onClose={() => {}} />)
    expect(screen.getByText('Is there downtime?')).toBeInTheDocument()
    expect(screen.getByText('Yes, short (3)')).toBeInTheDocument()
    expect(screen.getByText('W:4')).toBeInTheDocument()
    expect(screen.getByText('Score: 7')).toBeInTheDocument()
  })

  it('a score not computed yet reads as a dash; Close closes', async () => {
    const onClose = vi.fn()
    render(<AssessmentModal task={task({ score: null, responses: [] })} ciName="web-01" roleLabel="Technical" bothAssessDone onClose={onClose} />)
    expect(screen.getByText('Score: —')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })
})
