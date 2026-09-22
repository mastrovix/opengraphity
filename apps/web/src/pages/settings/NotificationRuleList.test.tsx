/**
 * ONE ROW OF THE NOTIFICATION RULES, and the helpers that decide its choices.
 *
 * What breaks for an administrator if these regress:
 *  - the row saves with a 500 ms debounce, and the pending changes must
 *    ACCUMULATE: ticking Slack and then Email quickly used to send only Email,
 *    and Slack flipped back off after the refetch (G-6);
 *  - the pending state must end once the server's answer arrives, otherwise
 *    the row keeps showing what was typed and hides a later server change;
 *  - a channel or a recipient saved earlier but no longer valid stays VISIBLE
 *    with a warning, so it can be removed instead of silently failing;
 *  - a rule whose event nothing produces is flagged, since it will never fire;
 *  - only custom rules can be deleted: a seeded rule is part of the product.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RuleRow, routableFor, targetsFor, targetOptionsFor, withCurrent,
  type NotificationRule, type NotificationRouting, type TargetOption,
} from './NotificationRuleList'

const ROUTING: NotificationRouting = {
  defaultChannels: ['in_app', 'email'],
  byEventType: [{ eventType: 'incident.created', channels: ['in_app', 'slack', 'teams', 'email'] }],
  defaultTargets: ['all', 'assignee', 'team_owner'],
  targetsByEventType: [{ eventType: 'incident.created', targets: ['all'] }],
}

const ALL_TARGETS: TargetOption[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'team_owner', label: 'Assigned team' },
  { value: 'role:operator', label: 'Role: Operator' },
]

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  id: 'r1', eventType: 'incident.assigned', enabled: true, severityOverride: 'info',
  titleKey: 'no.such.key', channels: ['in_app'], target: 'assignee', isSeed: true, ...over,
})

const applicable = (o: TargetOption) => ({ ...o, applicable: true })

function renderRow(r: NotificationRule, props: Partial<Parameters<typeof RuleRow>[0]> = {}) {
  const onUpdate = vi.fn()
  const onDelete = vi.fn()
  const ui = (x: NotificationRule) => (
    <table><tbody>
      <RuleRow rule={x} routable={['in_app', 'slack', 'email']} targets={ALL_TARGETS.map(applicable)}
        onUpdate={onUpdate} onDelete={onDelete} {...props} />
    </tbody></table>
  )
  const utils = render(ui(r))
  return { ...utils, onUpdate, onDelete, rerenderRule: (x: NotificationRule) => utils.rerender(ui(x)) }
}

const checkbox = (label: string) => screen.getByRole('checkbox', { name: label })

describe('routing helpers', () => {
  it('an event with its own entry uses it; any other falls back to the defaults', () => {
    expect(routableFor(ROUTING, 'incident.created')).toEqual(['in_app', 'slack', 'teams', 'email'])
    expect(routableFor(ROUTING, 'sla.breached')).toEqual(['in_app', 'email'])
    expect(targetsFor(ROUTING, 'incident.created')).toEqual(['all'])
    expect(targetsFor(ROUTING, 'sla.breached')).toEqual(['all', 'assignee', 'team_owner'])
  })

  it('withCurrent adds a saved value that is not among the options, and only then', () => {
    expect(withCurrent(ALL_TARGETS, null)).toEqual(ALL_TARGETS)
    expect(withCurrent(ALL_TARGETS, 'all')).toEqual(ALL_TARGETS)
    // A role while the roles are still loading: named as a role, not as a raw key.
    expect(withCurrent(ALL_TARGETS, 'role:auditor').at(-1)).toEqual({ value: 'role:auditor', label: 'Role: auditor' })
    expect(withCurrent(ALL_TARGETS, 'legacy_target').at(-1)).toEqual({ value: 'legacy_target', label: 'legacy_target' })
  })

  it('at the birth of a ticket only the applicable recipients are offered, plus roles', () => {
    const opts = targetOptionsFor(ROUTING, 'incident.created', 'all', ALL_TARGETS)
    // «assignee» and «team» do not exist yet when the ticket is created: offering them
    // would offer a rule that never delivers anything.
    expect(opts.map((o) => o.value)).toEqual(['all', 'role:operator'])
    expect(opts.every((o) => o.applicable)).toBe(true)
  })

  it('a saved recipient no longer applicable is kept first, marked, so it can be changed', () => {
    const opts = targetOptionsFor(ROUTING, 'incident.created', 'assignee', ALL_TARGETS)
    expect(opts[0]).toEqual({ value: 'assignee', label: 'Assignee', applicable: false })
    expect(opts.slice(1).map((o) => o.value)).toEqual(['all', 'role:operator'])
  })

  it('a saved role not yet among the loaded roles is still offered', () => {
    const opts = targetOptionsFor(ROUTING, 'incident.created', 'role:auditor', ALL_TARGETS)
    expect(opts.map((o) => o.value)).toContain('role:auditor')
  })
})

describe('RuleRow — what the row shows', () => {
  it('a title key with no translation falls back to the event type; a seeded rule cannot be deleted', () => {
    renderRow(rule())
    expect(screen.getAllByText('incident.assigned')).toHaveLength(2)
    expect(screen.getByTitle('System rule')).toBeInTheDocument()
    expect(screen.queryByTitle('Delete rule')).not.toBeInTheDocument()
  })

  it('a custom rule can be deleted, and the bin lights up on hover', async () => {
    const { onDelete } = renderRow(rule({ isSeed: false }))
    expect(screen.getByTitle('Custom rule')).toBeInTheDocument()
    const bin = screen.getByTitle('Delete rule')
    fireEvent.mouseEnter(bin)
    expect(bin.style.color).toBe('var(--color-danger)')
    fireEvent.mouseLeave(bin)
    expect(bin.style.color).toBe('var(--color-slate-light)')
    await userEvent.setup().click(bin)
    expect(onDelete).toHaveBeenCalledWith('r1')
  })

  it('a rule whose event is never produced carries the warning', () => {
    renderRow(rule({ eventProduced: false }))
    expect(screen.getByLabelText(/Nothing produces the event “incident.assigned”/)).toBeInTheDocument()
  })

  it('a step rule shows its narrowing by purpose, or by category', () => {
    const { rerenderRule } = renderRow(rule({ eventType: 'incident.step_entered', stepPurpose: 'triage' }))
    expect(screen.getByText('Only steps with purpose: Intake and triage')).toBeInTheDocument()
    rerenderRule(rule({ eventType: 'incident.step_entered', stepCategory: 'waiting' }))
    expect(screen.getByText('Only steps in category: waiting')).toBeInTheDocument()
  })

  it('a saved channel the dispatcher cannot deliver stays visible, ticked and flagged', () => {
    renderRow(rule({ channels: ['in_app', 'sms'] }))
    const sms = screen.getByRole('checkbox', { name: /^sms/ })
    expect(sms).toBeChecked()
    expect(screen.getByLabelText(/no format for sms/)).toBeInTheDocument()
    // The known channels are translated.
    expect(checkbox('Slack')).not.toBeChecked()
  })

  it('a recipient that no longer applies is labelled as such in the list', () => {
    renderRow(rule({ target: 'assignee' }), { targets: [{ value: 'assignee', label: 'Assignee', applicable: false }, applicable(ALL_TARGETS[0]!)] })
    expect(screen.getByRole('option', { name: 'Assignee — not applicable to this event' })).toBeInTheDocument()
  })
})

describe('RuleRow — saving', () => {
  it('two channels ticked in a row are sent TOGETHER, once, after the debounce', async () => {
    const user = userEvent.setup()
    const { onUpdate } = renderRow(rule())
    await user.click(checkbox('Slack'))
    await user.click(checkbox('Email'))
    // The row already shows both while the change is pending.
    expect(checkbox('Slack')).toBeChecked()
    expect(checkbox('Email')).toBeChecked()
    expect(onUpdate).not.toHaveBeenCalled()
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(onUpdate).toHaveBeenCalledWith('r1', { channels: ['in_app', 'slack', 'email'] })
  })

  it('switch, severity and recipient changes accumulate into one update', async () => {
    const user = userEvent.setup()
    const { onUpdate } = renderRow(rule())
    await user.click(screen.getByRole('switch', { name: 'Enabled: incident.assigned' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Severity' }), 'error')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Recipients' }), 'role:operator')
    await user.click(checkbox('In app'))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(onUpdate).toHaveBeenCalledWith('r1', { enabled: false, severityOverride: 'error', target: 'role:operator', channels: [] })
  })

  it('once the server answers with what was sent, the row follows the server again', async () => {
    const user = userEvent.setup()
    const { onUpdate, rerenderRule } = renderRow(rule())
    await user.click(checkbox('Slack'))
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    // The refetch brings the saved rule (order of channels is not a promise).
    rerenderRule(rule({ channels: ['slack', 'in_app'] }))
    // A later change made elsewhere must show: if the pending state had not
    // been dropped, the row would keep displaying the old pending channels.
    rerenderRule(rule({ channels: ['email'] }))
    expect(checkbox('Email')).toBeChecked()
    expect(checkbox('Slack')).not.toBeChecked()
  })

  it('an answer that does not match yet keeps the pending state on screen', async () => {
    const user = userEvent.setup()
    const { onUpdate, rerenderRule } = renderRow(rule())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Severity' }), 'warning')
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    rerenderRule(rule({ enabled: true, severityOverride: 'info' }))
    expect(screen.getByRole('combobox', { name: 'Severity' })).toHaveValue('warning')
    rerenderRule(rule({ severityOverride: 'warning' }))
    rerenderRule(rule({ severityOverride: 'success' }))
    expect(screen.getByRole('combobox', { name: 'Severity' })).toHaveValue('success')
  })
})
