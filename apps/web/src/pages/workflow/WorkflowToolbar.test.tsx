/**
 * THE WORKFLOW DESIGNER TOOLBAR: the way back to the list, the workflow's
 * name and version, "Save changes" with the number of pending changes, and
 * the dialog that adds a step.
 *
 * What an administrator relies on:
 *  - "Save changes" is on only when there is something to save, and says how
 *    many changes are waiting;
 *  - a PROCESS step is named after its label, because that name becomes the
 *    status of every ticket that enters the step — a label that yields no
 *    usable name ("!!!") is refused before it reaches the server;
 *  - a timer wait gets a technical name of its own and its delay in minutes;
 *  - the dialog explains what to do with a new process step, closes and
 *    reloads the workflow once the step is added, and stays open with the
 *    reason when adding fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { attendiURL, renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { WorkflowToolbar } from './WorkflowToolbar'
import type { WorkflowDefinition } from './workflow-types'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const DEF: WorkflowDefinition = { id: 'wf-1', name: 'Incident Management', entityType: 'incident', version: 3, active: true, steps: [], transitions: [] }

beforeEach(() => {
  apolloFinto.reset()
  toast.success.mockReset()
  toast.error.mockReset()
})

type Props = ComponentProps<typeof WorkflowToolbar>

function toolbar(over: Partial<Props> = {}) {
  const props: Props = { def: DEF, hasChanges: false, pendingCount: 0, onSave: vi.fn(), onRefetch: vi.fn(), ...over }
  const r = renderWithProviders(<WorkflowToolbar {...props} />, { route: '/workflow/wf-1' })
  return { ...r, props }
}

const saveChanges = () => screen.getByRole('button', { name: /Save changes/ })

async function openAddStep(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.click(screen.getByRole('button', { name: /Step/ }))
  return screen.getByRole('dialog', { name: 'Add a step' })
}

describe('WorkflowToolbar — header', () => {
  it('names the workflow with its active version, and leads back to the list', async () => {
    const { user } = toolbar()
    expect(screen.getByRole('heading', { name: 'Incident Management' })).toBeInTheDocument()
    expect(screen.getByText('v3 · Active')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Workflow' }))
    await attendiURL('/workflow')
  })

  // Review of 23 Sep 2026: the back arrow threw every change kept locally away, without a word.
  it('with changes not saved, going back asks first: stay keeps the page, leave goes', async () => {
    const { user } = toolbar({ pendingCount: 2 })
    await user.click(screen.getByRole('button', { name: 'Workflow' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' })
    expect(dialog).toHaveTextContent('2 changes are kept only here')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/workflow/wf-1')
    await user.click(screen.getByRole('button', { name: 'Workflow' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave' }))
    await attendiURL('/workflow')
  })

  it('without a workflow there is no name, no way to add a step, and nothing to save', () => {
    toolbar({ def: null, hasChanges: true, pendingCount: 1 })
    expect(screen.getByRole('heading')).toHaveTextContent('')
    expect(screen.queryByText(/· Active/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Step/ })).toBeNull()
    expect(saveChanges()).toBeDisabled()
  })

  it('"Save changes" is off with nothing to save', () => {
    toolbar()
    expect(saveChanges()).toBeDisabled()
    expect(saveChanges()).toHaveTextContent(/^Save changes$/)
  })

  it('with pending changes it is on and says how many; a click saves', async () => {
    const { user, props } = toolbar({ pendingCount: 2 })
    expect(saveChanges()).toBeEnabled()
    expect(saveChanges()).toHaveTextContent('Save changes2')
    await user.click(saveChanges())
    expect(props.onSave).toHaveBeenCalledTimes(1)
  })

  it('a moved step alone is a change to save, with no count', () => {
    toolbar({ hasChanges: true })
    expect(saveChanges()).toBeEnabled()
    expect(saveChanges()).toHaveTextContent(/^Save changes$/)
  })
})

describe('WorkflowToolbar — adding a step', () => {
  it('a process step is named after its label; once added the dialog closes and the workflow reloads', async () => {
    const { user, props } = toolbar()
    const dlg = await openAddStep(user)
    expect(within(dlg).getByRole('button', { name: /Step/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dlg).getByText(/It is born «in progress» with no purpose/)).toBeInTheDocument()
    const add = within(dlg).getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    await user.type(within(dlg).getByRole('textbox', { name: 'E.g. Weekly CAB' }), '  Weekly CAB review ')
    await user.click(add)
    expect(apolloFinto.chiamata('AddWorkflowStep')).toEqual({
      definitionId: 'wf-1', name: 'weekly_cab_review', label: 'Weekly CAB review', type: 'standard', timerDelayMinutes: undefined,
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(toast.success).toHaveBeenCalledWith('Step added')
    expect(props.onRefetch).toHaveBeenCalledTimes(1)
  })

  it('a label that gives no usable name cannot be added as a process step; leading digits are dropped', async () => {
    const { user } = toolbar()
    const dlg = await openAddStep(user)
    const label = within(dlg).getByRole('textbox', { name: 'E.g. Weekly CAB' })
    const add = within(dlg).getByRole('button', { name: 'Add' })
    await user.type(label, '!!!')
    expect(add).toBeDisabled()
    await user.clear(label)
    await user.type(label, '2nd-line Review')
    await user.click(add)
    expect(apolloFinto.chiamata('AddWorkflowStep')).toEqual(expect.objectContaining({ name: 'ndline_review', label: '2nd-line Review' }))
  })

  it('a timer wait gets a technical name of its own and its delay in minutes', async () => {
    const { user } = toolbar({ onRefetch: undefined })
    const dlg = await openAddStep(user)
    await user.click(within(dlg).getByRole('button', { name: /Timer wait/ }))
    expect(within(dlg).getByRole('button', { name: /Timer wait/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dlg).queryByText(/It is born «in progress»/)).toBeNull()
    // Punctuation alone is fine here: the name of a timer is not a ticket status.
    await user.type(within(dlg).getByRole('textbox', { name: 'E.g. Waiting for the timer' }), 'Cool down!')
    await user.type(within(dlg).getByRole('spinbutton', { name: 'e.g. 60' }), '60')
    await user.click(within(dlg).getByRole('button', { name: 'Add' }))
    const sent = apolloFinto.chiamata('AddWorkflowStep')!
    expect(sent).toEqual(expect.objectContaining({ definitionId: 'wf-1', label: 'Cool down!', type: 'timer_wait', timerDelayMinutes: 60 }))
    expect(sent['name']).toMatch(/^timer_wait_cool_down_[0-9a-z]+$/)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  // Review of 23 Sep 2026: a timed wait with no delay kept its tickets on the step for ever.
  it('a timer wait needs its delay: Add stays off until it is a whole number above zero', async () => {
    const { user } = toolbar()
    const dlg = await openAddStep(user)
    await user.click(within(dlg).getByRole('button', { name: /Timer wait/ }))
    await user.type(within(dlg).getByRole('textbox', { name: 'E.g. Waiting for the timer' }), '!!!')
    expect(within(dlg).getByRole('button', { name: 'Add' })).toBeDisabled()
    const delay = within(dlg).getByRole('spinbutton', { name: 'e.g. 60' })
    await user.type(delay, '0')
    expect(within(dlg).getByRole('button', { name: 'Add' })).toBeDisabled()
    await user.clear(delay)
    await user.type(delay, '90')
    await user.click(within(dlg).getByRole('button', { name: 'Add' }))
    expect(apolloFinto.chiamata('AddWorkflowStep')).toEqual(expect.objectContaining({ type: 'timer_wait', timerDelayMinutes: 90 }))
    expect(apolloFinto.chiamata('AddWorkflowStep')!['name']).toMatch(/^timer_wait__[0-9a-z]+$/)
  })

  it('a failed addition says why and keeps the dialog with what was typed', async () => {
    apolloFinto.esiti['AddWorkflowStep'] = { error: new Error('a step with this name already exists') }
    const { user, props } = toolbar()
    const dlg = await openAddStep(user)
    await user.type(within(dlg).getByRole('textbox', { name: 'E.g. Weekly CAB' }), 'Review')
    await user.click(within(dlg).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('a step with this name already exists'))
    expect(screen.getByRole('dialog', { name: 'Add a step' })).toBeInTheDocument()
    expect(within(dlg).getByRole('textbox', { name: 'E.g. Weekly CAB' })).toHaveValue('Review')
    expect(props.onRefetch).not.toHaveBeenCalled()
  })

  it('Cancel, the X and Escape close the dialog without adding anything', async () => {
    const { user } = toolbar()
    let dlg = await openAddStep(user)
    await user.type(within(dlg).getByRole('textbox', { name: 'E.g. Weekly CAB' }), 'Review')
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    dlg = await openAddStep(user)
    await user.click(within(dlg).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await openAddStep(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(apolloFinto.chiamate['AddWorkflowStep']).toBeUndefined()
  })
})
