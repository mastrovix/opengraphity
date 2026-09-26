/**
 * The "New rule" dialog is where an admin decides who gets told what. What a
 * user loses if these behaviours regress:
 * - a custom event type is sent untrimmed, or the dialog lets a rule be saved
 *   with no deliverable channel: the rule is stored and never fires;
 * - a channel ticked for a previous event type, and not deliverable for the
 *   new one, is sent anyway and the server rejects the whole rule;
 * - step narrowing (purpose OR category, never both) is offered on types that
 *   cannot use it, or both are sent and the server refuses the rule;
 * - escalation and digest settings are lost on save.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/test/utils'

vi.mock('./NotificationRuleList', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./NotificationRuleList')>()),
  // The role list comes from a query; the dialog only needs a stable set of targets.
  useTargetOptions: () => [{ value: 'all', label: 'Everyone' }, { value: 'assignee', label: 'Assignee' }],
}))

import { NewRuleDialog, type WorkflowEventType } from './NotificationRuleForm'
import type { NotificationRouting } from './NotificationRuleList'

const routing: NotificationRouting = {
  defaultChannels: ['in_app', 'email'],
  byEventType: [{ eventType: 'sla.warning', channels: ['in_app', 'slack', 'webhook_x'] }, { eventType: 'digest.daily', channels: ['email'] }],
  defaultTargets: ['all'], targetsByEventType: [],
}

const wf = (over: Partial<WorkflowEventType>): WorkflowEventType => ({
  eventType: 'x', entityType: 'incident', stepName: null, stepLabel: null, stepPurpose: null, stepCategory: null, stable: false, ...over,
})

const WORKFLOW_TYPES = [
  wf({ eventType: 'incident.step_entered', stable: true, stepCategory: 'work' }),
  wf({ eventType: 'change.step_entered', stable: true, stepCategory: 'approval' }),
  wf({ eventType: 'incident.step.triage_desk', stepLabel: 'Triage desk', stepCategory: 'work' }),
  wf({ eventType: 'incident.step.raw' }),
]

/** The field controls are wrapped in their <label>; find them by the caption span. */
const field = (caption: string) => screen.getByText(caption, { selector: 'span' }).closest('label')!.querySelector('select, input') as HTMLElement

function setup(saving = false) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  const r = renderWithProviders(<NewRuleDialog routing={routing} workflowEventTypes={WORKFLOW_TYPES} onSave={onSave} onClose={onClose} saving={saving} />)
  return { ...r, onSave, onClose, save: () => screen.getByRole('button', { name: 'Save' }) }
}

describe('NewRuleDialog — event types', () => {
  it('offers the tenant workflow types that are not standard, with their step label', () => {
    setup()
    expect(screen.getByRole('option', { name: 'incident.step.triage_desk — Triage desk' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'incident.step.raw' })).toBeInTheDocument()
    // A stable standard type is listed once, in the standard group.
    expect(screen.getAllByRole('option', { name: 'incident.step_entered' })).toHaveLength(1)
  })

  it('a custom event type is typed by hand and saved trimmed', async () => {
    const { onSave, save } = setup()
    await userEvent.selectOptions(field('Event type'), '__custom__')
    await userEvent.type(field('Event type (custom)'), '  my.event  ')
    await userEvent.type(field('Notification title'), '  notification.my.title ')
    await userEvent.click(save())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'my.event', titleKey: 'notification.my.title', severityOverride: 'info', channels: ['in_app'], target: 'all', enabled: true,
      stepPurpose: undefined, stepCategory: undefined, escalationDelayMinutes: undefined, escalationMessage: undefined, digestTime: undefined,
    }))
  })

  it('cannot save without an event type or a title', async () => {
    const { save } = setup()
    expect(save()).toBeDisabled()
    await userEvent.type(field('Notification title'), 'x')
    expect(save()).toBeDisabled()
  })
})

