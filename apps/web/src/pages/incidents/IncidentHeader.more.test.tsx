/**
 * The incident header is where an operator moves the incident along its
 * workflow. The transition buttons must hand back the EXACT transition that
 * was clicked (the page uses its `requiresInput`/`inputField` to decide
 * whether to ask for a resolution note), must be unclickable while a
 * transition is already running (a double click would fire two moves), and
 * «Back» / «Request a change» must reach their handlers.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { IncidentHeader } from './IncidentHeader'
import { renderWithProviders } from '@/test/utils'
import { workflowDefinitionMock, type WorkflowStepMock } from '@/test/mocks/gql'

const STEPS: WorkflowStepMock[] = [
  { name: 'new',         label: 'New',         category: 'active',   isInitial: true, isTerminal: false, isOpen: true },
  { name: 'in_progress', label: 'In progress', category: 'active',   isTerminal: false, isOpen: true },
  { name: 'resolved',    label: 'Resolved',    category: 'resolved', isTerminal: true,  isOpen: false },
]

const TRANSITIONS = [
  { toStep: 'in_progress', label: 'Take in charge', requiresInput: false, inputField: null, condition: null },
  { toStep: 'resolved',    label: 'Resolve',        requiresInput: true,  inputField: 'resolution_note', condition: null },
  // A step the workflow does not know (yet): the button still appears with the default style.
  { toStep: 'ghost',       label: 'Somewhere else', requiresInput: false, inputField: null, condition: null },
]

function render(opts: { transitioning?: boolean; status?: string; transitions?: typeof TRANSITIONS } = {}) {
  const handlers = { onBack: vi.fn(), onTransitionClick: vi.fn(), onRequestChange: vi.fn() }
  const utils = renderWithProviders(
    <IncidentHeader
      incident={{
        id: 'inc-1', number: 'INC00000042', title: 'Mail relay down', severity: 'high', status: opts.status ?? 'new',
        workflowInstance: { id: 'wi-1', currentStep: opts.status ?? 'new', status: 'active' }, availableTransitions: [],
      }}
      manualTransitions={opts.transitions ?? TRANSITIONS}
      transitioning={opts.transitioning ?? false}
      {...handlers}
    />,
    { mocks: [workflowDefinitionMock('incident', STEPS)] },
  )
  return { ...utils, ...handlers }
}

describe('IncidentHeader — actions', () => {
  it('shows the number and the title', async () => {
    render()
    expect(await screen.findByRole('heading', { level: 1, name: 'INC00000042' })).toBeInTheDocument()
    expect(screen.getByText('Mail relay down')).toBeInTheDocument()
  })

  it('a transition button hands back the exact transition clicked', async () => {
    const { user, onTransitionClick } = render()
    await user.click(await screen.findByRole('button', { name: 'Resolve' }))
    // The whole object: the page reads requiresInput/inputField to open the resolution prompt.
    expect(onTransitionClick).toHaveBeenCalledWith(TRANSITIONS[1])
    await user.click(screen.getByRole('button', { name: 'Somewhere else' }))
    expect(onTransitionClick).toHaveBeenLastCalledWith(TRANSITIONS[2])
  })

  it('while a transition is running every transition button is disabled', async () => {
    const { user, onTransitionClick } = render({ transitioning: true })
    const buttons = await Promise.all(TRANSITIONS.map((t) => screen.findByRole('button', { name: t.label })))
    for (const b of buttons) {
      expect(b).toBeDisabled()
      expect(b).toHaveStyle({ cursor: 'not-allowed' })
    }
    await user.click(buttons[0])
    expect(onTransitionClick).not.toHaveBeenCalled()
  })

  it('«Back» and «Request a change» reach their handlers', async () => {
    const { user, onBack, onRequestChange } = render()
    await user.click(screen.getByRole('button', { name: /Back/ }))
    expect(onBack).toHaveBeenCalledTimes(1)
    await user.click(await screen.findByRole('button', { name: 'Request a change' }))
    expect(onRequestChange).toHaveBeenCalledTimes(1)
  })

  it('a concluded incident with no manual transitions shows no action row at all', async () => {
    render({ status: 'resolved', transitions: [] })
    await screen.findByRole('heading', { level: 1 })
    // Waits for the workflow metadata: «concluded» is read from the step, not from its name.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Request a change' })).not.toBeInTheDocument())
    expect(screen.getAllByRole('button')).toHaveLength(1)   // only «Back»
  })
})
