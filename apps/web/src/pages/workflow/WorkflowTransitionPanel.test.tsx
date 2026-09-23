/**
 * THE TRANSITION PANEL of the workflow designer: what an arrow between two
 * steps does — its label, who follows it (trigger), whether it asks for an
 * input, its condition and its timer.
 *
 * What it edits is what the engine runs on every ticket that crosses that
 * arrow, so the behaviours pinned here are the ones whose regression changes
 * a live process without a word:
 *  - Save stays off while nothing changed, and a save carries EVERY field of
 *    the arrow (a field dropped on the way is reset on the server);
 *  - "requires input" asks for the field, and unticking it forgets the field;
 *  - a timer arrow asks for its hours and saves them as a number;
 *  - a condition on an arrow the SYSTEM travels (SLA breach, timer) warns
 *    that nobody will see it refused, while it is being chosen;
 *  - a manual arrow is a button on the ticket: without a label it is not
 *    saved, and the panel says why;
 *  - its ends cannot be dragged to other steps, and the panel says how to
 *    move it;
 *  - deleting an arrow asks first, and only a "yes" deletes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { WorkflowTransitionPanel } from './WorkflowTransitionPanel'
import type { WFTransition } from './workflow-types'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeEach(() => { toast.success.mockReset() })

const transition = (over: Partial<WFTransition> = {}): WFTransition => ({
  id: 't2', fromStepName: 'in_progress', toStepName: 'resolved', trigger: 'manual', label: 'Resolve',
  requiresInput: false, inputField: null, condition: null, timerHours: null, ...over,
})

function panel(tr: WFTransition = transition(), withDelete = true) {
  const onClose = vi.fn(); const onSaved = vi.fn(); const onSaveLocally = vi.fn(); const onDelete = vi.fn()
  const r = renderWithProviders(
    <WorkflowTransitionPanel transition={tr} onClose={onClose} onSaved={onSaved} onSaveLocally={onSaveLocally} onDelete={withDelete ? onDelete : undefined} />,
  )
  return { ...r, onClose, onSaved, onSaveLocally, onDelete }
}

const save = () => screen.getByRole('button', { name: 'Save' })
const trigger = () => screen.getByRole('combobox', { name: 'Trigger' })
const condition = () => screen.getByRole('combobox', { name: 'Condition (optional)' })
const SYSTEM_WARNING = /This edge is travelled by the system, not by a person/

describe('WorkflowTransitionPanel', () => {
  it('shows the arrow it edits with its current values; Save stays off until something changes', () => {
    panel()
    expect(screen.getByText('Edit the transition')).toBeInTheDocument()
    expect(screen.getByText('in_progress').parentElement).toHaveTextContent('in_progress → resolved')
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Resolve')
    expect(trigger()).toHaveValue('manual')
    expect(within(trigger()).getAllByRole('option').map((o) => o.textContent)).toEqual(['manual', 'automatic', 'timer', 'sla_breach'])
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(condition()).toHaveValue('')
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(save()).toBeDisabled()
  })

  it('offers only the conditions the engine can evaluate, by their meaning', () => {
    panel()
    expect(within(condition()).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '— No condition —', 'A change is linked', 'All assessments and the release plan complete',
      'All deployments and validations complete', 'All reviews confirmed', 'All tasks of the step completed',
      'Root cause is filled in',
    ])
  })

  it('a save carries every field of the arrow, tells the designer, and says it is saved locally', async () => {
    const { user, onSaveLocally, onSaved } = panel()
    const label = screen.getByRole('textbox', { name: 'Label' })
    await user.clear(label)
    await user.type(label, 'Resolve ticket')
    await user.selectOptions(trigger(), 'automatic')
    await user.selectOptions(condition(), 'All tasks of the step completed')
    expect(save()).toBeEnabled()
    await user.click(save())
    expect(onSaveLocally).toHaveBeenCalledWith({
      transitionId: 't2', label: 'Resolve ticket', trigger: 'automatic', requiresInput: false,
      inputField: null, condition: 'all_tasks_complete', timerHours: null,
    })
    expect(onSaved).toHaveBeenCalledWith({
      label: 'Resolve ticket', trigger: 'automatic', requiresInput: false, inputField: null, condition: 'all_tasks_complete', timerHours: null,
    })
    expect(toast.success).toHaveBeenCalledWith('Change saved locally')
  })

  it('a change undone by hand leaves Save off', async () => {
    const { user } = panel()
    await user.selectOptions(trigger(), 'automatic')
    expect(save()).toBeEnabled()
    await user.selectOptions(trigger(), 'manual')
    expect(save()).toBeDisabled()
  })

  it('requiring an input asks which field; unticking it forgets the field', async () => {
    const { user, onSaveLocally } = panel()
    expect(screen.queryByRole('combobox', { name: 'Input field' })).toBeNull()
    await user.click(screen.getByRole('checkbox'))
    const field = screen.getByRole('combobox', { name: 'Input field' })
    expect(within(field).getAllByRole('option').map((o) => o.textContent)).toEqual(['— none —', 'rootCause', 'notes'])
    await user.selectOptions(field, 'rootCause')
    await user.click(screen.getByRole('checkbox'))
    expect(screen.queryByRole('combobox', { name: 'Input field' })).toBeNull()
    await user.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('combobox', { name: 'Input field' })).toHaveValue('')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Input field' }), 'notes')
    await user.click(save())
    expect(onSaveLocally).toHaveBeenCalledWith(expect.objectContaining({ requiresInput: true, inputField: 'notes' }))
  })

  it('an arrow that already requires an input opens with its field', () => {
    panel(transition({ requiresInput: true, inputField: 'rootCause' }))
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Input field' })).toHaveValue('rootCause')
    expect(save()).toBeDisabled()
  })

  it('a timer arrow asks for its hours, saved as a number', async () => {
    const { user, onSaveLocally } = panel()
    await user.selectOptions(trigger(), 'timer')
    const hours = screen.getByRole('spinbutton', { name: 'Timer (hours)' })
    await user.type(hours, '72')
    await user.click(save())
    expect(onSaveLocally).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'timer', timerHours: 72 }))
  })

  it('a saved timer arrow opens with its hours, and changing them enables Save', async () => {
    const { user } = panel(transition({ trigger: 'timer', timerHours: 72, label: 'Auto-close' }))
    const hours = screen.getByRole('spinbutton', { name: 'Timer (hours)' })
    expect(hours).toHaveValue(72)
    expect(save()).toBeDisabled()
    await user.clear(hours)
    await user.type(hours, '48')
    expect(save()).toBeEnabled()
  })

  it('a condition on an arrow the system travels warns that nobody will see it refused', async () => {
    const { user } = panel()
    await user.selectOptions(condition(), 'A change is linked')
    // A person follows a manual arrow: the refusal is seen.
    expect(screen.queryByText(SYSTEM_WARNING)).toBeNull()
    await user.selectOptions(trigger(), 'sla_breach')
    expect(screen.getByText(SYSTEM_WARNING)).toBeInTheDocument()
    await user.selectOptions(trigger(), 'timer')
    expect(screen.getByText(SYSTEM_WARNING)).toBeInTheDocument()
    await user.selectOptions(condition(), '— No condition —')
    expect(screen.queryByText(SYSTEM_WARNING)).toBeNull()
  })

  it('a manual arrow is not saved without a label, and says why; an arrow the system travels may have none', async () => {
    const { user, onSaveLocally } = panel()
    const NEEDS_LABEL = 'A manual arrow needs a label: it is the text of the button people click on the ticket.'
    const label = screen.getByRole('textbox', { name: 'Label' })
    await user.clear(label)
    await user.type(label, '  ')
    expect(screen.getByText(NEEDS_LABEL)).toBeInTheDocument()
    expect(save()).toBeDisabled()
    await user.selectOptions(trigger(), 'timer')
    expect(screen.queryByText(NEEDS_LABEL)).toBeNull()
    expect(save()).toBeEnabled()
    await user.selectOptions(trigger(), 'manual')
    expect(save()).toBeDisabled()
    await user.clear(label)
    await user.type(label, 'Resolve now')
    await user.click(save())
    expect(onSaveLocally).toHaveBeenCalledWith(expect.objectContaining({ label: 'Resolve now', trigger: 'manual' }))
  })

  it('an arrow just drawn, still without a label, opens asking for one', () => {
    panel(transition({ label: '' }))
    expect(screen.getByText(/A manual arrow needs a label/)).toBeInTheDocument()
    expect(save()).toBeDisabled()
  })

  it('says how to move the arrow to other steps, since its ends cannot be dragged', () => {
    panel()
    expect(screen.getByText('To move this arrow to other steps, delete it and draw a new one between the right steps.')).toBeInTheDocument()
  })

  it('deleting asks first; "Cancel" keeps the arrow, "Delete" deletes it', async () => {
    const { user, onDelete } = panel()
    await user.click(screen.getByRole('button', { name: 'Delete transition' }))
    const confirm = screen.getByRole('dialog', { name: 'Delete the transition in_progress → resolved?' })
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(onDelete).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Delete transition' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith('t2')
  })

  it('without a delete action there is no delete button; the X closes the panel', async () => {
    const { user, onClose } = panel(transition(), false)
    expect(screen.queryByRole('button', { name: 'Delete transition' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: two words were written in
   * Italian in the code, outside the translations — the "requires input"
   * switch said «Sì» / «No» and the timer hours field «ore» — so an English
   * page showed them in Italian.
   */
  it('speaks the language of the page: no Italian words on an English page', async () => {
    const { user } = panel(transition({ trigger: 'timer' }))
    expect(screen.getByText('No')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox'))
    expect(screen.queryByText('Sì')).toBeNull()
    expect(screen.getByText('Yes')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Timer (hours)' })).toHaveAttribute('placeholder', 'e.g. 72')
  })
})
