/**
 * THE CHANGE INFORMATION CARD.
 *
 * The first card on a change: what it is (number, title, why, what, owner,
 * requester, dates), how risky it is, how far its per-CI tasks have got, and
 * the buttons that move it along the workflow. The card only draws; the page
 * decides. What is pinned here is what a reader would misread if it broke:
 *  - an absent owner, requester, why or what is left out, not shown empty;
 *  - a change whose risk is not assessed yet SAYS so, next to a priority that
 *    is only provisional;
 *  - the transition buttons appear only for who may move the change by hand,
 *    and never during the approval step (that is what approvals are for);
 *    a transition that ends the change badly looks dangerous;
 *  - a finished change says it is completed, a step with no action says it is
 *    in progress instead of leaving an empty row.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { withVocabularyLabels } from '@/test/vocabularies'
import type { AvailableTransition, ChangeData } from '@/types/change'
import { ChangeInfoCard } from './ChangeInfoCard'

const change = (over: Partial<ChangeData> = {}): ChangeData => ({
  id: 'chg-1', code: 'CHG00000042', title: 'Upgrade the orders database',
  why: 'Version 14 goes out of support', what: 'Move to PostgreSQL 16',
  aggregateRiskScore: 42, priority: 'high',
  approvalRoute: null, approvalStatus: null, approvalAt: null,
  createdAt: '2026-09-14T08:00:00Z', updatedAt: '2026-09-20T08:00:00Z',
  requester: { id: 'u-r', name: 'Rita Requester' }, changeOwner: { id: 'u-o', name: 'Oscar Owner' }, approvalBy: null,
  workflowInstance: { id: 'wi-1', currentStep: 'assessment', status: 'running' },
  availableTransitions: [],
  ...over,
})

const TRANSITIONS: AvailableTransition[] = [
  { toStep: 'approval',  label: 'Send to approval', requiresInput: false, inputField: null, condition: null },
  { toStep: 'cancelled', label: 'Cancel the change', requiresInput: true, inputField: 'notes', condition: null },
]

type Props = React.ComponentProps<typeof ChangeInfoCard>

function mount(over: Partial<Props> = {}) {
  const onTransitionClick = vi.fn()
  const props: Props = {
    change: change(), currentStep: 'assessment', atApproval: false, initialStepName: 'assessment',
    isTerminal: false, actsForAnyTeam: true, transitioning: false, totalTasks: 6, completedTasks: 3,
    transitions: TRANSITIONS, stepLabel: 'Assessment', onTransitionClick,
    categoryOf: (step) => (step === 'cancelled' ? 'failed' : 'active'),
    ...over,
  }
  const user = userEvent.setup()
  render(withVocabularyLabels(<ChangeInfoCard {...props} />, { priority: { high: 'High' } }))
  return { user, onTransitionClick }
}

/** The value written under a field label. */
const field = (label: string) => screen.getByText(label, { selector: 'div' }).nextElementSibling?.textContent

