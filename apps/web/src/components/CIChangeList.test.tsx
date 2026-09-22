/**
 * The "Changes" card on a CI detail page. An operator uses it to see what is
 * being changed on this CI right now versus what already happened. If the
 * split between "In progress" and "Completed" regresses, a finished change
 * looks live (or a live one looks finished); the split must follow the
 * TERMINAL flag of the tenant's workflow, never a hard-coded step name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { CIChangeList } from './CIChangeList'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const step = (name: string, label: string, isTerminal: boolean, order: number) => ({
  id: name, name, label, labels: [], type: 'standard', isInitial: order === 1, isTerminal, isOpen: !isTerminal, category: null, purpose: null, order,
})

const change = (id: string, code: string, currentStep: string | null, aggregateRiskScore: number | null = null) => ({
  id, code, title: `Title of ${code}`, workflowInstance: currentStep === null ? null : { currentStep },
  aggregateRiskScore, approvalStatus: null, createdAt: '2026-09-01T00:00:00Z',
})

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [
    step('assessment', 'Assessment', false, 1),
    step('done', 'Done', true, 2),
  ], transitions: [] } }
})

describe('CIChangeList', () => {
  it('starts collapsed with the total count, and opens on click', async () => {
    apolloFinto.risposte['GetCIChanges'] = { ciChanges: [change('c1', 'CHG1', 'assessment')] }
    const { user } = renderWithProviders(<CIChangeList ciId="ci-9" />)
    const header = screen.getByRole('button', { name: /Changes/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(header).toHaveTextContent('1')
    expect(screen.queryByText('CHG1')).not.toBeInTheDocument()
    // The list is asked for THIS CI.
    expect(apolloFinto.chiamata('GetCIChanges')).toEqual({ ciId: 'ci-9' })
    await user.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('CHG1')).toBeInTheDocument()
    await user.click(header)
    expect(screen.queryByText('CHG1')).not.toBeInTheDocument()
  })

  it('groups changes by whether their step is terminal, with the step label', async () => {
    apolloFinto.risposte['GetCIChanges'] = { ciChanges: [
      change('c1', 'CHG1', 'assessment', 42),
      change('c2', 'CHG2', 'done'),
      change('c3', 'CHG3', null),
    ] }
    const { user } = renderWithProviders(<CIChangeList ciId="ci-1" />)
    await user.click(screen.getByRole('button', { name: /Changes/ }))
    const inProgress = screen.getByText('In progress').parentElement!
    const completed = screen.getByText('Completed').parentElement!
    expect(within(inProgress).getByText('CHG1')).toBeInTheDocument()
    expect(within(inProgress).getByText('Assessment')).toBeInTheDocument()
    // A change without a workflow instance is not "finished".
    expect(within(inProgress).getByText('CHG3')).toBeInTheDocument()
    expect(within(completed).getByText('CHG2')).toBeInTheDocument()
    expect(within(completed).getByText('Done')).toBeInTheDocument()
    // The risk score is shown only when the change has one.
    expect(within(inProgress).getByText('42')).toBeInTheDocument()
  })

  it('omits an empty group instead of showing a heading with nothing under it', async () => {
    apolloFinto.risposte['GetCIChanges'] = { ciChanges: [change('c2', 'CHG2', 'done')] }
    const { user } = renderWithProviders(<CIChangeList ciId="ci-1" />)
    await user.click(screen.getByRole('button', { name: /Changes/ }))
    expect(screen.queryByText('In progress')).not.toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('says so when the CI has no change', async () => {
    apolloFinto.risposte['GetCIChanges'] = { ciChanges: [] }
    const { user } = renderWithProviders(<CIChangeList ciId="ci-1" />)
    await user.click(screen.getByRole('button', { name: /Changes/ }))
    expect(screen.getByText('No change on this CI.')).toBeInTheDocument()
  })

  it('a row opens the change detail', async () => {
    apolloFinto.risposte['GetCIChanges'] = { ciChanges: [change('c1', 'CHG1', 'assessment')] }
    const { user } = renderWithProviders(<CIChangeList ciId="ci-1" />)
    await user.click(screen.getByRole('button', { name: /Changes/ }))
    await user.click(screen.getByRole('button', { name: /CHG1/ }))
    await attendiURL('/changes/c1')
  })
})
