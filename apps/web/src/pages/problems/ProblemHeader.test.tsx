/**
 * THE HEADER OF A PROBLEM.
 *
 * The first thing read on a problem: its title, its priority, the step it is
 * in, the number people quote on the phone, and the buttons that move it
 * along. What would mislead a reader if it broke:
 *  - the priority and the step must read with the CUSTOMER's words (the
 *    Dictionary label, the label the admin wrote on the step), not the
 *    internal values — with the raw value as the honest fallback;
 *  - the number shown is the ticket number, not the internal id;
 *  - each transition hands itself to the page, cannot be pressed twice while
 *    one runs, and one that ends the problem badly looks dangerous.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { withVocabularyLabels } from '@/test/vocabularies'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const { ProblemHeader } = await import('./ProblemHeader')

const step = (name: string, label: string, category: string, order: number, over: Record<string, unknown> = {}) => ({
  id: `s-${name}`, name, label, labels: [], type: 'standard', isInitial: order === 1, isTerminal: false, isOpen: true,
  category, purpose: null, order, ...over,
})

const PROBLEM = { id: 'prb-uuid-1', number: 'PRB00000007', title: 'Checkout times out', priority: 'critical', status: 'under_investigation' }

const TRANSITIONS = [
  { toStep: 'known_error', label: 'Known error', requiresInput: false, inputField: null, condition: null },
  { toStep: 'rejected',    label: 'Reject',      requiresInput: true,  inputField: 'notes', condition: null },
]

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetWorkflowDefinition'] = { workflowDefinition: { steps: [
    step('new', 'New', 'active', 1),
    step('under_investigation', 'Under investigation', 'active', 2),
    step('known_error', 'Known error', 'waiting', 3),
    step('rejected', 'Rejected', 'failed', 4, { isTerminal: true, isOpen: false }),
  ] } }
})

function mount(over: { problem?: Partial<typeof PROBLEM>; transitions?: typeof TRANSITIONS; transitioning?: boolean; dictionaryLoaded?: boolean } = {}) {
  const onBack = vi.fn()
  const onTransitionClick = vi.fn()
  const header = (
    <ProblemHeader
      problem={{ ...PROBLEM, ...over.problem }}
      manualTransitions={over.transitions ?? TRANSITIONS}
      transitioning={over.transitioning ?? false}
      onBack={onBack}
      onTransitionClick={onTransitionClick}
    />
  )
  const r = renderWithProviders(over.dictionaryLoaded === false ? header : withVocabularyLabels(header, { priority: { critical: 'Critical' } }))
  return { ...r, onBack, onTransitionClick }
}

describe('ProblemHeader', () => {
  it('shows the title, the priority label, the step label and the ticket number (not the id)', () => {
    mount()
    expect(apolloFinto.chiamata('GetWorkflowDefinition')).toEqual({ entityType: 'problem' })
    expect(screen.getByRole('heading', { level: 1, name: 'Checkout times out' })).toBeInTheDocument()
    expect(screen.getByText('Critical')).toBeInTheDocument()
    expect(screen.getByText('Under investigation')).toBeInTheDocument()
    expect(screen.getByText('PRB00000007')).toBeInTheDocument()
    expect(screen.queryByText('prb-uuid-1')).not.toBeInTheDocument()
  })

  it('before the Dictionary is known the priority reads as its value, and a step no workflow declares as its name', () => {
    // The neutral style of a value whose vocabulary is unknown is announced on the console: expected here.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount({ problem: { status: 'waiting_for_vendor' }, dictionaryLoaded: false })
    expect(screen.getByText('critical')).toBeInTheDocument()
    // The true value, never a blank pill (with or without its underscores).
    expect(screen.getByText(/^waiting[_ ]for[_ ]vendor$/)).toBeInTheDocument()
  })

  it('Back hands the navigation to the page', async () => {
    const { user, onBack } = mount()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('each transition is a button that hands itself to the page', async () => {
    const { user, onTransitionClick } = mount()
    await user.click(screen.getByRole('button', { name: 'Known error' }))
    expect(onTransitionClick).toHaveBeenCalledWith(TRANSITIONS[0])
  })

  it('a transition that ends the problem badly is drawn as danger', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveStyle({ backgroundColor: 'var(--color-danger)' })
    expect(screen.getByRole('button', { name: 'Known error' })).not.toHaveStyle({ backgroundColor: 'var(--color-danger)' })
  })

  it('a transition towards a step the workflow does not describe keeps the plain action style (sugar-paper, 26 Sep 2026)', () => {
    mount({ transitions: [{ toStep: 'escalated_to_vendor', label: 'Escalate', requiresInput: false, inputField: null, condition: null }] })
    expect(screen.getByRole('button', { name: 'Escalate' })).toHaveStyle({ backgroundColor: 'var(--color-section-head)' })
  })

  it('while a transition runs, none can be pressed', () => {
    mount({ transitioning: true })
    expect(screen.getByRole('button', { name: 'Known error' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled()
  })

  it('with no transition available there is no action row, only the way back', () => {
    mount({ transitions: [] })
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Back'])
  })
})