describe('ChangeInfoCard — what the change is', () => {
  it('shows number, title, why, what, owner, requester and the two dates', () => {
    mount()
    expect(screen.getByRole('button', { name: /Change information/ })).toHaveAttribute('aria-expanded', 'true')
    expect(field('Ticket number')).toBe('CHG00000042')
    expect(field('Title')).toBe('Upgrade the orders database')
    expect(field('Why')).toBe('Version 14 goes out of support')
    expect(field('What')).toBe('Move to PostgreSQL 16')
    expect(field('Change owner')).toBe('Oscar Owner')
    expect(field('Requester')).toBe('Rita Requester')
    expect(field('Created')).toBe('14 Sept 2026')
    expect(field('Updated')).toBe('20 Sept 2026')
  })

  it('leaves out why, what, owner and requester when the change has none', () => {
    mount({ change: change({ why: null, what: '', changeOwner: null, requester: null }) })
    for (const label of ['Why', 'What', 'Change owner', 'Requester']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('shows the priority with the customer label, keeping the value in the tooltip', () => {
    mount()
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.getByText('High')).toHaveAttribute('title', 'high')
  })

  it('without a priority there is no priority badge', () => {
    mount({ change: change({ priority: null }) })
    expect(screen.queryByText('Priority')).not.toBeInTheDocument()
  })

  it('shows the aggregate risk once assessed, and says so while it is not', () => {
    mount()
    expect(screen.getByTitle('score 42')).toHaveTextContent('42')
    expect(screen.queryByTestId('risk-not-assessed')).not.toBeInTheDocument()
  })

  it('a change whose risk is not assessed yet says the priority comes from the type', () => {
    mount({ change: change({ aggregateRiskScore: null }) })
    expect(screen.getByTestId('risk-not-assessed')).toHaveTextContent('Risk not yet assessed: priority from the change type')
  })
})

describe('ChangeInfoCard — progress of the per-CI tasks', () => {
  it('at the initial step it shows how many per-CI tasks are done, as text and as a bar', () => {
    mount()
    const label = screen.getByText('3/6 per-CI tasks completed')
    const bar = label.previousElementSibling?.firstElementChild as HTMLElement
    expect(bar.style.width).toBe('50%')
  })

  it('with no task yet the bar is empty, not broken', () => {
    mount({ totalTasks: 0, completedTasks: 0 })
    const label = screen.getByText('0/0 per-CI tasks completed')
    expect((label.previousElementSibling?.firstElementChild as HTMLElement).style.width).toBe('0%')
  })

  it('past the initial step the progress is no longer shown', () => {
    mount({ currentStep: 'implementation' })
    expect(screen.queryByText(/per-CI tasks completed/)).not.toBeInTheDocument()
  })
})

describe('ChangeInfoCard — moving the change', () => {
  it('who acts for any team gets one button per transition, and a click hands the transition to the page', async () => {
    const { user, onTransitionClick } = mount()
    await user.click(screen.getByRole('button', { name: 'Send to approval' }))
    expect(onTransitionClick).toHaveBeenCalledWith(TRANSITIONS[0])
  })

  it('a transition towards a failed step is drawn as danger, the others as the primary action', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Cancel the change' })).toHaveStyle({ backgroundColor: 'var(--color-danger)' })
    expect(screen.getByRole('button', { name: 'Send to approval' })).toHaveStyle({ backgroundColor: 'var(--color-brand)' })
  })

  it('without the categories of the steps every transition keeps the primary style', () => {
    mount({ categoryOf: undefined })
    expect(screen.getByRole('button', { name: 'Cancel the change' })).toHaveStyle({ backgroundColor: 'var(--color-brand)' })
  })

  it('while a transition runs the buttons cannot be pressed again', () => {
    mount({ transitioning: true })
    expect(screen.getByRole('button', { name: 'Send to approval' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel the change' })).toBeDisabled()
  })

  it('who cannot act for any team gets no transition buttons', () => {
    mount({ actsForAnyTeam: false })
    expect(screen.queryByRole('button', { name: 'Send to approval' })).not.toBeInTheDocument()
  })

  it('during the approval step no one moves the change by hand: the approvals do', () => {
    mount({ atApproval: true })
    expect(screen.queryByRole('button', { name: 'Send to approval' })).not.toBeInTheDocument()
  })

  it('a finished change says it is completed', () => {
    mount({ isTerminal: true, transitions: [], currentStep: 'closed' })
    expect(screen.getByText('✓ Completed')).toBeInTheDocument()
    expect(screen.queryByText(/in progress/)).not.toBeInTheDocument()
  })

  it('a step with no action available says the step is in progress, instead of an empty row', () => {
    mount({ transitions: [], currentStep: 'implementation', stepLabel: 'Implementation' })
    expect(screen.getByText('Implementation in progress')).toBeInTheDocument()
    expect(screen.queryByText('✓ Completed')).not.toBeInTheDocument()
  })

  it('a change with no workflow step says nothing about progress', () => {
    mount({ transitions: [], currentStep: '', initialStepName: null })
    expect(screen.queryByText(/in progress/)).not.toBeInTheDocument()
  })
})