describe('NewRuleDialog — channels', () => {
  it('offers only the deliverable channels of the chosen type and drops a ticked one that is no longer deliverable', async () => {
    const { onSave, save } = setup()
    // Email is deliverable by default and gets ticked...
    await userEvent.click(screen.getByRole('checkbox', { name: 'Email' }))
    // ...but not for an SLA warning: it must not be sent with the rule.
    await userEvent.selectOptions(field('Event type'), 'sla.warning')
    expect(screen.queryByRole('checkbox', { name: 'Email' })).toBeNull()
    // An unknown channel is shown by its raw name.
    expect(screen.getByText('webhook_x')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /Slack/ }))
    await userEvent.type(field('Notification title'), 't')
    await userEvent.selectOptions(field('Severity'), 'error')
    await userEvent.selectOptions(field('Recipients'), 'assignee')
    await userEvent.click(save())
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ channels: ['in_app', 'slack'], severityOverride: 'error', target: 'assignee' }))
  })

  it('with no deliverable channel ticked the rule cannot be saved', async () => {
    const { save } = setup()
    await userEvent.type(field('Notification title'), 't')
    await userEvent.selectOptions(field('Event type'), 'incident.created')
    expect(save()).toBeEnabled()
    // Unticking the only channel leaves a rule that would never deliver.
    await userEvent.click(screen.getByRole('checkbox', { name: /In-app|In app/i }))
    expect(save()).toBeDisabled()
  })
})

describe('NewRuleDialog — step narrowing', () => {
  it('is offered only on a stable step-entered type, and purpose excludes category', async () => {
    const { onSave, save } = setup()
    expect(screen.queryByText('Only steps with purpose')).toBeNull()
    await userEvent.selectOptions(field('Event type'), 'incident.step_entered')
    await userEvent.type(field('Notification title'), 't')

    // Categories come from the tenant's own steps, de-duplicated and sorted.
    const category = field('Only steps in category')
    expect([...category.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['— Any step —', 'approval', 'work'])
    await userEvent.selectOptions(category, 'work')
    await userEvent.click(save())
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ stepPurpose: undefined, stepCategory: 'work' }))

    // Choosing a purpose hides and clears the category: the server accepts only one of the two.
    await userEvent.selectOptions(field('Only steps with purpose'), 'triage')
    expect(screen.queryByText('Only steps in category')).toBeNull()
    await userEvent.click(save())
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ stepPurpose: 'triage', stepCategory: undefined }))

    // Back to "any": the category is offered again, empty.
    await userEvent.selectOptions(field('Only steps with purpose'), '')
    expect(field('Only steps in category')).toHaveValue('')
  })
})

describe('NewRuleDialog — escalation and digest settings', () => {
  it('escalation sends the delay as a number and the message', async () => {
    const { onSave, save } = setup()
    await userEvent.selectOptions(field('Event type'), 'incident.escalation')
    await userEvent.type(field('Notification title'), 't')
    await userEvent.click(save())
    // No delay typed: nothing is sent, the server keeps its default.
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ escalationDelayMinutes: undefined, escalationMessage: undefined }))
    await userEvent.type(field('Escalation delay (minutes)'), '45')
    await userEvent.type(field('Escalation message'), 'Still open')
    await userEvent.click(save())
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: 'incident.escalation', escalationDelayMinutes: 45, escalationMessage: 'Still open' }))
  })

  it('digest sends the chosen time', async () => {
    const { onSave, save } = setup()
    await userEvent.selectOptions(field('Event type'), 'digest.daily')
    await userEvent.type(field('Notification title'), 't')
    // in_app is not deliverable for the digest: email must be ticked.
    await userEvent.click(screen.getByRole('checkbox', { name: /Email/i }))
    fireEvent.change(field('Digest time (HH:MM)'), { target: { value: '07:30' } })
    await userEvent.click(save())
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ channels: ['email'], digestTime: '07:30' }))
    fireEvent.change(field('Digest time (HH:MM)'), { target: { value: '' } })
    await userEvent.click(save())
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ digestTime: undefined }))
  })
})

describe('NewRuleDialog — closing and saving state', () => {
  it('closes from the X, from Cancel and from the backdrop, but not from a click inside the panel', async () => {
    const { onClose } = setup()
    await userEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // The backdrop: the app's Modal lives in a portal, around the dialog.
    await userEvent.click(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('while saving, the save button is disabled and shows progress', () => {
    setup(true)
    expect(screen.getByRole('button', { name: '…' })).toBeDisabled()
  })
})
