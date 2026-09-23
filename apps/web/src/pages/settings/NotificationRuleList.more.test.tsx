/**
 * ONE ROW OF THE NOTIFICATION RULES: the two paths the main test file does
 * not walk.
 *
 * - The switch and the recipient, like the channels, are shown as PENDING
 *   until the server answers with them; then the row must follow the server
 *   again, otherwise it keeps showing what was clicked and hides a later
 *   change made elsewhere.
 * - Which fixed recipients exist is decided by the shared vocabulary
 *   (@opengraphity/types). A recipient added there without a label here must
 *   stop the page at load — never become a nameless option in the list,
 *   which is how `role:manager` once offered a rule that reached nobody.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RuleRow, type NotificationRule, type TargetOption } from './NotificationRuleList'

/** The options a row receives: each one says whether it applies to the rule's event. */
const TARGETS: (TargetOption & { applicable: boolean })[] = [
  { value: 'all', label: 'Everyone', applicable: true },
  { value: 'assignee', label: 'Assignee', applicable: true },
  { value: 'role:operator', label: 'Role: Operator', applicable: true },
]

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  id: 'r1', eventType: 'incident.assigned', enabled: true, severityOverride: 'info',
  titleKey: 'no.such.key', channels: ['in_app'], target: 'assignee', isSeed: true, ...over,
})

describe('RuleRow — the switch and the recipient while saving', () => {
  it('once the server answers with the switch and the recipient that were sent, the row follows the server again', async () => {
    const onUpdate = vi.fn()
    const ui = (r: NotificationRule) => (
      <table><tbody><RuleRow rule={r} routable={['in_app', 'email']} targets={TARGETS} onUpdate={onUpdate} onDelete={vi.fn()} /></tbody></table>
    )
    const { rerender } = render(ui(rule()))
    const user = userEvent.setup()
    const toggle = () => screen.getByRole('switch', { name: 'Enabled: incident.assigned' })
    const recipients = () => screen.getByRole('combobox', { name: 'Recipients' })

    await user.click(toggle())
    await user.selectOptions(recipients(), 'role:operator')
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('r1', { enabled: false, target: 'role:operator' }))

    // The refetch brings back exactly what was sent: the pending state is over…
    rerender(ui(rule({ enabled: false, target: 'role:operator' })))
    // …so a later change made elsewhere shows, instead of the old clicks.
    rerender(ui(rule({ enabled: true, target: 'all' })))
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    expect(recipients()).toHaveValue('all')
  })
})

describe('the fixed recipients', () => {
  afterEach(() => {
    vi.doUnmock('@opengraphity/types')
    vi.resetModules()
  })

  it('a recipient the vocabulary adds without a label here stops the page at load', async () => {
    vi.resetModules()
    vi.doMock('@opengraphity/types', async (importOriginal) => {
      const types = await importOriginal<typeof import('@opengraphity/types')>()
      return { ...types, NOTIFICATION_BASE_TARGETS: [...types.NOTIFICATION_BASE_TARGETS, 'watchers'] }
    })
    await expect(import('./NotificationRuleList')).rejects.toThrow('BASE_TARGET_LABEL_KEY: no label for recipient "watchers"')
  })
})
